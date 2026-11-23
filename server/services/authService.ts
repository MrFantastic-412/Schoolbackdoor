import crypto from 'node:crypto';
import { db, runInTransaction } from '../db/database';
import { AuthenticatedUser, parseTimestampMs } from '../middleware/auth';
import { generateBase32Secret, computeTotpCode, verifyTotpToken } from '../utils/totp';
import { fileService, PROTECTION_MODE_MAX_UPLOAD_BYTES } from './fileService';
import { deletionService } from './deletionService';
import {
  hashPassword,
  verifyPassword,
  needsPasswordRehash,
  hashSessionToken,
  validateStrongPassword,
  sanitizeInputText,
  generateNumericOtp,
  checkRateLimit,
  recordRateLimitEvent,
  CURRENT_TERMS_VERSION,
  SESSION_POLICY,
  parseDeviceFromUserAgent,
  recordSecurityEvent,
} from '../utils/security';

export { hashPassword, verifyPassword };

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes base window
const ESCALATION_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours escalation counter
const MAX_FAILED_ATTEMPTS = 5;
const MAX_REGISTER_ATTEMPTS_PER_HOUR = 10;
const MAX_RECOVERY_ATTEMPTS_PER_HOUR = 6;
const MAX_RESET_FAILURES = 5;
const SCRYPT_EQUALIZER_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export class AuthRateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 900) {
    super(message);
    this.name = 'AuthRateLimitError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export interface RegisterInput {
  identifier?: string; // Gmail address (or email field)
  email?: string;      // Gmail address
  username: string;    // must start with @ and follow alphanumeric/underscore rules
  password: string;
  name?: string;
  department?: string;
  level?: string;
  hall_of_residence?: string;
  matric_number?: string;
  avatarDataUrl?: string;
  avatarThumbnailDataUrl?: string;
  avatarUrl?: string;
  acceptTerms?: boolean;
  userAgent?: string;
}

function insertSecurityNotification(userId: string, title: string, body: string, link = '/?tab=settings') {
  try {
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link)
      VALUES (?, ?, 'system', ?, ?, ?)
    `).run(
      `notif-sec-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      userId,
      title,
      body,
      link
    );
  } catch {
    // Non-fatal alert
  }
}

export const authService = {
  /**
   * Validates username ensuring it complies with the required symbol (@) and formatting rules
   */
  validateUsername(rawUsername: string): { valid: boolean; normalized: string; error?: string } {
    let username = String(rawUsername || '').trim();
    if (!username) {
      return { valid: false, normalized: '', error: 'Username is required.' };
    }

    if (!username.startsWith('@')) {
      username = `@${username}`;
    }

    if (username.length < 3 || username.length > 25) {
      return { valid: false, normalized: '', error: 'Username must be between 3 and 25 characters (including @).' };
    }

    const validRegex = /^@[a-zA-Z0-9_]+$/;
    if (!validRegex.test(username)) {
      return { valid: false, normalized: '', error: 'Username must start with @ and contain only letters, numbers, and underscores.' };
    }

    const reserved = [
      '@admin',
      '@thebackdoor',
      '@schoolbackdoor',
      '@system',
      '@root',
      '@backdoor',
      '@moderator',
      '@futa',
      '@official',
      '@anonymous',
    ];
    if (reserved.includes(username.toLowerCase())) {
      return { valid: false, normalized: '', error: 'This username is reserved.' };
    }

    return { valid: true, normalized: username };
  },

  /**
   * Validates a Gmail address cleanly (case-insensitive normalization)
   */
  validateGmail(rawEmail: string): { valid: boolean; normalized: string; error?: string } {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!email) {
      return { valid: false, normalized: '', error: 'A valid Gmail address is required.' };
    }
    const localPart = email.split('@')[0] || '';
    if (
      email.length > 254 ||
      localPart.startsWith('.') ||
      localPart.endsWith('.') ||
      localPart.includes('..') ||
      !/^[a-z0-9._%+-]+@gmail\.com$/.test(email)
    ) {
      return {
        valid: false,
        normalized: '',
        error: 'Please provide a valid Gmail address (e.g. yourname@gmail.com).',
      };
    }
    return { valid: true, normalized: email };
  },

  /**
   * Escalating temporary cooldown rate limiter (per identifier and per IP, never permanent lockout).
   * Base threshold: 5 failures in 15 min -> 15 min cooldown; repeated bursts escalate to 30m -> 60m -> 180m cap.
   */
  getLoginRateLimitStatus(identifier: string, ipAddress?: string): {
    allowed: boolean;
    retryAfterSeconds: number;
    failureCount24h: number;
  } {
    const shortWindowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    const escalationWindowStart = new Date(Date.now() - ESCALATION_LOOKBACK_MS).toISOString().replace('T', ' ').slice(0, 19);

    const idShort = db
      .prepare(`
        SELECT COUNT(*) as failed_count, MIN(attempted_at) as oldest_at, MAX(attempted_at) as latest_at
        FROM login_attempts
        WHERE LOWER(identifier) = LOWER(?)
          AND success = 0
          AND datetime(attempted_at) >= datetime(?)
      `)
      .get(identifier, shortWindowStart) as { failed_count: number; oldest_at: string | null; latest_at: string | null } | undefined;

    const ipShort = ipAddress
      ? (db
          .prepare(`
            SELECT COUNT(*) as failed_count, MIN(attempted_at) as oldest_at, MAX(attempted_at) as latest_at
            FROM login_attempts
            WHERE ip_address = ?
              AND success = 0
              AND datetime(attempted_at) >= datetime(?)
          `)
          .get(ipAddress, shortWindowStart) as { failed_count: number; oldest_at: string | null; latest_at: string | null } | undefined)
      : undefined;

    const idLong = db
      .prepare(`
        SELECT COUNT(*) as failed_count, MAX(attempted_at) as latest_at
        FROM login_attempts
        WHERE LOWER(identifier) = LOWER(?)
          AND success = 0
          AND datetime(attempted_at) >= datetime(?)
          AND attempted_at > COALESCE((
            SELECT MAX(attempted_at) FROM login_attempts
            WHERE LOWER(identifier) = LOWER(?) AND success = 1
          ), '1970-01-01')
      `)
      .get(identifier, escalationWindowStart, identifier) as { failed_count: number; latest_at: string | null } | undefined;

    const ipLongCount = ipAddress
      ? ((db
          .prepare(`
            SELECT COUNT(*) as failed_count
            FROM login_attempts
            WHERE ip_address = ?
              AND success = 0
              AND datetime(attempted_at) >= datetime(?)
              AND attempted_at > COALESCE((
                SELECT MAX(attempted_at) FROM login_attempts
                WHERE ip_address = ? AND success = 1
              ), '1970-01-01')
          `)
          .get(ipAddress, escalationWindowStart, ipAddress) as { failed_count: number } | undefined)?.failed_count ?? 0)
      : 0;

    const failureCount24h = Math.max(idLong?.failed_count ?? 0, ipLongCount);
    const idShortBlocked = (idShort?.failed_count ?? 0) >= MAX_FAILED_ATTEMPTS;
    const ipShortBlocked = (ipShort?.failed_count ?? 0) >= MAX_FAILED_ATTEMPTS;

    // Escalated cooldown schedule (capped at 180 minutes, never permanent)
    let cooldownMs = RATE_LIMIT_WINDOW_MS;
    if (failureCount24h >= 16) cooldownMs = 180 * 60 * 1000;
    else if (failureCount24h >= 12) cooldownMs = 60 * 60 * 1000;
    else if (failureCount24h >= 8) cooldownMs = 30 * 60 * 1000;

    // Check active escalated cooldown based on latest failed attempt when >= 8 failures occurred
    if (failureCount24h >= 8) {
      const latestRef = idLong?.latest_at || ipShort?.latest_at;
      const latestMs = parseTimestampMs(latestRef);
      if (Number.isFinite(latestMs) && latestMs + cooldownMs > Date.now()) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((latestMs + cooldownMs - Date.now()) / 1000)),
          failureCount24h,
        };
      }
    }

    if (!idShortBlocked && !ipShortBlocked) {
      return { allowed: true, retryAfterSeconds: 0, failureCount24h };
    }

    const refAt = idShortBlocked ? idShort?.oldest_at : ipShort?.oldest_at;
    const parsedMs = parseTimestampMs(refAt);
    const retryAfterSeconds = Number.isFinite(parsedMs) && parsedMs > 0
      ? Math.max(1, Math.ceil((parsedMs + cooldownMs - Date.now()) / 1000))
      : Math.ceil(cooldownMs / 1000);

    return { allowed: false, retryAfterSeconds, failureCount24h };
  },

  checkLoginRateLimit(identifier: string, ipAddress?: string): boolean {
    return this.getLoginRateLimitStatus(identifier, ipAddress).allowed;
  },

  recordLoginAttempt(identifier: string, success: boolean, ipAddress?: string) {
    db.prepare(`
      INSERT INTO login_attempts (id, identifier, ip_address, success)
      VALUES (?, ?, ?, ?)
    `).run(`att-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`, identifier, ipAddress || null, success ? 1 : 0);
  },

  /**
   * Register a new account using a unique @username and valid Gmail address
   */
  register(input: RegisterInput, ipAddress?: string, bypassRegistrationLock = false) {
    if (!bypassRegistrationLock) {
      if (!checkRateLimit(`reg:${ipAddress || 'unknown'}`, MAX_REGISTER_ATTEMPTS_PER_HOUR, 60 * 60 * 1000, ipAddress)) {
        throw new AuthRateLimitError('Too many registration attempts. Please wait before creating another account.', 3600);
      }
      try {
        const regSetting = db
          .prepare("SELECT value FROM website_settings WHERE key = 'allow_new_registrations'")
          .get() as { value?: string } | undefined;
        if (regSetting?.value === 'false') {
          throw new Error('New registrations are temporarily paused by administration.');
        }
      } catch (err: any) {
        if (err?.message?.includes('paused by')) {
          throw err;
        }
      }
    }

    const { password } = input;
    const rawEmailInput = input.email ?? input.identifier ?? '';

    const usernameValidation = this.validateUsername(input.username);
    if (!usernameValidation.valid) {
      throw new Error(usernameValidation.error || 'Invalid username.');
    }
    const normalizedUsername = usernameValidation.normalized;

    const gmailValidation = this.validateGmail(rawEmailInput);
    if (!gmailValidation.valid) {
      throw new Error(gmailValidation.error || 'Please provide a valid Gmail address (e.g. yourname@gmail.com).');
    }
    const email = gmailValidation.normalized;

    const pwdCheck = validateStrongPassword(password, [normalizedUsername, email.split('@')[0]]);
    if (!pwdCheck.valid) {
      throw new Error(pwdCheck.error || 'Password does not meet security requirements.');
    }

    const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (existingEmail) {
      throw new Error('An account with this Gmail address already exists.');
    }

    const existingHandle = db
      .prepare('SELECT id FROM user_profiles WHERE LOWER(handle) = LOWER(?)')
      .get(normalizedUsername);
    const existingUserHandle = db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)')
      .get(normalizedUsername);
    if (existingHandle || existingUserHandle) {
      throw new Error('This username is already taken. Please choose another.');
    }

    if (!bypassRegistrationLock) {
      recordRateLimitEvent(`reg:${ipAddress || 'unknown'}`, false, ipAddress);
    }

    const acceptedTermsAt = input.acceptTerms ? new Date().toISOString() : null;
    const acceptedTermsVersion = input.acceptTerms ? CURRENT_TERMS_VERSION : null;

    const userId = `u-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const rawAvatarInput = (input.avatarDataUrl || input.avatarUrl || '').trim();
    let savedAvatar: { avatarUrl: string; avatarThumbUrl: string } | null = null;
    if (rawAvatarInput) {
      const protectionActive = deletionService.isStorageProtectionActive().active;
      savedAvatar = fileService.saveAvatarImages(rawAvatarInput, userId, input.avatarThumbnailDataUrl, {
        maxBytesOverride: protectionActive ? PROTECTION_MODE_MAX_UPLOAD_BYTES : undefined,
      });
    }

    try {
      return runInTransaction(() => {
        const passwordHash = hashPassword(password);
        const verificationCode = generateNumericOtp(6);
        const matricNumber =
          sanitizeInputText(input.matric_number, 40) || `MEMBER-${new Date().getFullYear()}-${crypto.randomInt(1000, 10000)}`;

        db.prepare(`
          INSERT INTO users (
            id, matric_number, email, phone_number, username, password_hash,
            role, status, is_verified, verification_code, accepted_terms_at, accepted_terms_version, last_reauthenticated_at
          ) VALUES (?, ?, ?, NULL, ?, ?, 'student', 'active', 0, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          userId,
          matricNumber,
          email,
          normalizedUsername,
          passwordHash,
          verificationCode,
          acceptedTermsAt,
          acceptedTermsVersion
        );

        const name = sanitizeInputText(input.name, 60) || normalizedUsername.replace('@', '');
        const initials = name
          .split(/\s+/)
          .map((p) => p[0])
          .slice(0, 2)
          .join('')
          .toUpperCase() || 'SB';

        const department = sanitizeInputText(input.department, 80) || 'Student Community';
        const level = sanitizeInputText(input.level, 30) || 'Member';
        const hall = sanitizeInputText(input.hall_of_residence, 80) || 'Akure / Campus';
        const school = 'Independent Student Community';
        const bio = `On Schoolbackdoor (${normalizedUsername})`;

        db.prepare(`
          INSERT INTO user_profiles (
            id, user_id, name, handle, department, school, level, hall_of_residence,
            campus, bio, avatar_initials, avatar_bg, avatar_url, avatar_thumb_url, verified, is_private,
            allow_anonymous_posts, show_online_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Obanla', ?, ?, 'bg-stone-800 text-stone-100', ?, ?, 0, 0, 1, 1)
        `).run(
          `p-${userId}`,
          userId,
          name,
          normalizedUsername,
          department,
          school,
          level,
          hall,
          bio,
          initials,
          savedAvatar?.avatarUrl || null,
          savedAvatar?.avatarThumbUrl || null
        );

        const session = this.createSession(userId, ipAddress, input.userAgent);

        return {
          user: {
            id: userId,
            matric_number: matricNumber,
            email,
            phone_number: '',
            username: normalizedUsername,
            role: 'student',
            status: 'active',
            is_verified: false,
            acceptedTermsVersion,
            ...(process.env.NODE_ENV !== 'production' ? { verification_code: verificationCode } : {}),
          },
          profile: {
            id: `p-${userId}`,
            userId,
            name,
            handle: normalizedUsername,
            department,
            school,
            level,
            hallOfResidence: hall,
            campus: 'Obanla',
            bio,
            avatarInitials: initials,
            avatarBg: 'bg-stone-800 text-stone-100',
            avatarUrl: savedAvatar?.avatarUrl,
            avatarThumbUrl: savedAvatar?.avatarThumbUrl,
            verified: false,
            isPrivate: false,
            allowAnonymousPosts: true,
            showOnlineStatus: true,
            acceptedTermsVersion: acceptedTermsVersion || undefined,
            followersCount: 0,
            followingCount: 0,
            badges: ['Member'],
          },
          token: session.token,
          refreshToken: session.refreshToken,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
        };
      });
    } catch (err) {
      if (savedAvatar) {
        fileService.unlinkIfUnreferenced([
          ...fileService.extractUploadFilenames(savedAvatar.avatarUrl),
          ...fileService.extractUploadFilenames(savedAvatar.avatarThumbUrl),
        ]);
      }
      throw err;
    }
  },

  /**
   * Authenticate user using @username or Gmail/email + password with escalating rate limit & MFA guard
   */
  login(identifier: string, password: string, ipAddress?: string, userAgent?: string, mfaCode?: string) {
    if (!identifier || !password) {
      throw new Error('Please provide your username or Gmail address and password.');
    }

    const trimmedId = identifier.trim().slice(0, 254);
    const handleCandidate = trimmedId.startsWith('@') ? trimmedId : `@${trimmedId}`;

    const rateLimit = this.getLoginRateLimitStatus(trimmedId, ipAddress);
    if (!rateLimit.allowed) {
      recordSecurityEvent({
        eventType: 'LOGIN_COOLDOWN_BLOCKED',
        severity: rateLimit.failureCount24h >= 8 ? 'high' : 'warning',
        identifier: trimmedId,
        ipAddress,
        userAgent,
        details: { retryAfterSeconds: rateLimit.retryAfterSeconds, failureCount24h: rateLimit.failureCount24h },
      });
      throw new AuthRateLimitError(
        `Too many failed login attempts. Account temporarily locked. Try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minute(s).`,
        rateLimit.retryAfterSeconds
      );
    }

    if (typeof password !== 'string' || password.length > 128) {
      this.recordLoginAttempt(trimmedId, false, ipAddress);
      throw new Error('Invalid email/username or password.');
    }

    const userRow: any = db.prepare(`
      SELECT u.*, pr.handle, pr.name
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE LOWER(u.email) = LOWER(?)
         OR u.phone_number = ?
         OR LOWER(COALESCE(u.username, '')) = LOWER(?)
         OR LOWER(COALESCE(u.username, '')) = LOWER(?)
         OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
         OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
    `).get(trimmedId, trimmedId, trimmedId, handleCandidate, trimmedId, handleCandidate);

    if (!userRow) {
      try {
        crypto.scryptSync(password, 'dummy_timing_equalizer_salt', 32, SCRYPT_EQUALIZER_OPTS);
      } catch {
        // ignore
      }
      this.recordLoginAttempt(trimmedId, false, ipAddress);
      throw new Error('Invalid email/username or password.');
    }

    if (!verifyPassword(password, userRow.password_hash)) {
      this.recordLoginAttempt(trimmedId, false, ipAddress);
      const updatedRl = this.getLoginRateLimitStatus(trimmedId, ipAddress);
      if (!updatedRl.allowed) {
        recordSecurityEvent({
          userId: userRow.id,
          eventType: 'FAILED_LOGIN_BURST',
          severity: 'high',
          identifier: trimmedId,
          ipAddress,
          userAgent,
          details: { failureCount24h: updatedRl.failureCount24h },
        });
        insertSecurityNotification(
          userRow.id,
          'Repeated Failed Sign-In Attempts',
          'Multiple incorrect password attempts were blocked on your account. If this was not you, change your password in Settings.'
        );
      }
      throw new Error('Invalid email/username or password.');
    }

    if (userRow.status === 'suspended') {
      throw new Error('This account has been suspended by moderation.');
    }

    if (needsPasswordRehash(userRow.password_hash)) {
      try {
        db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
          hashPassword(password),
          userRow.id
        );
      } catch {
        // non-fatal migration upgrade
      }
    }

    // Enforce RFC-6238 TOTP MFA if enabled on Admin or Moderator accounts
    if ((userRow.role === 'admin' || userRow.role === 'moderator') && Boolean(userRow.mfa_enabled) && userRow.mfa_secret) {
      if (!mfaCode || !mfaCode.trim()) {
        throw new Error('MFA_REQUIRED: Enter the 6-digit authenticator code for this account.');
      }
      if (!verifyTotpToken(userRow.mfa_secret, mfaCode)) {
        this.recordLoginAttempt(trimmedId, false, ipAddress);
        recordSecurityEvent({
          userId: userRow.id,
          eventType: 'MFA_VERIFICATION_FAILED',
          severity: 'warning',
          identifier: trimmedId,
          ipAddress,
          userAgent,
        });
        throw new Error('Invalid 6-digit MFA authenticator code.');
      }
    }

    this.recordLoginAttempt(trimmedId, true, ipAddress);
    db.prepare('UPDATE users SET last_reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userRow.id);

    const session = this.createSession(userRow.id, ipAddress, userAgent);

    return {
      user: {
        id: userRow.id,
        matric_number: userRow.matric_number,
        email: userRow.email,
        phone_number: userRow.phone_number || '',
        username: userRow.username || userRow.handle,
        role: userRow.role,
        status: userRow.status,
        is_verified: Boolean(userRow.is_verified),
        acceptedTermsVersion: userRow.accepted_terms_version || null,
      },
      token: session.token,
      refreshToken: session.refreshToken,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      deviceName: session.deviceName,
      deviceType: session.deviceType,
    };
  },

  /**
   * Multi-device session management:
   * - Supports concurrent active devices up to MAX_ACTIVE_DEVICES (default 5), evicting the oldest active device when exceeded.
   * - Issues short-lived 15-minute access token + rotating 30-day sliding refresh token with a 90-day hard session ceiling.
   * - Stores ONLY SHA-256 hashes in SQLite.
   */
  createSession(userId: string, ipAddress?: string, userAgent?: string) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(token);
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const refreshHash = hashSessionToken(refreshToken);
    const sessionId = `sess-${crypto.randomBytes(8).toString('hex')}`;

    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + SESSION_POLICY.accessTtlMinutes * 60 * 1000).toISOString();
    const refreshExpiresAt = new Date(nowMs + SESSION_POLICY.refreshInactivityDays * 24 * 60 * 60 * 1000).toISOString();
    const maxExpiresAt = new Date(nowMs + SESSION_POLICY.sessionMaxLifetimeDays * 24 * 60 * 60 * 1000).toISOString();

    const { deviceName, deviceType } = parseDeviceFromUserAgent(userAgent);

    // Check active sessions and historical devices BEFORE inserting
    const existingActive = db.prepare(`
      SELECT token, id, device_name, ip_address, created_at, last_active_at
      FROM sessions
      WHERE user_id = ?
        AND revoked_at IS NULL
        AND datetime(COALESCE(refresh_expires_at, expires_at)) > datetime('now')
        AND (max_expires_at IS NULL OR datetime(max_expires_at) > datetime('now'))
      ORDER BY COALESCE(last_active_at, created_at) ASC, rowid ASC
    `).all(userId) as Array<{
      token: string;
      id: string | null;
      device_name: string | null;
      ip_address: string | null;
      created_at: string;
      last_active_at: string | null;
    }>;

    // Evict oldest device session(s) if user already has >= maxActiveDevices
    if (existingActive.length >= SESSION_POLICY.maxActiveDevices) {
      const overflowCount = existingActive.length - SESSION_POLICY.maxActiveDevices + 1;
      const toEvict = existingActive.slice(0, overflowCount);
      for (const oldSess of toEvict) {
        db.prepare(`
          UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = 'device_limit_exceeded'
          WHERE token = ?
        `).run(oldSess.token);
      }
      recordSecurityEvent({
        userId,
        eventType: 'DEVICE_LIMIT_EVICTION',
        severity: 'info',
        ipAddress,
        userAgent,
        deviceName,
        details: {
          maxActiveDevices: SESSION_POLICY.maxActiveDevices,
          evictedCount: toEvict.length,
          evictedDevices: toEvict.map((s) => s.device_name || 'Unknown Device'),
        },
      });
    }

    // Detect login from an unfamiliar device / different IP when prior sessions exist
    const priorKnown = db.prepare(`
      SELECT device_name, ip_address
      FROM sessions
      WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
      LIMIT 25
    `).all(userId) as Array<{ device_name: string | null; ip_address: string | null }>;

    const hasPriorSessions = priorKnown.length > 0;
    const seenExactDevice = priorKnown.some((s) => (s.device_name || '') === deviceName);
    const seenIp = ipAddress ? priorKnown.some((s) => s.ip_address === ipAddress) : true;
    const isSuspicious = hasPriorSessions && !seenExactDevice && !seenIp ? 1 : 0;

    db.prepare(`
      INSERT INTO sessions (
        token, id, user_id, ip_address, user_agent, device_name, device_type,
        last_active_at, refresh_token_hash, refresh_expires_at, max_expires_at,
        expires_at, is_suspicious
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
    `).run(
      tokenHash,
      sessionId,
      userId,
      ipAddress || null,
      userAgent ? String(userAgent).slice(0, 255) : null,
      deviceName,
      deviceType,
      refreshHash,
      refreshExpiresAt,
      maxExpiresAt,
      expiresAt,
      isSuspicious
    );

    if (hasPriorSessions && (!seenExactDevice || isSuspicious)) {
      recordSecurityEvent({
        userId,
        eventType: isSuspicious ? 'SUSPICIOUS_LOGIN' : 'NEW_DEVICE_LOGIN',
        severity: isSuspicious ? 'warning' : 'info',
        ipAddress,
        userAgent,
        deviceName,
        details: { deviceType, newDevice: !seenExactDevice, newIp: !seenIp },
      });
      insertSecurityNotification(
        userId,
        'New Device Sign-In Detected',
        `Your account was accessed from ${deviceName}. Review active devices in Settings → Devices & Sessions if this wasn't you.`
      );
    }

    return {
      token,
      refreshToken,
      sessionId,
      deviceName,
      deviceType,
      expiresAt,
      refreshExpiresAt,
      maxExpiresAt,
    };
  },

  /**
   * Rotates a valid refresh token into a fresh 15m access token + new 30d sliding refresh token.
   * Rejects revoked/replayed tokens and immediately revokes all active sessions for the user on reuse detection.
   */
  refreshSession(rawRefreshToken: string, ipAddress?: string, userAgent?: string) {
    const cleanRefresh = String(rawRefreshToken || '').trim();
    if (!cleanRefresh) {
      throw new Error('Refresh token is required.');
    }

    const refreshHash = hashSessionToken(cleanRefresh);
    const row = db.prepare(`
      SELECT s.*, u.status, u.role, u.matric_number, u.email, u.accepted_terms_version
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
    `).get(refreshHash) as any;

    if (!row) {
      recordSecurityEvent({
        eventType: 'INVALID_REFRESH_TOKEN',
        severity: 'warning',
        ipAddress,
        userAgent,
      });
      throw new Error('Invalid or expired session refresh token.');
    }

    // Reuse detection: any replay of an already-rotated or revoked refresh token revokes ALL active user sessions
    if (row.revoked_at) {
      db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'refresh_reuse_detected'
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(row.user_id);

      recordSecurityEvent({
        userId: row.user_id,
        eventType: 'REFRESH_TOKEN_REUSE',
        severity: 'critical',
        ipAddress,
        userAgent,
        deviceName: row.device_name,
        details: { priorRevokedReason: row.revoked_reason || 'unknown' },
      });
      insertSecurityNotification(
        row.user_id,
        'Security Alert: All Sessions Signed Out',
        'Suspicious session reuse was detected, so all active devices were signed out. Please sign in again and change your password.'
      );
      const reuseErr = new Error('Session security alert: suspicious token reuse detected. All sessions signed out.');
      (reuseErr as any).code = 'REFRESH_TOKEN_REUSE';
      throw reuseErr;
    }

    if (row.status === 'suspended') {
      throw new Error('This account has been suspended by moderation.');
    }

    const nowMs = Date.now();
    const refreshExpMs = parseTimestampMs(row.refresh_expires_at || row.expires_at);
    const maxExpMs = row.max_expires_at ? parseTimestampMs(row.max_expires_at) : nowMs + SESSION_POLICY.sessionMaxLifetimeDays * 86400000;

    if ((Number.isFinite(refreshExpMs) && refreshExpMs <= nowMs) || (Number.isFinite(maxExpMs) && maxExpMs <= nowMs)) {
      db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'session_expired'
        WHERE token = ?
      `).run(row.token);
      throw new Error('Session expired due to inactivity or maximum session lifetime. Please sign in again.');
    }

    const newAccessToken = crypto.randomBytes(32).toString('hex');
    const newAccessHash = hashSessionToken(newAccessToken);
    const newRefreshToken = crypto.randomBytes(32).toString('hex');
    const newRefreshHash = hashSessionToken(newRefreshToken);

    const newAccessExpiresAt = new Date(
      Math.min(maxExpMs, nowMs + SESSION_POLICY.accessTtlMinutes * 60 * 1000)
    ).toISOString();
    const nextRefreshTargetMs = nowMs + SESSION_POLICY.refreshInactivityDays * 24 * 60 * 60 * 1000;
    const newRefreshExpiresAt = new Date(Math.min(maxExpMs, nextRefreshTargetMs)).toISOString();
    const maxExpiresAtIso = new Date(maxExpMs).toISOString();

    const parsedDevice = userAgent ? parseDeviceFromUserAgent(userAgent) : null;
    const deviceName = row.device_name || parsedDevice?.deviceName || 'Web Browser';
    const deviceType = row.device_type || parsedDevice?.deviceType || 'desktop';
    const stableSessionId = row.id || `sess-${crypto.randomBytes(8).toString('hex')}`;
    const tombstoneId = `${stableSessionId}-rot-${crypto.randomBytes(2).toString('hex')}`;

    runInTransaction(() => {
      // Preserve old refresh_token_hash on a revoked tombstone row so replays trigger reuse detection
      db.prepare(`
        UPDATE sessions
        SET id = ?,
            revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'refresh_rotated'
        WHERE token = ?
      `).run(tombstoneId, row.token);

      db.prepare(`
        INSERT INTO sessions (
          token, id, user_id, ip_address, user_agent, device_name, device_type,
          last_active_at, refresh_token_hash, refresh_expires_at, max_expires_at,
          expires_at, is_suspicious, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)
      `).run(
        newAccessHash,
        stableSessionId,
        row.user_id,
        ipAddress || row.ip_address || null,
        userAgent ? String(userAgent).slice(0, 255) : row.user_agent || null,
        deviceName,
        deviceType,
        newRefreshHash,
        newRefreshExpiresAt,
        maxExpiresAtIso,
        newAccessExpiresAt,
        row.is_suspicious ? 1 : 0,
        row.created_at
      );
    });

    return {
      token: newAccessToken,
      refreshToken: newRefreshToken,
      sessionId: stableSessionId,
      expiresAt: newAccessExpiresAt,
      refreshExpiresAt: newRefreshExpiresAt,
      maxExpiresAt: maxExpiresAtIso,
      user: {
        id: row.user_id,
        matric_number: row.matric_number,
        email: row.email,
        role: row.role,
        status: row.status,
        acceptedTermsVersion: row.accepted_terms_version || null,
      },
    };
  },

  validateSession(token: string): AuthenticatedUser | null {
    if (!token) return null;
    const tokenHash = hashSessionToken(token);

    const row = db.prepare(`
      SELECT s.token, s.expires_at, s.max_expires_at, s.revoked_at,
             u.id, u.matric_number, u.email, u.role, u.status, u.accepted_terms_version, u.last_reauthenticated_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
        AND s.revoked_at IS NULL
    `).get(tokenHash) as any;

    if (!row) return null;

    const nowMs = Date.now();
    const accessExpMs = parseTimestampMs(row.expires_at);
    const maxExpMs = row.max_expires_at ? parseTimestampMs(row.max_expires_at) : Infinity;

    if ((Number.isFinite(accessExpMs) && accessExpMs <= nowMs) || (Number.isFinite(maxExpMs) && maxExpMs <= nowMs)) {
      return null;
    }

    if (row.status === 'suspended') {
      return null;
    }

    return {
      id: row.id,
      matric_number: row.matric_number,
      email: row.email,
      role: row.role,
      status: row.status,
      acceptedTermsVersion: row.accepted_terms_version || null,
      lastReauthenticatedAt: row.last_reauthenticated_at || null,
    };
  },

  logout(token: string) {
    if (token) {
      const tokenHash = hashSessionToken(token);
      db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'logout'
        WHERE token = ? AND revoked_at IS NULL
      `).run(tokenHash);
    }
    return { success: true };
  },

  /**
   * Lists active devices/sessions for a user (never returns token hashes).
   */
  getUserSessions(userId: string, currentTokenHash?: string) {
    const rows = db.prepare(`
      SELECT id, token, device_name, device_type, ip_address, last_active_at, created_at, expires_at, refresh_expires_at, max_expires_at, is_suspicious
      FROM sessions
      WHERE user_id = ?
        AND revoked_at IS NULL
        AND datetime(COALESCE(refresh_expires_at, expires_at)) > datetime('now')
        AND (max_expires_at IS NULL OR datetime(max_expires_at) > datetime('now'))
      ORDER BY COALESCE(last_active_at, created_at) DESC
    `).all(userId) as any[];

    return rows.map((r) => ({
      id: r.id || `sess-${String(r.token).slice(0, 12)}`,
      deviceName: r.device_name || 'Web Browser',
      deviceType: (r.device_type as 'phone' | 'tablet' | 'desktop') || 'desktop',
      ipAddress: r.ip_address ? String(r.ip_address) : 'unknown',
      isCurrent: Boolean(currentTokenHash && r.token === currentTokenHash),
      isSuspicious: Boolean(r.is_suspicious),
      lastActiveAt: r.last_active_at || r.created_at,
      createdAt: r.created_at,
      expiresAt: r.refresh_expires_at || r.expires_at,
      maxExpiresAt: r.max_expires_at || null,
    }));
  },

  revokeUserSession(userId: string, sessionId: string) {
    const cleanId = sanitizeInputText(sessionId, 80);
    if (!cleanId) {
      throw new Error('Session ID is required.');
    }
    const target = db.prepare(`
      SELECT token, device_name FROM sessions
      WHERE user_id = ? AND id = ? AND revoked_at IS NULL
      LIMIT 1
    `).get(userId, cleanId) as { token: string; device_name: string | null } | undefined;

    if (!target) {
      throw new Error('Active device session not found.');
    }

    db.prepare(`
      UPDATE sessions
      SET revoked_at = CURRENT_TIMESTAMP,
          revoked_reason = 'user_revoked_device'
      WHERE token = ? AND user_id = ?
    `).run(target.token, userId);

    recordSecurityEvent({
      userId,
      eventType: 'USER_REVOKED_SESSION',
      severity: 'info',
      deviceName: target.device_name,
      details: { sessionId: cleanId },
    });

    return { success: true, revokedSessionId: cleanId };
  },

  revokeOtherUserSessions(userId: string, currentTokenHash?: string) {
    const res = currentTokenHash
      ? db.prepare(`
          UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = 'user_revoked_all_others'
          WHERE user_id = ? AND token != ? AND revoked_at IS NULL
        `).run(userId, currentTokenHash)
      : db.prepare(`
          UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = 'user_revoked_all'
          WHERE user_id = ? AND revoked_at IS NULL
        `).run(userId);

    const revokedCount = Number(res.changes || 0);
    recordSecurityEvent({
      userId,
      eventType: 'USER_REVOKED_OTHER_SESSIONS',
      severity: 'info',
      details: { revokedCount },
    });

    return { success: true, revokedCount };
  },

  /**
   * Re-authenticates current user password before sensitive security actions.
   */
  reauthenticate(userId: string, password: string, ipAddress?: string) {
    const bucketKey = `reauth:${userId}`;
    if (!checkRateLimit(bucketKey, MAX_FAILED_ATTEMPTS, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many failed re-authentication attempts. Try again in 15 minutes.', 900);
    }

    const row = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(userId) as
      | { id: string; password_hash: string }
      | undefined;
    if (!row || !password || typeof password !== 'string' || password.length > 128 || !verifyPassword(password, row.password_hash)) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      throw new Error('Incorrect password.');
    }

    recordRateLimitEvent(bucketKey, true, ipAddress);
    db.prepare('UPDATE users SET last_reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    return { success: true, reauthenticatedAt: new Date().toISOString() };
  },

  /**
   * Changes authenticated user's password and revokes all other active device sessions.
   */
  changePassword(userId: string, currentPassword: string, newPassword: string, currentTokenHash?: string, ipAddress?: string) {
    const bucketKey = `pwchange:${userId}`;
    if (!checkRateLimit(bucketKey, MAX_FAILED_ATTEMPTS, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many failed password change attempts. Please wait 15 minutes.', 900);
    }

    const user = db.prepare('SELECT id, email, username, password_hash FROM users WHERE id = ?').get(userId) as
      | { id: string; email: string; username: string | null; password_hash: string }
      | undefined;
    if (!user) throw new Error('Account not found.');

    if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.length > 128 || !verifyPassword(currentPassword, user.password_hash)) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      throw new Error('Current password is incorrect.');
    }

    if (currentPassword === newPassword) {
      throw new Error('New password must differ from your current password.');
    }

    const pwdCheck = validateStrongPassword(newPassword, [user.username || '', user.email.split('@')[0]]);
    if (!pwdCheck.valid) {
      throw new Error(pwdCheck.error || 'New password does not meet security requirements.');
    }

    recordRateLimitEvent(bucketKey, true, ipAddress);

    return runInTransaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?,
            last_reauthenticated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(hashPassword(newPassword), userId);

      const revokedRes = currentTokenHash
        ? db.prepare(`
            UPDATE sessions
            SET revoked_at = CURRENT_TIMESTAMP,
                revoked_reason = 'password_changed'
            WHERE user_id = ? AND token != ? AND revoked_at IS NULL
          `).run(userId, currentTokenHash)
        : db.prepare(`
            UPDATE sessions
            SET revoked_at = CURRENT_TIMESTAMP,
                revoked_reason = 'password_changed'
            WHERE user_id = ? AND revoked_at IS NULL
          `).run(userId);

      recordSecurityEvent({
        userId,
        eventType: 'PASSWORD_CHANGED',
        severity: 'info',
        ipAddress,
        details: { revokedOtherSessions: Number(revokedRes.changes || 0) },
      });
      insertSecurityNotification(
        userId,
        'Password Changed',
        'Your password was updated and all other active device sessions were signed out for your protection.'
      );

      return {
        success: true,
        revokedOtherSessions: Number(revokedRes.changes || 0),
        message: 'Password updated. All other active device sessions have been signed out.',
      };
    });
  },

  acceptTerms(userId: string) {
    db.prepare(`
      UPDATE users
      SET accepted_terms_at = CURRENT_TIMESTAMP,
          accepted_terms_version = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(CURRENT_TERMS_VERSION, userId);

    return {
      success: true,
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedAt: new Date().toISOString(),
    };
  },

  /**
   * Generic TOTP MFA management for privileged roles (Admin & Moderator)
   */
  getMfaStatus(userId: string) {
    const row = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(userId) as { mfa_enabled?: number } | undefined;
    return { mfaEnabled: Boolean(row?.mfa_enabled) };
  },

  initiateMfaSetup(userId: string, accountLabel: string) {
    const secret = generateBase32Secret(20);
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret, userId);
    const otpauthUri = `otpauth://totp/Schoolbackdoor:${encodeURIComponent(accountLabel)}?secret=${secret}&issuer=Schoolbackdoor`;
    const sampleCurrentCode = process.env.NODE_ENV !== 'production' ? computeTotpCode(secret) : undefined;
    return { secret, otpauthUri, sampleCurrentCode };
  },

  verifyAndEnableMfa(userId: string, code: string) {
    const bucketKey = `mfa_verify:${userId}`;
    if (!checkRateLimit(bucketKey, 5, RATE_LIMIT_WINDOW_MS)) {
      throw new AuthRateLimitError('Too many failed MFA attempts. Please wait 15 minutes before retrying.', 900);
    }
    const row = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get(userId) as any;
    if (!row?.mfa_secret) {
      throw new Error('MFA setup not initiated. Generate a setup key first.');
    }
    if (!verifyTotpToken(row.mfa_secret, code)) {
      recordRateLimitEvent(bucketKey, false);
      throw new Error('Invalid 6-digit MFA authenticator code.');
    }
    recordRateLimitEvent(bucketKey, true);
    db.prepare('UPDATE users SET mfa_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    recordSecurityEvent({
      userId,
      eventType: 'MFA_ENABLED',
      severity: 'info',
    });
    return { success: true, mfaEnabled: true };
  },

  disableMfa(userId: string, currentPassword: string) {
    const bucketKey = `mfa_disable:${userId}`;
    if (!checkRateLimit(bucketKey, 5, RATE_LIMIT_WINDOW_MS)) {
      throw new AuthRateLimitError('Too many failed MFA disable attempts. Please wait 15 minutes.', 900);
    }
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as any;
    if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.length > 128 || !row || !verifyPassword(currentPassword, row.password_hash)) {
      recordRateLimitEvent(bucketKey, false);
      throw new Error('Invalid account password.');
    }
    recordRateLimitEvent(bucketKey, true);
    db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    recordSecurityEvent({
      userId,
      eventType: 'MFA_DISABLED',
      severity: 'warning',
    });
    return { success: true, mfaEnabled: false };
  },

  /**
   * Account Verification (with OTP brute-force rate limit & code burn after 5 failures)
   */
  verifyAccount(userId: string, code: string, ipAddress?: string) {
    const bucketKey = `verify:${userId}`;
    if (!checkRateLimit(bucketKey, MAX_FAILED_ATTEMPTS, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new Error('Too many failed verification attempts. Please wait 15 minutes or request a new code.');
    }

    const user = db.prepare(`
      SELECT verification_code, is_verified FROM users WHERE id = ?
    `).get(userId) as { verification_code: string | null; is_verified: number } | undefined;

    if (!user) throw new Error('User not found.');
    if (user.is_verified) {
      return { success: true, verified: true };
    }

    const providedBuf = Buffer.from(String(code || '').trim(), 'utf8');
    const expectedBuf = Buffer.from(String(user.verification_code || ''), 'utf8');
    if (
      expectedBuf.length === 0 ||
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      if (!checkRateLimit(bucketKey, MAX_FAILED_ATTEMPTS, RATE_LIMIT_WINDOW_MS, ipAddress)) {
        db.prepare('UPDATE users SET verification_code = NULL WHERE id = ?').run(userId);
      }
      throw new Error('Invalid verification code.');
    }

    recordRateLimitEvent(bucketKey, true, ipAddress);

    db.prepare(`
      UPDATE users SET is_verified = 1, verification_code = NULL WHERE id = ?
    `).run(userId);

    db.prepare(`
      UPDATE user_profiles SET verified = 1 WHERE user_id = ?
    `).run(userId);

    return { success: true, verified: true };
  },

  resendVerificationCode(userId: string, ipAddress?: string) {
    if (!checkRateLimit(`verify_resend:${userId}`, 5, 60 * 60 * 1000, ipAddress)) {
      throw new Error('Too many verification code requests. Please wait before requesting another code.');
    }
    const user = db.prepare('SELECT id, email, is_verified FROM users WHERE id = ?').get(userId) as
      | { id: string; email: string; is_verified: number }
      | undefined;
    if (!user) throw new Error('User not found.');
    if (user.is_verified) {
      return { success: true, verified: true, message: 'Email address is already verified.' };
    }
    recordRateLimitEvent(`verify_resend:${userId}`, false, ipAddress);
    const verificationCode = generateNumericOtp(6);
    db.prepare('UPDATE users SET verification_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      verificationCode,
      userId
    );
    return {
      success: true,
      verified: false,
      ...(process.env.NODE_ENV !== 'production' ? { verification_code: verificationCode } : {}),
      message: `A fresh 6-digit verification code has been prepared for ${user.email}.`,
    };
  },

  /**
   * Password Recovery Flow (equalized work for unknown accounts + safe rate limits)
   */
  requestPasswordReset(identifier: string, ipAddress?: string) {
    const trimmed = String(identifier || '').trim();
    if (!trimmed) {
      throw new Error('Username or Gmail address is required.');
    }
    const handleCandidate = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    if (!checkRateLimit(`forgot:${trimmed.toLowerCase()}`, MAX_RECOVERY_ATTEMPTS_PER_HOUR, 60 * 60 * 1000, ipAddress)) {
      throw new Error('Too many password recovery requests. Please wait before trying again.');
    }
    recordRateLimitEvent(`forgot:${trimmed.toLowerCase()}`, false, ipAddress);

    const user = db.prepare(`
      SELECT u.id, u.email, u.phone_number, pr.name
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE LOWER(u.email) = LOWER(?)
         OR u.phone_number = ?
         OR LOWER(COALESCE(u.username, '')) = LOWER(?)
         OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
         OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
    `).get(trimmed, trimmed, trimmed, trimmed, handleCandidate) as any;

    if (!user) {
      return {
        success: true,
        message: 'If an account matches that username or Gmail address, recovery instructions have been prepared.',
      };
    }

    const resetCode = generateNumericOtp(6);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    db.prepare(`UPDATE password_resets SET is_used = 1 WHERE user_id = ? AND is_used = 0`).run(user.id);

    db.prepare(`
      INSERT INTO password_resets (id, user_id, reset_code, expires_at, is_used, failed_attempts)
      VALUES (?, ?, ?, ?, 0, 0)
    `).run(`rst-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, user.id, resetCode, expiresAt);

    recordSecurityEvent({
      userId: user.id,
      eventType: 'PASSWORD_RESET_REQUESTED',
      severity: 'info',
      identifier: trimmed,
      ipAddress,
    });

    return {
      success: true,
      ...(process.env.NODE_ENV !== 'production' ? { resetCode } : {}),
      message: 'Password reset code generated. Check your registered Gmail recovery instructions to complete reset.',
    };
  },

  resetPasswordWithCode(resetCode: string, newPassword: string, ipAddress?: string, identifier?: string) {
    if (!checkRateLimit(`reset:${ipAddress || 'unknown'}`, MAX_RESET_FAILURES, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many password reset attempts. Please wait 15 minutes before trying again.', 900);
    }

    const pwdCheck = validateStrongPassword(newPassword, identifier ? [identifier] : []);
    if (!pwdCheck.valid) {
      throw new Error(pwdCheck.error || 'New password does not meet security requirements.');
    }

    const cleanCode = String(resetCode || '').trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      recordRateLimitEvent(`reset:${ipAddress || 'unknown'}`, false, ipAddress);
      throw new Error('Invalid or expired password reset code.');
    }

    let scopedUserId: string | null = null;
    if (identifier && identifier.trim()) {
      const trimmed = identifier.trim();
      const handleCandidate = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
      const targetUser = db.prepare(`
        SELECT u.id
        FROM users u
        LEFT JOIN user_profiles pr ON pr.user_id = u.id
        WHERE LOWER(u.email) = LOWER(?)
           OR LOWER(COALESCE(u.username, '')) = LOWER(?)
           OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
           OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
        LIMIT 1
      `).get(trimmed, trimmed, trimmed, handleCandidate) as { id: string } | undefined;
      scopedUserId = targetUser?.id || null;
    }

    const activeRows = (scopedUserId
      ? db.prepare(`
          SELECT * FROM password_resets
          WHERE user_id = ? AND is_used = 0
          ORDER BY created_at DESC
          LIMIT 10
        `).all(scopedUserId)
      : db.prepare(`
          SELECT * FROM password_resets
          WHERE is_used = 0
          ORDER BY created_at DESC
          LIMIT 100
        `).all()) as any[];

    const providedBuf = Buffer.from(cleanCode, 'utf8');
    const resetRow = activeRows.find((r) => {
      const expectedBuf = Buffer.from(String(r.reset_code || ''), 'utf8');
      return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
    });

    if (!resetRow) {
      if (scopedUserId) {
        db.prepare(`
          UPDATE password_resets
          SET failed_attempts = COALESCE(failed_attempts, 0) + 1,
              is_used = CASE WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN 1 ELSE is_used END
          WHERE user_id = ? AND is_used = 0
        `).run(MAX_RESET_FAILURES, scopedUserId);
      }
      recordRateLimitEvent(`reset:${ipAddress || 'unknown'}`, false, ipAddress);
      throw new Error('Invalid or expired password reset code.');
    }

    if (Number(resetRow.failed_attempts || 0) >= MAX_RESET_FAILURES) {
      db.prepare('UPDATE password_resets SET is_used = 1 WHERE id = ?').run(resetRow.id);
      throw new Error('Password reset code invalidated due to too many failed attempts. Please request a new one.');
    }

    if (new Date(resetRow.expires_at) < new Date()) {
      throw new Error('Password reset code has expired. Please request a new one.');
    }

    return runInTransaction(() => {
      const passwordHash = hashPassword(newPassword);

      db.prepare(`
        UPDATE users
        SET password_hash = ?,
            last_reauthenticated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(passwordHash, resetRow.user_id);

      db.prepare(`
        UPDATE password_resets
        SET is_used = 1
        WHERE id = ?
      `).run(resetRow.id);

      db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'password_reset'
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(resetRow.user_id);

      recordSecurityEvent({
        userId: resetRow.user_id,
        eventType: 'PASSWORD_RESET_COMPLETED',
        severity: 'warning',
        ipAddress,
      });

      return { success: true, message: 'Password has been successfully updated. Please sign in with your new password.' };
    });
  },
};

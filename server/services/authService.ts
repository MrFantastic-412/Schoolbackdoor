import crypto from 'node:crypto';
import { db, runInTransaction, UNCLAIMED_CREDENTIAL_SENTINEL } from '../db/database.js';
import { AuthenticatedUser, parseTimestampMs } from '../middleware/auth.js';
import { generateBase32Secret, computeTotpCode, verifyTotpToken } from '../utils/totp.js';
import { fileService, PROTECTION_MODE_MAX_UPLOAD_BYTES } from './fileService.js';
import { deletionService } from './deletionService.js';
import {
  hashPassword,
  verifyPassword,
  needsPasswordRehash,
  equalizePasswordTiming,
  hashSessionToken,
  validateStrongPassword,
  sanitizeInputText,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCodeHash,
  verifyPowSolution,
  checkRateLimit,
  recordRateLimitEvent,
  CURRENT_TERMS_VERSION,
  SESSION_POLICY,
  parseDeviceFromUserAgent,
  recordSecurityEvent,
  computeProgressiveDelayMs,
} from '../utils/security.js';

export { hashPassword, verifyPassword };

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes base window
const ESCALATION_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours escalation counter
const MAX_FAILED_ATTEMPTS = 5;
const MAX_IP_FAILED_ATTEMPTS = 15;
const MAX_REGISTER_ATTEMPTS_PER_HOUR = 10;
const MAX_CHALLENGE_ISSUES_PER_HOUR = 30;
const MAX_RECOVERY_ATTEMPTS_PER_15M = 5;
const MAX_RECOVERY_IP_ATTEMPTS_PER_15M = 10;
const BOT_CHALLENGE_TTL_MINUTES = 5;
const BOT_POW_DIFFICULTY = Math.min(20, Math.max(8, Number(process.env.BOT_POW_DIFFICULTY) || 14));
const DUMMY_RECOVERY_SALT = '00112233445566778899aabbccddeeff';
const DUMMY_RECOVERY_HASH = '0'.repeat(64);
const GENERIC_LOGIN_ERROR = 'Invalid username or password.';
const GENERIC_RECOVERY_ERROR = 'Invalid username or recovery code. Please check your details and try again.';

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
  username: string;
  password: string;
  confirmPassword?: string;
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
  idempotencyKey?: string;
  botChallengeId?: string;
  botChallengeNonce?: string;
  botChallengeSolution?: string;
  honeypot?: string;
  requireBotChallenge?: boolean;
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

function equalizeRecoveryTiming(codeNormalized: string) {
  for (let i = 0; i < 10; i++) {
    verifyRecoveryCodeHash(codeNormalized || 'AAAA0000BBBB1111', DUMMY_RECOVERY_SALT, DUMMY_RECOVERY_HASH);
  }
}

export const authService = {
  /**
   * Validates @username format (must start with @, 3-25 chars, letters/numbers/underscores, not reserved).
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
   * Issues a privacy-preserving Proof-of-Work challenge stored in SQLite (requires zero personal data).
   */
  issueRegistrationChallenge(ipAddress?: string) {
    if (!checkRateLimit(`reg_chal:${ipAddress || 'unknown'}`, MAX_CHALLENGE_ISSUES_PER_HOUR, 60 * 60 * 1000, ipAddress)) {
      throw new AuthRateLimitError('Too many signup challenge requests. Please wait before trying again.', 3600);
    }
    recordRateLimitEvent(`reg_chal:${ipAddress || 'unknown'}`, false, ipAddress);

    try {
      db.prepare("DELETE FROM bot_challenges WHERE datetime(expires_at) <= datetime('now') OR used_at IS NOT NULL").run();
    } catch {
      // non-fatal cleanup
    }

    const challengeId = `pow-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + BOT_CHALLENGE_TTL_MINUTES * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO bot_challenges (id, purpose, nonce, difficulty, ip_address, expires_at)
      VALUES (?, 'register', ?, ?, ?, ?)
    `).run(challengeId, nonce, BOT_POW_DIFFICULTY, ipAddress || null, expiresAt);

    return {
      challengeId,
      nonce,
      difficulty: BOT_POW_DIFFICULTY,
      expiresAt,
    };
  },

  /**
   * Verifies and atomically consumes a single-use Proof-of-Work challenge.
   */
  verifyAndConsumeRegistrationChallenge(
    challengeId: string | undefined,
    nonce: string | undefined,
    solution: string | undefined,
    ipAddress?: string
  ) {
    const cleanId = String(challengeId || '').trim();
    const cleanNonce = String(nonce || '').trim();
    const cleanSolution = String(solution || '').trim();

    if (!cleanId || !cleanNonce || !cleanSolution) {
      recordSecurityEvent({
        eventType: 'BOT_CHALLENGE_FAILED',
        severity: 'warning',
        ipAddress,
        details: { reason: 'missing_challenge_fields' },
      });
      throw new Error('Verification check expired or missing. Please refresh and submit again.');
    }

    const row = db.prepare(`
      SELECT id, nonce, difficulty, expires_at, used_at
      FROM bot_challenges
      WHERE id = ? AND nonce = ?
      LIMIT 1
    `).get(cleanId, cleanNonce) as
      | { id: string; nonce: string; difficulty: number; expires_at: string; used_at: string | null }
      | undefined;

    if (!row || row.used_at) {
      recordSecurityEvent({
        eventType: 'BOT_CHALLENGE_FAILED',
        severity: 'warning',
        ipAddress,
        details: { reason: row ? 'challenge_replayed' : 'challenge_not_found' },
      });
      throw new Error('Signup verification check expired or already used. Please try again.');
    }

    const expMs = parseTimestampMs(row.expires_at);
    if (Number.isFinite(expMs) && expMs <= Date.now()) {
      db.prepare('UPDATE bot_challenges SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      throw new Error('Signup verification check expired. Please submit again.');
    }

    if (!verifyPowSolution(row.nonce, cleanSolution, row.difficulty)) {
      recordSecurityEvent({
        eventType: 'BOT_CHALLENGE_FAILED',
        severity: 'warning',
        ipAddress,
        details: { reason: 'invalid_pow_solution' },
      });
      throw new Error('Automated signup verification failed. Please retry.');
    }

    const consumed = db.prepare(`
      UPDATE bot_challenges
      SET used_at = CURRENT_TIMESTAMP
      WHERE id = ? AND used_at IS NULL
    `).run(row.id);

    if (Number(consumed.changes || 0) !== 1) {
      throw new Error('Signup verification check already used. Please retry.');
    }
  },

  /**
   * Resolves normalized @username/handle aliases for shared-DB rate-limit tracking.
   */
  resolveLoginAliases(identifier: string): { userId: string | null; aliases: string[] } {
    const trimmed = String(identifier || '').trim().toLowerCase();
    const withoutAt = trimmed.replace(/^@/, '');
    const withAt = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    const aliasSet = new Set<string>([trimmed, withoutAt, withAt].filter(Boolean));

    const matched = db.prepare(`
      SELECT u.id, u.username, pr.handle
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE LOWER(COALESCE(u.username, '')) IN (?, ?)
         OR LOWER(COALESCE(pr.handle, '')) IN (?, ?)
      LIMIT 1
    `).get(trimmed, withAt, trimmed, withAt) as
      | { id: string; username: string | null; handle: string | null }
      | undefined;

    if (matched) {
      aliasSet.add(`acct:${matched.id}`.toLowerCase());
      if (matched.username) {
        aliasSet.add(matched.username.toLowerCase());
        aliasSet.add(matched.username.replace(/^@/, '').toLowerCase());
      }
      if (matched.handle) {
        aliasSet.add(matched.handle.toLowerCase());
        aliasSet.add(matched.handle.replace(/^@/, '').toLowerCase());
      }
    }

    return { userId: matched?.id || null, aliases: Array.from(aliasSet) };
  },

  /**
   * Shared-DB escalating temporary cooldown rate limiter (per-IP checked first, then per-(account, IP)).
   * Designed so an attacker cannot permanently lock out a victim:
   * - All cooldowns are temporary (15m -> 30m -> 60m -> 180m max cap).
   * - Per-IP limits catch brute-force / credential stuffing before affecting other IPs.
   * - Distributed spray across >=4 IPs throttles ONLY untrusted IPs; known legitimate IPs/devices can still sign in.
   */
  getLoginRateLimitStatus(identifier: string, ipAddress?: string): {
    allowed: boolean;
    retryAfterSeconds: number;
    failureCount24h: number;
    recentPairFailures: number;
    progressiveDelayMs: number;
    scope: 'ok' | 'ip' | 'pair' | 'spray';
  } {
    const shortWindowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    const escalationWindowStart = new Date(Date.now() - ESCALATION_LOOKBACK_MS).toISOString().replace('T', ' ').slice(0, 19);
    const { userId, aliases } = this.resolveLoginAliases(identifier);
    const placeholders = aliases.map(() => '?').join(', ');

    // 1. Check Per-IP limits FIRST (exclude scoped rl-* rate-limit bucket rows)
    const ipShort = ipAddress
      ? (db
          .prepare(`
            SELECT COUNT(*) as failed_count, MIN(attempted_at) as oldest_at, MAX(attempted_at) as latest_at
            FROM login_attempts
            WHERE ip_address = ?
              AND success = 0
              AND id NOT LIKE 'rl-%'
              AND datetime(attempted_at) >= datetime(?)
          `)
          .get(ipAddress, shortWindowStart) as
          | { failed_count: number; oldest_at: string | null; latest_at: string | null }
          | undefined)
      : undefined;

    const ipLongCount = ipAddress
      ? ((db
          .prepare(`
            SELECT COUNT(*) as failed_count
            FROM login_attempts
            WHERE ip_address = ?
              AND success = 0
              AND id NOT LIKE 'rl-%'
              AND datetime(attempted_at) >= datetime(?)
              AND attempted_at > COALESCE((
                SELECT MAX(attempted_at) FROM login_attempts
                WHERE ip_address = ? AND success = 1 AND id NOT LIKE 'rl-%'
              ), '1970-01-01')
          `)
          .get(ipAddress, escalationWindowStart, ipAddress) as { failed_count: number } | undefined)?.failed_count ?? 0)
      : 0;

    if ((ipShort?.failed_count ?? 0) >= MAX_IP_FAILED_ATTEMPTS) {
      const parsedMs = parseTimestampMs(ipShort?.oldest_at);
      const retryAfterSeconds =
        Number.isFinite(parsedMs) && parsedMs > 0
          ? Math.max(1, Math.ceil((parsedMs + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000))
          : Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
      return {
        allowed: false,
        retryAfterSeconds,
        failureCount24h: Math.max(ipShort?.failed_count ?? 0, ipLongCount),
        recentPairFailures: ipShort?.failed_count ?? 0,
        progressiveDelayMs: 2500,
        scope: 'ip',
      };
    }

    // 2. Check Per-(Account, IP) failures + account_lockouts table
    const pairShort = ipAddress
      ? (db
          .prepare(`
            SELECT COUNT(*) as failed_count, MIN(attempted_at) as oldest_at, MAX(attempted_at) as latest_at
            FROM login_attempts
            WHERE LOWER(identifier) IN (${placeholders})
              AND ip_address = ?
              AND success = 0
              AND datetime(attempted_at) >= datetime(?)
          `)
          .get(...aliases, ipAddress, shortWindowStart) as
          | { failed_count: number; oldest_at: string | null; latest_at: string | null }
          | undefined)
      : (db
          .prepare(`
            SELECT COUNT(*) as failed_count, MIN(attempted_at) as oldest_at, MAX(attempted_at) as latest_at
            FROM login_attempts
            WHERE LOWER(identifier) IN (${placeholders})
              AND success = 0
              AND datetime(attempted_at) >= datetime(?)
          `)
          .get(...aliases, shortWindowStart) as
          | { failed_count: number; oldest_at: string | null; latest_at: string | null }
          | undefined);

    const pairLong = ipAddress
      ? (db
          .prepare(`
            SELECT COUNT(*) as failed_count, MAX(attempted_at) as latest_at
            FROM login_attempts
            WHERE LOWER(identifier) IN (${placeholders})
              AND ip_address = ?
              AND success = 0
              AND datetime(attempted_at) >= datetime(?)
              AND attempted_at > COALESCE((
                SELECT MAX(attempted_at) FROM login_attempts
                WHERE LOWER(identifier) IN (${placeholders}) AND ip_address = ? AND success = 1
              ), '1970-01-01')
          `)
          .get(...aliases, ipAddress, escalationWindowStart, ...aliases, ipAddress) as
          | { failed_count: number; latest_at: string | null }
          | undefined)
      : (db
          .prepare(`
            SELECT COUNT(*) as failed_count, MAX(attempted_at) as latest_at
            FROM login_attempts
            WHERE LOWER(identifier) IN (${placeholders})
              AND success = 0
              AND datetime(attempted_at) >= datetime(?)
              AND attempted_at > COALESCE((
                SELECT MAX(attempted_at) FROM login_attempts
                WHERE LOWER(identifier) IN (${placeholders}) AND success = 1
              ), '1970-01-01')
          `)
          .get(...aliases, escalationWindowStart, ...aliases) as
          | { failed_count: number; latest_at: string | null }
          | undefined);

    // Check explicit shared account_lockouts table scoped to (account, IP)
    const pairKey = `${userId ? `u:${userId}` : `id:${aliases[0] || 'unknown'}`}|ip:${ipAddress || 'unknown'}`;
    const lockoutRow = db
      .prepare('SELECT failed_count, locked_until FROM account_lockouts WHERE account_key = ?')
      .get(pairKey) as { failed_count: number; locked_until: string | null } | undefined;

    if (lockoutRow?.locked_until) {
      const lockedUntilMs = parseTimestampMs(lockoutRow.locked_until);
      if (Number.isFinite(lockedUntilMs) && lockedUntilMs > Date.now()) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 1000)),
          failureCount24h: Math.max(pairLong?.failed_count ?? 0, lockoutRow.failed_count || 0),
          recentPairFailures: pairShort?.failed_count ?? 0,
          progressiveDelayMs: computeProgressiveDelayMs(pairShort?.failed_count ?? 0),
          scope: 'pair',
        };
      }
    }

    // 3. Anti-victim-DoS distributed spray check: throttle ONLY untrusted IPs
    if (ipAddress) {
      const globalAccountSpray = db
        .prepare(`
          SELECT COUNT(*) as failed_count, COUNT(DISTINCT COALESCE(ip_address, 'unknown')) as ip_count, MAX(attempted_at) as latest_at
          FROM login_attempts
          WHERE LOWER(identifier) IN (${placeholders})
            AND success = 0
            AND datetime(attempted_at) >= datetime(?)
        `)
        .get(...aliases, shortWindowStart) as
        | { failed_count: number; ip_count: number; latest_at: string | null }
        | undefined;

      if ((globalAccountSpray?.ip_count ?? 0) >= 4 && (globalAccountSpray?.failed_count ?? 0) >= MAX_IP_FAILED_ATTEMPTS) {
        const knownSuccessFromIp = db
          .prepare(`
            SELECT 1 FROM login_attempts
            WHERE LOWER(identifier) IN (${placeholders}) AND ip_address = ? AND success = 1
            LIMIT 1
          `)
          .get(...aliases, ipAddress);
        const knownSessionIp = userId
          ? db
              .prepare(`
                SELECT 1 FROM sessions
                WHERE user_id = ? AND ip_address = ? AND is_suspicious = 0
                LIMIT 1
              `)
              .get(userId, ipAddress)
          : undefined;

        if (!knownSuccessFromIp && !knownSessionIp) {
          const latestMs = parseTimestampMs(globalAccountSpray?.latest_at);
          const retryAfterSeconds =
            Number.isFinite(latestMs) && latestMs + RATE_LIMIT_WINDOW_MS > Date.now()
              ? Math.max(1, Math.ceil((latestMs + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000))
              : Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
          return {
            allowed: false,
            retryAfterSeconds,
            failureCount24h: Math.max(pairLong?.failed_count ?? 0, ipLongCount),
            recentPairFailures: pairShort?.failed_count ?? 0,
            progressiveDelayMs: 2500,
            scope: 'spray',
          };
        }
      }
    }

    const recentPairFailures = pairShort?.failed_count ?? 0;
    const failureCount24h = Math.max(pairLong?.failed_count ?? 0, ipLongCount);
    const pairShortBlocked = recentPairFailures >= MAX_FAILED_ATTEMPTS;

    let cooldownMs = RATE_LIMIT_WINDOW_MS;
    if (failureCount24h >= 16) cooldownMs = 180 * 60 * 1000;
    else if (failureCount24h >= 12) cooldownMs = 60 * 60 * 1000;
    else if (failureCount24h >= 8) cooldownMs = 30 * 60 * 1000;

    if (failureCount24h >= 8 && (pairShortBlocked || (pairLong?.failed_count ?? 0) >= 8)) {
      const latestMs = parseTimestampMs(pairLong?.latest_at);
      if (Number.isFinite(latestMs) && latestMs + cooldownMs > Date.now()) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((latestMs + cooldownMs - Date.now()) / 1000)),
          failureCount24h,
          recentPairFailures,
          progressiveDelayMs: computeProgressiveDelayMs(recentPairFailures),
          scope: 'pair',
        };
      }
    }

    if (!pairShortBlocked) {
      return {
        allowed: true,
        retryAfterSeconds: 0,
        failureCount24h,
        recentPairFailures,
        progressiveDelayMs: computeProgressiveDelayMs(recentPairFailures),
        scope: 'ok',
      };
    }

    const parsedMs = parseTimestampMs(pairShort?.oldest_at);
    const retryAfterSeconds =
      Number.isFinite(parsedMs) && parsedMs > 0
        ? Math.max(1, Math.ceil((parsedMs + cooldownMs - Date.now()) / 1000))
        : Math.ceil(cooldownMs / 1000);

    return {
      allowed: false,
      retryAfterSeconds,
      failureCount24h,
      recentPairFailures,
      progressiveDelayMs: computeProgressiveDelayMs(recentPairFailures),
      scope: 'pair',
    };
  },

  checkLoginRateLimit(identifier: string, ipAddress?: string): boolean {
    return this.getLoginRateLimitStatus(identifier, ipAddress).allowed;
  },

  recordLoginAttempt(identifier: string, success: boolean, ipAddress?: string, userId?: string | null) {
    const normalizedId = String(identifier || '').trim().toLowerCase().slice(0, 254);
    db.prepare(`
      INSERT INTO login_attempts (id, identifier, ip_address, success)
      VALUES (?, ?, ?, ?)
    `).run(
      `att-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      normalizedId,
      ipAddress || null,
      success ? 1 : 0
    );

    const pairKey = `${userId ? `u:${userId}` : `id:${normalizedId || 'unknown'}`}|ip:${ipAddress || 'unknown'}`;
    try {
      if (success) {
        db.prepare('DELETE FROM account_lockouts WHERE account_key = ?').run(pairKey);
      } else {
        const existing = db
          .prepare('SELECT failed_count FROM account_lockouts WHERE account_key = ?')
          .get(pairKey) as { failed_count: number } | undefined;
        const nextCount = (existing?.failed_count ?? 0) + 1;
        let lockedUntil: string | null = null;
        if (nextCount >= MAX_FAILED_ATTEMPTS) {
          let cooldownMs = RATE_LIMIT_WINDOW_MS;
          if (nextCount >= 16) cooldownMs = 180 * 60 * 1000;
          else if (nextCount >= 12) cooldownMs = 60 * 60 * 1000;
          else if (nextCount >= 8) cooldownMs = 30 * 60 * 1000;
          lockedUntil = new Date(Date.now() + cooldownMs).toISOString();
        }
        db.prepare(`
          INSERT INTO account_lockouts (account_key, user_id, failed_count, first_failed_at, last_failed_at, locked_until, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(account_key) DO UPDATE SET
            user_id = COALESCE(excluded.user_id, account_lockouts.user_id),
            failed_count = excluded.failed_count,
            last_failed_at = CURRENT_TIMESTAMP,
            locked_until = excluded.locked_until,
            updated_at = CURRENT_TIMESTAMP
        `).run(pairKey, userId || null, nextCount, lockedUntil);
      }
    } catch {
      // non-fatal lockout cache update
    }
  },

  /**
   * Register a new account with @username, password + confirmPassword (Argon2id),
   * privacy-preserving PoW bot protection, double-submit protection, and 10 single-use recovery codes.
   */
  register(input: RegisterInput, ipAddress?: string, bypassRegistrationLock = false) {
    if (!bypassRegistrationLock) {
      if (typeof input.honeypot === 'string' && input.honeypot.trim().length > 0) {
        recordSecurityEvent({
          eventType: 'BOT_CHALLENGE_FAILED',
          severity: 'warning',
          ipAddress,
          userAgent: input.userAgent,
          details: { reason: 'honeypot_triggered' },
        });
        throw new Error('Signup verification failed.');
      }

      if (!checkRateLimit(`reg:${ipAddress || 'unknown'}`, MAX_REGISTER_ATTEMPTS_PER_HOUR, 60 * 60 * 1000, ipAddress)) {
        recordSecurityEvent({
          eventType: 'REGISTRATION_RATE_LIMITED',
          severity: 'warning',
          ipAddress,
          userAgent: input.userAgent,
        });
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

      if (input.requireBotChallenge) {
        this.verifyAndConsumeRegistrationChallenge(
          input.botChallengeId,
          input.botChallengeNonce,
          input.botChallengeSolution,
          ipAddress
        );
      }
    }

    const { password, confirmPassword } = input;
    const usernameValidation = this.validateUsername(input.username);
    if (!usernameValidation.valid) {
      throw new Error(usernameValidation.error || 'Invalid username.');
    }
    const normalizedUsername = usernameValidation.normalized;

    if (confirmPassword !== undefined && password !== confirmPassword) {
      throw new Error('Password and confirm password do not match.');
    }

    const pwdCheck = validateStrongPassword(password, [normalizedUsername]);
    if (!pwdCheck.valid) {
      throw new Error(pwdCheck.error || 'Password does not meet security requirements.');
    }

    const cleanIdempotencyKey =
      typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
        ? sanitizeInputText(input.idempotencyKey, 128)
        : '';

    if (cleanIdempotencyKey) {
      try {
        db.prepare("DELETE FROM registration_idempotency WHERE datetime(expires_at) <= datetime('now')").run();
        const dupSubmission = db
          .prepare("SELECT user_id FROM registration_idempotency WHERE idempotency_key = ? AND datetime(expires_at) > datetime('now')")
          .get(cleanIdempotencyKey) as { user_id: string } | undefined;
        if (dupSubmission) {
          const dupErr: any = new Error('Duplicate signup submission detected. Please sign in or check your details.');
          dupErr.status = 409;
          dupErr.code = 'DUPLICATE_SUBMISSION';
          throw dupErr;
        }
      } catch (err: any) {
        if (err?.code === 'DUPLICATE_SUBMISSION') throw err;
      }
    }

    const existingHandle = db
      .prepare('SELECT id FROM user_profiles WHERE LOWER(handle) = LOWER(?)')
      .get(normalizedUsername);
    const existingUserHandle = db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)')
      .get(normalizedUsername);
    if (existingHandle || existingUserHandle) {
      const dupErr: any = new Error('This username is already taken. Please choose another.');
      dupErr.status = 409;
      dupErr.code = 'USERNAME_TAKEN';
      throw dupErr;
    }

    if (!bypassRegistrationLock) {
      recordRateLimitEvent(`reg:${ipAddress || 'unknown'}`, false, ipAddress);
    }

    const acceptedTermsAt = input.acceptTerms ? new Date().toISOString() : null;
    const acceptedTermsVersion = input.acceptTerms ? CURRENT_TERMS_VERSION : null;

    const userId = `u-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
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
        const recoveryCodes = generateRecoveryCodes(10);
        const matricNumber =
          sanitizeInputText(input.matric_number, 40) ||
          `MEMBER-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

        db.prepare(`
          INSERT INTO users (
            id, matric_number, email, phone_number, username, password_hash,
            role, status, is_verified, verification_code,
            accepted_terms_at, accepted_terms_version, last_reauthenticated_at,
            recovery_codes_generated_at, recovery_codes_remaining
          ) VALUES (?, ?, NULL, NULL, ?, ?, 'student', 'active', 0, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
        `).run(
          userId,
          matricNumber,
          normalizedUsername,
          passwordHash,
          acceptedTermsAt,
          acceptedTermsVersion,
          recoveryCodes.length
        );

        const insertRecovery = db.prepare(`
          INSERT INTO recovery_codes (id, user_id, code_salt, code_hash)
          VALUES (?, ?, ?, ?)
        `);
        for (const plainCode of recoveryCodes) {
          const normalizedCode = normalizeRecoveryCode(plainCode);
          const { salt, hash } = hashRecoveryCode(normalizedCode);
          insertRecovery.run(
            `rc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            userId,
            salt,
            hash
          );
        }

        if (cleanIdempotencyKey) {
          db.prepare(`
            INSERT INTO registration_idempotency (idempotency_key, user_id, expires_at)
            VALUES (?, ?, datetime('now', '+10 minutes'))
          `).run(cleanIdempotencyKey, userId);
        }

        const name = sanitizeInputText(input.name, 60) || normalizedUsername.replace('@', '');
        const initials =
          name
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

        const session = this.createSession(userId, ipAddress, input.userAgent, 'password');

        recordSecurityEvent({
          userId,
          eventType: 'ACCOUNT_REGISTERED',
          severity: 'info',
          identifier: normalizedUsername,
          ipAddress,
          userAgent: input.userAgent,
          deviceName: session.deviceName,
        });
        recordSecurityEvent({
          userId,
          eventType: 'RECOVERY_CODES_GENERATED',
          severity: 'info',
          identifier: normalizedUsername,
          ipAddress,
          userAgent: input.userAgent,
          details: { count: recoveryCodes.length },
        });

        return {
          user: {
            id: userId,
            matric_number: matricNumber,
            username: normalizedUsername,
            role: 'student',
            status: 'active',
            is_verified: false,
            acceptedTermsVersion,
            recoveryCodesRemaining: recoveryCodes.length,
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
          recoveryCodes, // Returned ONCE during registration
        };
      });
    } catch (err: any) {
      if (savedAvatar) {
        fileService.unlinkIfUnreferenced([
          ...fileService.extractUploadFilenames(savedAvatar.avatarUrl),
          ...fileService.extractUploadFilenames(savedAvatar.avatarThumbUrl),
        ]);
      }
      const msg = String(err?.message || '');
      if (msg.includes('UNIQUE constraint failed')) {
        if (msg.includes('username') || msg.includes('handle')) {
          const dup: any = new Error('This username is already taken. Please choose another.');
          dup.status = 409;
          throw dup;
        }
        if (msg.includes('idempotency_key')) {
          const dup: any = new Error('Duplicate signup submission detected. Please sign in or check your details.');
          dup.status = 409;
          throw dup;
        }
      }
      throw err;
    }
  },

  /**
   * Authenticate user strictly by @username + password (Argon2id with transparent scrypt->Argon2id upgrade).
   * Constant-timing dummy KDF on unknown username and generic errors prevent enumeration.
   */
  login(identifier: string, password: string, ipAddress?: string, userAgent?: string, mfaCode?: string) {
    if (!identifier || !password) {
      throw new Error('Please provide your @username and password.');
    }

    const trimmedId = identifier.trim().slice(0, 64);
    const handleCandidate = trimmedId.startsWith('@') ? trimmedId : `@${trimmedId}`;

    const rateLimit = this.getLoginRateLimitStatus(trimmedId, ipAddress);
    if (!rateLimit.allowed) {
      recordSecurityEvent({
        eventType: 'LOGIN_COOLDOWN_BLOCKED',
        severity: rateLimit.failureCount24h >= 8 ? 'high' : 'warning',
        identifier: trimmedId,
        ipAddress,
        userAgent,
        details: {
          scope: rateLimit.scope,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
          failureCount24h: rateLimit.failureCount24h,
        },
      });
      throw new AuthRateLimitError(
        `Too many failed login attempts. Try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minute(s).`,
        rateLimit.retryAfterSeconds
      );
    }

    if (typeof password !== 'string' || password.length > 128) {
      equalizePasswordTiming('invalid');
      this.recordLoginAttempt(trimmedId, false, ipAddress);
      recordSecurityEvent({
        eventType: 'LOGIN_FAILED',
        severity: 'warning',
        identifier: trimmedId,
        ipAddress,
        userAgent,
      });
      const err: any = new Error(GENERIC_LOGIN_ERROR);
      err.progressiveDelayMs = rateLimit.progressiveDelayMs;
      throw err;
    }

    const userRow: any = db.prepare(`
      SELECT u.*, pr.handle, pr.name
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE LOWER(COALESCE(u.username, '')) = LOWER(?)
         OR LOWER(COALESCE(u.username, '')) = LOWER(?)
         OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
         OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
      LIMIT 1
    `).get(trimmedId, handleCandidate, trimmedId, handleCandidate);

    if (!userRow) {
      equalizePasswordTiming(password);
      this.recordLoginAttempt(trimmedId, false, ipAddress);
      const updatedRl = this.getLoginRateLimitStatus(trimmedId, ipAddress);
      recordSecurityEvent({
        eventType: 'LOGIN_FAILED',
        severity: 'info',
        identifier: trimmedId,
        ipAddress,
        userAgent,
      });
      const err: any = new Error(GENERIC_LOGIN_ERROR);
      err.progressiveDelayMs = updatedRl.progressiveDelayMs;
      throw err;
    }

    if (!verifyPassword(password, userRow.password_hash)) {
      this.recordLoginAttempt(trimmedId, false, ipAddress, userRow.id);
      const updatedRl = this.getLoginRateLimitStatus(trimmedId, ipAddress);
      recordSecurityEvent({
        userId: userRow.id,
        eventType: 'LOGIN_FAILED',
        severity: 'warning',
        identifier: userRow.username || trimmedId,
        ipAddress,
        userAgent,
      });
      if (!updatedRl.allowed) {
        recordSecurityEvent({
          userId: userRow.id,
          eventType: 'FAILED_LOGIN_BURST',
          severity: 'high',
          identifier: userRow.username || trimmedId,
          ipAddress,
          userAgent,
          details: { failureCount24h: updatedRl.failureCount24h, scope: updatedRl.scope },
        });
        insertSecurityNotification(
          userRow.id,
          'Repeated Failed Sign-In Attempts',
          'Multiple incorrect password attempts were blocked on your account. If this was not you, change your password in Settings.'
        );
      }
      const err: any = new Error(GENERIC_LOGIN_ERROR);
      err.progressiveDelayMs = updatedRl.progressiveDelayMs;
      throw err;
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
        recordSecurityEvent({
          userId: userRow.id,
          eventType: 'PASSWORD_REHASHED_ARGON2ID',
          severity: 'info',
          identifier: userRow.username || trimmedId,
          ipAddress,
          userAgent,
        });
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
        this.recordLoginAttempt(trimmedId, false, ipAddress, userRow.id);
        recordSecurityEvent({
          userId: userRow.id,
          eventType: 'MFA_VERIFICATION_FAILED',
          severity: 'warning',
          identifier: userRow.username || trimmedId,
          ipAddress,
          userAgent,
        });
        throw new Error('Invalid 6-digit MFA authenticator code.');
      }
    }

    this.recordLoginAttempt(trimmedId, true, ipAddress, userRow.id);
    db.prepare('UPDATE users SET last_reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userRow.id);

    const session = this.createSession(userIdRow(userRow), ipAddress, userAgent, 'password');

    recordSecurityEvent({
      userId: userRow.id,
      eventType: 'LOGIN_SUCCESS',
      severity: 'info',
      identifier: userRow.username || userRow.handle,
      ipAddress,
      userAgent,
      deviceName: session.deviceName,
      details: { authMethod: 'password' },
    });

    return {
      user: {
        id: userRow.id,
        matric_number: userRow.matric_number,
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
   * - Supports concurrent active devices up to MAX_ACTIVE_DEVICES (5), evicting the oldest active device when exceeded.
   * - Issues short-lived 15-minute access token + rotating 30-day sliding refresh token with a 90-day hard session ceiling.
   * - Stores ONLY SHA-256 hashes in SQLite.
   */
  createSession(userId: string, ipAddress?: string, userAgent?: string, authMethod: 'password' | 'passkey' | 'recovery_code' = 'password') {
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
        expires_at, is_suspicious, auth_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)
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
      isSuspicious,
      authMethod
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

  refreshSession(rawRefreshToken: string, ipAddress?: string, userAgent?: string) {
    const cleanRefresh = String(rawRefreshToken || '').trim();
    if (!cleanRefresh) {
      throw new Error('Refresh token is required.');
    }

    const refreshHash = hashSessionToken(cleanRefresh);
    const row = db.prepare(`
      SELECT s.*, u.status, u.role, u.matric_number, u.username, u.accepted_terms_version
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
          expires_at, is_suspicious, auth_method, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)
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
        row.auth_method || 'password',
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
        username: row.username,
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
             u.id, u.matric_number, u.username, u.role, u.status, u.accepted_terms_version, u.last_reauthenticated_at
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
      username: row.username || undefined,
      role: row.role,
      status: row.status,
      acceptedTermsVersion: row.accepted_terms_version || null,
      lastReauthenticatedAt: row.last_reauthenticated_at || null,
    };
  },

  logout(token: string, ipAddress?: string) {
    if (token) {
      const tokenHash = hashSessionToken(token);
      const existing = db.prepare('SELECT id, user_id, device_name FROM sessions WHERE token = ? AND revoked_at IS NULL').get(tokenHash) as
        | { id: string | null; user_id: string; device_name: string | null }
        | undefined;
      db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'logout'
        WHERE token = ? AND revoked_at IS NULL
      `).run(tokenHash);
      if (existing) {
        recordSecurityEvent({
          userId: existing.user_id,
          eventType: 'USER_LOGOUT_SESSION',
          severity: 'info',
          ipAddress,
          deviceName: existing.device_name,
          details: { sessionId: existing.id },
        });
      }
    }
    return { success: true };
  },

  getUserSessions(userId: string, currentTokenHash?: string) {
    const rows = db.prepare(`
      SELECT id, token, device_name, device_type, ip_address, last_active_at, created_at, expires_at, refresh_expires_at, max_expires_at, is_suspicious, auth_method
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
      authMethod: r.auth_method || 'password',
      lastActiveAt: r.last_active_at || r.created_at,
      createdAt: r.created_at,
      expiresAt: r.refresh_expires_at || r.expires_at,
      maxExpiresAt: r.max_expires_at || null,
    }));
  },

  revokeUserSession(userId: string, sessionId: string, currentTokenHash?: string) {
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

    const revokedSelf = Boolean(currentTokenHash && target.token === currentTokenHash);

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
      details: { sessionId: cleanId, revokedSelf },
    });

    return { success: true, revokedSessionId: cleanId, revokedSelf };
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

  revokeAllUserSessions(userId: string, ipAddress?: string) {
    const res = db.prepare(`
      UPDATE sessions
      SET revoked_at = CURRENT_TIMESTAMP,
          revoked_reason = 'user_revoked_everywhere'
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(userId);

    const revokedCount = Number(res.changes || 0);
    recordSecurityEvent({
      userId,
      eventType: 'USER_REVOKED_ALL_SESSIONS',
      severity: 'info',
      ipAddress,
      details: { revokedCount },
    });

    return { success: true, revokedCount };
  },

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

  changePassword(userId: string, currentPassword: string, newPassword: string, currentTokenHash?: string, ipAddress?: string) {
    const bucketKey = `pwchange:${userId}`;
    if (!checkRateLimit(bucketKey, MAX_FAILED_ATTEMPTS, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many failed password change attempts. Please wait 15 minutes.', 900);
    }

    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE id = ?').get(userId) as
      | { id: string; username: string | null; password_hash: string }
      | undefined;
    if (!user) throw new Error('Account not found.');

    if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.length > 128 || !verifyPassword(currentPassword, user.password_hash)) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      throw new Error('Current password is incorrect.');
    }

    if (currentPassword === newPassword) {
      throw new Error('New password must differ from your current password.');
    }

    const pwdCheck = validateStrongPassword(newPassword, [user.username || '']);
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

  /**
   * Returns only the remaining unused recovery code count & generation timestamp — NEVER returns codes or hashes.
   */
  getRecoveryCodeStatus(userId: string): {
    remainingCount: number;
    totalCount: number;
    generatedAt: string | null;
    needsInitialSetup: boolean;
  } {
    const countRow = db
      .prepare('SELECT COUNT(*) as c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL')
      .get(userId) as { c: number } | undefined;
    const userRow = db
      .prepare('SELECT recovery_codes_generated_at FROM users WHERE id = ?')
      .get(userId) as { recovery_codes_generated_at: string | null } | undefined;

    const remainingCount = Number(countRow?.c ?? 0);
    const generatedAt = userRow?.recovery_codes_generated_at || null;
    return {
      remainingCount,
      totalCount: 10,
      generatedAt,
      needsInitialSetup: !generatedAt && remainingCount === 0,
    };
  },

  /**
   * Regenerates 10 fresh single-use recovery codes after verifying current password or recent step-up passkey re-auth.
   * Immediately invalidates all previous unused codes and returns plaintext codes ONCE.
   */
  regenerateRecoveryCodes(
    userId: string,
    currentPassword: string,
    ipAddress?: string,
    userAgent?: string,
    options?: { hasRecentReauth?: boolean; usePasskeyReauth?: boolean }
  ) {
    const bucketKey = `regen:${userId}`;
    if (!checkRateLimit(bucketKey, MAX_FAILED_ATTEMPTS, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many recovery code regeneration attempts. Please wait 15 minutes.', 900);
    }

    const user = db.prepare('SELECT id, username, password_hash, recovery_codes_generated_at FROM users WHERE id = ?').get(userId) as
      | { id: string; username: string | null; password_hash: string; recovery_codes_generated_at: string | null }
      | undefined;
    if (!user) {
      throw new Error('Account not found.');
    }

    const suppliedPassword = typeof currentPassword === 'string' && currentPassword.length > 0;
    if (suppliedPassword) {
      if (currentPassword.length > 128 || !verifyPassword(currentPassword, user.password_hash)) {
        recordRateLimitEvent(bucketKey, false, ipAddress);
        recordSecurityEvent({
          userId,
          eventType: 'RECOVERY_CODE_REGEN_FAILED',
          severity: 'warning',
          identifier: user.username,
          ipAddress,
          userAgent,
        });
        throw new Error('Incorrect password. Enter your current password to regenerate recovery codes.');
      }
    } else if (!options?.usePasskeyReauth || !options?.hasRecentReauth) {
      const err: any = new Error(
        'Please re-authenticate with your password or passkey before generating recovery codes.'
      );
      err.status = 403;
      err.code = 'REAUTH_REQUIRED';
      throw err;
    }

    recordRateLimitEvent(bucketKey, true, ipAddress);
    const plainCodes = generateRecoveryCodes(10);
    const generatedAt = new Date().toISOString();
    const isInitialGeneration = !user.recovery_codes_generated_at;

    return runInTransaction(() => {
      db.prepare(`
        UPDATE recovery_codes
        SET invalidated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL
      `).run(userId);

      const insertStmt = db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_salt, code_hash)
        VALUES (?, ?, ?, ?)
      `);
      for (const code of plainCodes) {
        const normalized = normalizeRecoveryCode(code);
        const { salt, hash } = hashRecoveryCode(normalized);
        insertStmt.run(
          `rc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          userId,
          salt,
          hash
        );
      }

      db.prepare(`
        UPDATE users
        SET recovery_codes_generated_at = ?,
            recovery_codes_remaining = ?,
            last_reauthenticated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(generatedAt, plainCodes.length, userId);

      recordSecurityEvent({
        userId,
        eventType: 'RECOVERY_CODES_REGENERATED',
        severity: 'info',
        identifier: user.username,
        ipAddress,
        userAgent,
        details: {
          count: plainCodes.length,
          isInitialGeneration,
          reauthMethod: suppliedPassword ? 'password' : 'passkey',
        },
      });

      insertSecurityNotification(
        userId,
        isInitialGeneration ? 'Recovery Codes Generated' : 'Recovery Codes Regenerated',
        isInitialGeneration
          ? 'Your 10 single-use recovery codes have been created. Store them safely offline.'
          : 'A fresh set of 10 single-use recovery codes was generated for your account. Any earlier unused codes are now invalid.'
      );

      return {
        success: true,
        recoveryCodes: plainCodes,
        remainingCount: plainCodes.length,
        totalCount: 10,
        generatedAt,
        needsInitialSetup: false,
      };
    });
  },

  /**
   * Returns recent sanitized security events exclusively for the signed-in user.
   * Never exposes credentials, tokens, hashes, or raw internal identifiers.
   */
  getUserSecurityEvents(userId: string, limit = 20) {
    const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const rows = db.prepare(`
      SELECT id, event_type, severity, ip_address, device_name, details_json, created_at
      FROM security_events
      WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(userId, safeLimit) as Array<{
      id: string;
      event_type: string;
      severity: string;
      ip_address: string | null;
      device_name: string | null;
      details_json: string | null;
      created_at: string;
    }>;

    const eventLabels: Record<string, string> = {
      ACCOUNT_REGISTERED: 'Account created',
      LOGIN_SUCCESS: 'Signed in',
      LOGIN_FAILED: 'Failed sign-in attempt',
      PASSKEY_ADDED: 'Passkey added',
      PASSKEY_REGISTERED: 'Passkey added',
      PASSKEY_REAUTHENTICATED: 'Passkey verified',
      PASSKEY_REMOVED: 'Passkey removed',
      PASSKEY_COUNTER_ANOMALY: 'Blocked suspicious passkey sign-in',
      PASSWORD_CHANGED: 'Password changed',
      PASSWORD_RESET_COMPLETED: 'Password reset completed',
      RECOVERY_CODE_USED: 'Single-use recovery code used',
      RECOVERY_CODES_REGENERATED: 'Recovery codes generated',
      RECOVERY_CODE_REGEN_FAILED: 'Failed recovery code generation attempt',
      RECOVERY_CODE_FAILED: 'Failed recovery code attempt',
      USER_REVOKED_SESSION: 'Signed out a device session',
      USER_REVOKED_OTHER_SESSIONS: 'Signed out all other devices',
      USER_REVOKED_ALL_SESSIONS: 'Signed out everywhere',
      MFA_ENABLED: 'Authenticator 2FA enabled',
      MFA_DISABLED: 'Authenticator 2FA disabled',
      ACCOUNT_LOCKED: 'Temporary sign-in protection triggered',
    };

    return rows.map((row) => {
      let parsedDetails: Record<string, unknown> = {};
      if (row.details_json) {
        try {
          parsedDetails = JSON.parse(row.details_json) || {};
        } catch {
          parsedDetails = {};
        }
      }

      const safeDetails: Record<string, string | number | boolean> = {};
      const allowedKeys = [
        'method',
        'reauthMethod',
        'revokedOtherSessions',
        'revokedSessions',
        'revokedCount',
        'remainingCodes',
        'isInitialGeneration',
        'evictedOldestDevice',
      ];
      for (const k of allowedKeys) {
        const val = parsedDetails[k];
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          safeDetails[k] = val;
        }
      }
      if (typeof parsedDetails.label === 'string') {
        safeDetails.label = sanitizeInputText(parsedDetails.label, 60);
      }

      let summary = eventLabels[row.event_type] || row.event_type.replace(/_/g, ' ').toLowerCase();
      if (row.event_type === 'LOGIN_SUCCESS' && safeDetails.method === 'passkey') {
        summary = 'Signed in with passkey';
      } else if (row.event_type === 'LOGIN_SUCCESS' && safeDetails.method === 'password') {
        summary = 'Signed in with password';
      } else if (row.event_type === 'PASSWORD_RESET_COMPLETED' && safeDetails.method === 'passkey') {
        summary = 'Password reset via passkey';
      } else if (row.event_type === 'PASSWORD_RESET_COMPLETED' && safeDetails.method === 'recovery_code') {
        summary = 'Password reset via recovery code';
      } else if (row.event_type === 'RECOVERY_CODES_REGENERATED' && safeDetails.isInitialGeneration === true) {
        summary = 'Initial 10 recovery codes generated';
      }

      return {
        id: row.id,
        eventType: row.event_type,
        severity: row.severity || 'info',
        summary,
        deviceName: row.device_name || null,
        ipAddress: row.ip_address || null,
        details: safeDetails,
        createdAt: row.created_at,
      };
    });
  },

  /**
   * Method A Password Reset: @username + one unused recovery code -> set new password.
   * - Username alone never allows a reset.
   * - Rate-limited per-IP and per-(account, IP).
   * - Identical generic response & constant-time work for unknown usernames vs invalid codes (zero enumeration).
   * - Immediately invalidates used code, revokes ALL active sessions, logs security events, and writes an in-app notice.
   */
  resetPasswordWithRecoveryCode(input: {
    username: string;
    recoveryCode: string;
    newPassword: string;
    confirmPassword?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const rawUsername = String(input.username || '').trim();
    const rawCode = String(input.recoveryCode || '').trim();
    const newPassword = String(input.newPassword || '');
    const confirmPassword = input.confirmPassword;
    const ipAddress = input.ipAddress;

    if (!rawUsername || !rawCode) {
      throw new Error('Username and recovery code are both required.');
    }

    const normalizedHandle = (rawUsername.startsWith('@') ? rawUsername : `@${rawUsername}`).toLowerCase();
    const ipBucket = `rec_ip:${ipAddress || 'unknown'}`;
    const pairBucket = `rec:${normalizedHandle}`;

    // Check per-IP limit first, then per-(account, IP)
    if (!checkRateLimit(ipBucket, MAX_RECOVERY_IP_ATTEMPTS_PER_15M, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      recordSecurityEvent({
        eventType: 'RECOVERY_RATE_LIMITED',
        severity: 'warning',
        identifier: normalizedHandle,
        ipAddress,
        userAgent: input.userAgent,
        details: { scope: 'ip' },
      });
      throw new AuthRateLimitError('Too many recovery attempts from this network. Please wait 15 minutes before trying again.', 900);
    }
    if (!checkRateLimit(pairBucket, MAX_RECOVERY_ATTEMPTS_PER_15M, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      recordSecurityEvent({
        eventType: 'RECOVERY_RATE_LIMITED',
        severity: 'warning',
        identifier: normalizedHandle,
        ipAddress,
        userAgent: input.userAgent,
        details: { scope: 'account_pair' },
      });
      throw new AuthRateLimitError('Too many failed recovery attempts. Please wait 15 minutes before trying again.', 900);
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      throw new Error('New password and confirmation password do not match.');
    }

    const pwdCheck = validateStrongPassword(newPassword, [normalizedHandle]);
    if (!pwdCheck.valid) {
      throw new Error(pwdCheck.error || 'New password does not meet security requirements.');
    }

    const normalizedCode = normalizeRecoveryCode(rawCode);
    const user = db.prepare(`
      SELECT u.id, u.username, u.status, pr.handle
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE LOWER(COALESCE(u.username, '')) = ?
         OR LOWER(COALESCE(pr.handle, '')) = ?
      LIMIT 1
    `).get(normalizedHandle, normalizedHandle) as
      | { id: string; username: string | null; status: string; handle: string | null }
      | undefined;

    if (!user || !normalizedCode || normalizedCode.length < 8) {
      equalizeRecoveryTiming(normalizedCode);
      equalizePasswordTiming(newPassword);
      recordRateLimitEvent(ipBucket, false, ipAddress);
      recordRateLimitEvent(pairBucket, false, ipAddress);
      recordSecurityEvent({
        eventType: 'RECOVERY_CODE_FAILED',
        severity: 'warning',
        identifier: normalizedHandle,
        ipAddress,
        userAgent: input.userAgent,
      });
      throw new Error(GENERIC_RECOVERY_ERROR);
    }

    const activeCodes = db.prepare(`
      SELECT id, code_salt, code_hash
      FROM recovery_codes
      WHERE user_id = ?
        AND used_at IS NULL
        AND invalidated_at IS NULL
      ORDER BY created_at ASC
    `).all(user.id) as Array<{ id: string; code_salt: string; code_hash: string }>;

    // Check all active hashes without early return to equalize timing
    let matchedRowId: string | null = null;
    for (const row of activeCodes) {
      const ok = verifyRecoveryCodeHash(normalizedCode, row.code_salt, row.code_hash);
      if (ok && !matchedRowId) {
        matchedRowId = row.id;
      }
    }

    if (!matchedRowId) {
      // Pad constant-time work when account has fewer than 10 codes remaining
      for (let i = activeCodes.length; i < 10; i++) {
        verifyRecoveryCodeHash(normalizedCode, DUMMY_RECOVERY_SALT, DUMMY_RECOVERY_HASH);
      }
      equalizePasswordTiming(newPassword);
      recordRateLimitEvent(ipBucket, false, ipAddress);
      recordRateLimitEvent(pairBucket, false, ipAddress);
      recordSecurityEvent({
        userId: user.id,
        eventType: 'RECOVERY_CODE_FAILED',
        severity: 'warning',
        identifier: user.username || normalizedHandle,
        ipAddress,
        userAgent: input.userAgent,
      });
      throw new Error(GENERIC_RECOVERY_ERROR);
    }

    if (user.status === 'suspended') {
      throw new Error('This account has been suspended by moderation.');
    }

    return runInTransaction(() => {
      const consumeRes = db.prepare(`
        UPDATE recovery_codes
        SET used_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND used_at IS NULL AND invalidated_at IS NULL
      `).run(matchedRowId, user.id);

      if (Number(consumeRes.changes || 0) !== 1) {
        throw new Error(GENERIC_RECOVERY_ERROR);
      }

      const passwordHash = hashPassword(newPassword);
      const remainingRow = db
        .prepare('SELECT COUNT(*) as c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL')
        .get(user.id) as { c: number } | undefined;
      const remainingCount = Number(remainingRow?.c ?? 0);

      db.prepare(`
        UPDATE users
        SET password_hash = ?,
            recovery_codes_remaining = ?,
            last_reauthenticated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(passwordHash, remainingCount, user.id);

      const revokedRes = db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'password_reset_recovery_code'
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(user.id);

      db.prepare('DELETE FROM account_lockouts WHERE user_id = ?').run(user.id);

      recordRateLimitEvent(ipBucket, true, ipAddress);
      recordRateLimitEvent(pairBucket, true, ipAddress);

      recordSecurityEvent({
        userId: user.id,
        eventType: 'RECOVERY_CODE_USED',
        severity: 'warning',
        identifier: user.username || normalizedHandle,
        ipAddress,
        userAgent: input.userAgent,
        details: { remainingCodes: remainingCount },
      });
      recordSecurityEvent({
        userId: user.id,
        eventType: 'PASSWORD_RESET_COMPLETED',
        severity: 'warning',
        identifier: user.username || normalizedHandle,
        ipAddress,
        userAgent: input.userAgent,
        details: { method: 'recovery_code', revokedSessions: Number(revokedRes.changes || 0) },
      });

      insertSecurityNotification(
        user.id,
        'Password Changed via Recovery Code',
        `A single-use recovery code was used to reset your password and all ${Number(revokedRes.changes || 0)} active session(s) were signed out. You have ${remainingCount} unused recovery code(s) left.`
      );

      return {
        success: true,
        message: 'Your password has been updated and all active sessions have been signed out. Please sign in with your new password.',
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

  getFirstRunAdminSetupStatus() {
    if ((process.env.ADMIN_PASSWORD || process.env.SCHOOLBACKDOOR_ADMIN_PASSWORD || '').trim()) {
      return { adminNeedsSetup: false };
    }
    const adminRow = db
      .prepare("SELECT password_hash FROM users WHERE id = 'u-admin' OR role = 'admin' LIMIT 1")
      .get() as { password_hash?: string | null } | undefined;
    const needsSetup = Boolean(adminRow && (!adminRow.password_hash || adminRow.password_hash === UNCLAIMED_CREDENTIAL_SENTINEL));
    return { adminNeedsSetup: needsSetup };
  },

  claimFirstRunAdminPassword(password: string, confirmPassword?: string, ipAddress?: string, userAgent?: string) {
    if ((process.env.ADMIN_PASSWORD || process.env.SCHOOLBACKDOOR_ADMIN_PASSWORD || '').trim()) {
      const err: any = new Error('Admin credentials are already managed via server environment configuration.');
      err.status = 409;
      throw err;
    }
    if (typeof password !== 'string' || !password) {
      throw new Error('Admin password is required.');
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      throw new Error('Password confirmation does not match.');
    }

    const adminRow = db
      .prepare("SELECT id, username, password_hash FROM users WHERE id = 'u-admin' OR role = 'admin' LIMIT 1")
      .get() as { id: string; username: string | null; password_hash: string | null } | undefined;

    if (!adminRow || (adminRow.password_hash && adminRow.password_hash !== UNCLAIMED_CREDENTIAL_SENTINEL)) {
      const err: any = new Error('Admin setup has already been completed.');
      err.status = 409;
      throw err;
    }

    const pwCheck = validateStrongPassword(password, [adminRow.username || 'THEBACKDOOR']);
    if (!pwCheck.valid) {
      throw new Error(pwCheck.error);
    }

    const newHash = hashPassword(password);
    const plainCodes = generateRecoveryCodes(10);
    const nowIso = new Date().toISOString();

    const claimed = runInTransaction(() => {
      const res = db.prepare(`
        UPDATE users
        SET password_hash = ?,
            accepted_terms_version = COALESCE(accepted_terms_version, ?),
            accepted_terms_at = COALESCE(accepted_terms_at, CURRENT_TIMESTAMP),
            recovery_codes_generated_at = ?,
            recovery_codes_remaining = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND (password_hash IS NULL OR password_hash = ?)
      `).run(newHash, CURRENT_TERMS_VERSION, nowIso, plainCodes.length, adminRow.id, UNCLAIMED_CREDENTIAL_SENTINEL);

      if (!res.changes) {
        return false;
      }

      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(adminRow.id);
      const insertCode = db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_salt, code_hash)
        VALUES (?, ?, ?, ?)
      `);
      for (const code of plainCodes) {
        const normalized = normalizeRecoveryCode(code);
        const { salt, hash } = hashRecoveryCode(normalized);
        insertCode.run(
          `rc-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
          adminRow.id,
          salt,
          hash
        );
      }
      return true;
    });

    if (!claimed) {
      const err: any = new Error('Admin setup has already been completed.');
      err.status = 409;
      throw err;
    }

    recordSecurityEvent({
      userId: adminRow.id,
      eventType: 'ADMIN_FIRST_RUN_CLAIMED',
      severity: 'warning',
      identifier: adminRow.username || '@THEBACKDOOR',
      ipAddress,
      userAgent,
    });

    return {
      success: true,
      username: adminRow.username || '@THEBACKDOOR',
      recoveryCodes: plainCodes,
      message: 'Admin account provisioned! Save these 10 single-use recovery codes now.',
    };
  },
};

function userIdRow(row: { id: string }): string {
  return row.id;
}

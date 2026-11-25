import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { db, runInTransaction } from '../db/database.js';
import { parseTimestampMs } from '../middleware/auth.js';
import { AuthRateLimitError, authService } from './authService.js';
import {
  checkRateLimit,
  hashPassword,
  hashSessionToken,
  parseDeviceFromUserAgent,
  recordRateLimitEvent,
  recordSecurityEvent,
  sanitizeInputText,
  validateStrongPassword,
} from '../utils/security.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PASSKEY_RECOVERY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PASSKEYS_PER_USER = 15;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSKEY_AUTH_ATTEMPTS_PER_15M = 15;
const MAX_PASSKEY_RECOVERY_ATTEMPTS_PER_15M = 8;

export type WebAuthnChallengePurpose = 'registration' | 'login' | 'recovery' | 'reauth';

export interface PasskeySummary {
  id: string;
  label: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

function isValidHttpUrlOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'MY_APP_URL') return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function getWebAuthnConfig(): {
  rpID: string;
  rpName: string;
  allowedOrigins: string[];
  isProduction: boolean;
} {
  const isProduction = process.env.NODE_ENV === 'production';
  const rpName = sanitizeInputText(process.env.WEBAUTHN_RP_NAME || 'Schoolbackdoor', 64) || 'Schoolbackdoor';

  const explicitOrigins = (process.env.WEBAUTHN_ORIGINS || '')
    .split(',')
    .map(isValidHttpUrlOrigin)
    .filter((v): v is string => Boolean(v));

  const appOrigin = process.env.APP_URL ? isValidHttpUrlOrigin(process.env.APP_URL) : null;
  const vercelOrigin = process.env.VERCEL_URL ? isValidHttpUrlOrigin(`https://${process.env.VERCEL_URL.trim()}`) : null;

  const originSet = new Set<string>(explicitOrigins);
  if (appOrigin) originSet.add(appOrigin);
  if (vercelOrigin) originSet.add(vercelOrigin);

  // Allow localhost origins ONLY in non-production development environments
  if (!isProduction) {
    originSet.add('http://localhost:3000');
    originSet.add('https://localhost:3000');
    originSet.add('http://127.0.0.1:3000');
    originSet.add('http://localhost:5173');
  }

  let rpID = (process.env.WEBAUTHN_RP_ID || '').trim().toLowerCase();
  if (!rpID && appOrigin) {
    rpID = new URL(appOrigin).hostname.toLowerCase();
  }
  if (!rpID && vercelOrigin) {
    rpID = new URL(vercelOrigin).hostname.toLowerCase();
  }
  if (!rpID && !isProduction) {
    rpID = 'localhost';
  }
  if (!rpID) {
    const err: any = new Error('WebAuthn is not configured: WEBAUTHN_RP_ID is required in production.');
    err.status = 500;
    throw err;
  }

  if (originSet.size === 0) {
    const err: any = new Error('WebAuthn is not configured: WEBAUTHN_ORIGINS is required in production.');
    err.status = 500;
    throw err;
  }

  return {
    rpID,
    rpName,
    allowedOrigins: Array.from(originSet),
    isProduction,
  };
}

function decodeClientChallenge(response: { response?: { clientDataJSON?: string } } | undefined): string {
  const b64 = response?.response?.clientDataJSON;
  if (!b64 || typeof b64 !== 'string' || b64.length > 4096) {
    const err: any = new Error('Invalid passkey response payload.');
    err.status = 400;
    throw err;
  }
  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as { challenge?: unknown };
    if (typeof parsed?.challenge !== 'string' || parsed.challenge.length < 16 || parsed.challenge.length > 512) {
      throw new Error('Malformed challenge');
    }
    return parsed.challenge;
  } catch {
    const err: any = new Error('Invalid WebAuthn client data.');
    err.status = 400;
    throw err;
  }
}

function purgeExpiredChallenges() {
  try {
    db.prepare("DELETE FROM webauthn_challenges WHERE datetime(expires_at) <= datetime('now') OR used_at IS NOT NULL").run();
    db.prepare("DELETE FROM passkey_recovery_tokens WHERE datetime(expires_at) <= datetime('now') OR used_at IS NOT NULL").run();
  } catch {
    // Non-fatal cleanup
  }
}

function insertPasskeyNotification(userId: string, title: string, body: string) {
  try {
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link)
      VALUES (?, ?, 'system', ?, ?, '/?tab=settings')
    `).run(`notif-pk-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, userId, title, body);
  } catch {
    // Non-fatal
  }
}

function parseTransports(rawJson: string | null | undefined): AuthenticatorTransport[] | undefined {
  if (!rawJson) return undefined;
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((t): t is AuthenticatorTransport => typeof t === 'string' && t.length > 0 && t.length <= 32);
  } catch {
    return undefined;
  }
}

function buildCredentialUserId(userId: string): Uint8Array<ArrayBuffer> {
  const digest = crypto.createHash('sha256').update(`sb-webauthn-uid:${userId}`, 'utf8').digest();
  const ab = new ArrayBuffer(digest.length);
  const out = new Uint8Array(ab);
  out.set(digest);
  return out;
}

function toWebAuthnPublicKeyBytes(base64urlKey: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(base64urlKey, 'base64url');
  const ab = new ArrayBuffer(buf.length);
  const out = new Uint8Array(ab);
  out.set(buf);
  return out;
}

export const passkeyService = {
  /**
   * Lists registered passkeys for the signed-in user (never exposes public_key or biometrics).
   */
  listPasskeys(userId: string): PasskeySummary[] {
    const rows = db.prepare(`
      SELECT id, label, device_type, backed_up, transports_json, created_at, last_used_at
      FROM webauthn_credentials
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId) as Array<{
      id: string;
      label: string;
      device_type: string | null;
      backed_up: number;
      transports_json: string | null;
      created_at: string;
      last_used_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      label: row.label || 'Passkey',
      deviceType: row.device_type || 'multiDevice',
      backedUp: Boolean(row.backed_up),
      transports: parseTransports(row.transports_json) || [],
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || null,
    }));
  },

  /**
   * Generates WebAuthn registration options for an authenticated user and persists a single-use challenge.
   */
  async createRegistrationOptions(userId: string, ipAddress?: string, userAgent?: string) {
    const bucketKey = `pk_reg_opts:${userId}`;
    if (!checkRateLimit(bucketKey, 20, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many passkey setup requests. Please wait 15 minutes.', 900);
    }
    recordRateLimitEvent(bucketKey, false, ipAddress);
    purgeExpiredChallenges();

    const userRow = db.prepare(`
      SELECT u.id, u.username, u.status, pr.handle, pr.name
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE u.id = ?
      LIMIT 1
    `).get(userId) as { id: string; username: string | null; status: string; handle: string | null; name: string | null } | undefined;

    if (!userRow || userRow.status === 'suspended') {
      const err: any = new Error('Account cannot register a passkey right now.');
      err.status = 403;
      throw err;
    }

    const existing = db.prepare(`
      SELECT credential_id, transports_json
      FROM webauthn_credentials
      WHERE user_id = ?
    `).all(userId) as Array<{ credential_id: string; transports_json: string | null }>;

    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      const err: any = new Error(`You can register up to ${MAX_PASSKEYS_PER_USER} passkeys per account. Remove an old passkey first.`);
      err.status = 400;
      throw err;
    }

    const config = getWebAuthnConfig();
    const userName = userRow.username || userRow.handle || `user_${userRow.id.slice(0, 8)}`;
    const userDisplayName = userRow.name || userName;

    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName,
      userID: buildCredentialUserId(userRow.id),
      userDisplayName,
      timeout: 60_000,
      attestationType: 'none',
      excludeCredentials: existing.map((cred) => ({
        id: cred.credential_id,
        transports: parseTransports(cred.transports_json),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    const challengeId = `pkc-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    db.prepare(`
      INSERT INTO webauthn_challenges (id, user_id, challenge, ceremony_type, purpose, rp_id, expires_at)
      VALUES (?, ?, ?, 'registration', 'registration', ?, ?)
    `).run(challengeId, userId, options.challenge, config.rpID, expiresAt);

    recordRateLimitEvent(bucketKey, true, ipAddress);
    return options;
  },

  /**
   * Verifies registration attestation response, deletes the single-use challenge, and stores credential metadata ONLY.
   */
  async verifyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    label?: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ verified: boolean; passkey: PasskeySummary }> {
    const bucketKey = `pk_reg_ver:${userId}`;
    if (!checkRateLimit(bucketKey, 15, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many passkey verification attempts. Please wait 15 minutes.', 900);
    }

    const clientChallenge = decodeClientChallenge(response);
    const challengeRow = db.prepare(`
      SELECT id, user_id, challenge, rp_id, expires_at
      FROM webauthn_challenges
      WHERE challenge = ?
        AND ceremony_type = 'registration'
        AND purpose = 'registration'
        AND user_id = ?
      LIMIT 1
    `).get(clientChallenge, userId) as
      | { id: string; user_id: string; challenge: string; rp_id: string; expires_at: string }
      | undefined;

    if (!challengeRow) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      const err: any = new Error('Passkey registration challenge expired or already used. Please try again.');
      err.status = 400;
      throw err;
    }

    if (parseTimestampMs(challengeRow.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(challengeRow.id);
      recordRateLimitEvent(bucketKey, false, ipAddress);
      const err: any = new Error('Passkey registration timed out. Please start again.');
      err.status = 400;
      throw err;
    }

    const config = getWebAuthnConfig();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: config.allowedOrigins,
        expectedRPID: challengeRow.rp_id || config.rpID,
        requireUserPresence: true,
        requireUserVerification: false,
      });
    } catch (verifyErr: any) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      recordSecurityEvent({
        userId,
        eventType: 'PASSKEY_REGISTRATION_FAILED',
        severity: 'warning',
        ipAddress,
        userAgent,
        details: { reason: sanitizeInputText(verifyErr?.message || 'verification_error', 120) },
      });
      const err: any = new Error('Unable to verify passkey registration. Check your domain or try another device.');
      err.status = 400;
      throw err;
    }

    if (!verification.verified || !verification.registrationInfo) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      const err: any = new Error('Passkey verification could not be completed.');
      err.status = 400;
      throw err;
    }

    const { registrationInfo } = verification;
    const { credential, credentialDeviceType, credentialBackedUp, aaguid } = registrationInfo;
    const parsedUa = parseDeviceFromUserAgent(userAgent);
    const cleanLabel = sanitizeInputText(label, 60) || `${parsedUa.deviceName} Passkey`;
    const transports = Array.isArray(credential.transports)
      ? credential.transports.filter((t) => typeof t === 'string')
      : Array.isArray(response?.response?.transports)
        ? response.response.transports.filter((t) => typeof t === 'string')
        : [];
    const publicKeyBase64Url = Buffer.from(credential.publicKey).toString('base64url');
    const passkeyId = `pk-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    return runInTransaction(() => {
      // Strictly delete single-use challenge atomically to prevent replay races
      const delRes = db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(challengeRow.id);
      if (Number(delRes.changes || 0) !== 1) {
        const err: any = new Error('Passkey registration challenge was already consumed.');
        err.status = 400;
        throw err;
      }

      const duplicateCred = db
        .prepare('SELECT id FROM webauthn_credentials WHERE credential_id = ? LIMIT 1')
        .get(credential.id);
      if (duplicateCred) {
        const err: any = new Error('This passkey is already registered.');
        err.status = 409;
        throw err;
      }

      const countRow = db
        .prepare('SELECT COUNT(*) as c FROM webauthn_credentials WHERE user_id = ?')
        .get(userId) as { c: number } | undefined;
      if (Number(countRow?.c || 0) >= MAX_PASSKEYS_PER_USER) {
        const err: any = new Error(`Maximum of ${MAX_PASSKEYS_PER_USER} passkeys reached.`);
        err.status = 400;
        throw err;
      }

      db.prepare(`
        INSERT INTO webauthn_credentials (
          id, user_id, credential_id, public_key, counter, transports_json,
          device_type, backed_up, aaguid, label, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        passkeyId,
        userId,
        credential.id,
        publicKeyBase64Url,
        Number(credential.counter || 0),
        JSON.stringify(transports),
        credentialDeviceType || 'multiDevice',
        credentialBackedUp ? 1 : 0,
        aaguid || null,
        cleanLabel
      );

      db.prepare('UPDATE users SET last_reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
      recordRateLimitEvent(bucketKey, true, ipAddress);

      recordSecurityEvent({
        userId,
        eventType: 'PASSKEY_REGISTERED',
        severity: 'info',
        ipAddress,
        userAgent,
        deviceName: parsedUa.deviceName,
        details: {
          label: cleanLabel,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
      });

      insertPasskeyNotification(
        userId,
        'New Passkey Added',
        `A passkey ("${cleanLabel}") was added to your account from ${parsedUa.deviceName}.`
      );

      const createdRow = db.prepare(`
        SELECT id, label, device_type, backed_up, transports_json, created_at, last_used_at
        FROM webauthn_credentials WHERE id = ?
      `).get(passkeyId) as any;

      return {
        verified: true,
        passkey: {
          id: createdRow.id,
          label: createdRow.label,
          deviceType: createdRow.device_type || 'multiDevice',
          backedUp: Boolean(createdRow.backed_up),
          transports: parseTransports(createdRow.transports_json) || [],
          createdAt: createdRow.created_at,
          lastUsedAt: createdRow.last_used_at || null,
        },
      };
    });
  },

  /**
   * Issues WebAuthn authentication options for login, Method B recovery, or step-up re-authentication.
   * Supports discoverable credentials (username-less) when username is omitted.
   */
  async createAuthenticationOptions(optionsInput: {
    purpose: 'login' | 'recovery' | 'reauth';
    username?: string;
    userId?: string;
    ipAddress?: string;
  }) {
    const bucketKey = `pk_auth_opts:${optionsInput.purpose}:${optionsInput.ipAddress || 'unknown'}`;
    if (!checkRateLimit(bucketKey, 30, RATE_LIMIT_WINDOW_MS, optionsInput.ipAddress)) {
      throw new AuthRateLimitError('Too many passkey requests. Please wait 15 minutes before trying again.', 900);
    }
    recordRateLimitEvent(bucketKey, false, optionsInput.ipAddress);
    purgeExpiredChallenges();

    const config = getWebAuthnConfig();
    let allowCredentials: Array<{ id: string; transports?: AuthenticatorTransport[] }> | undefined;
    let scopedUserId: string | null = null;

    if (optionsInput.purpose === 'reauth' && optionsInput.userId) {
      scopedUserId = optionsInput.userId;
      const creds = db.prepare(`
        SELECT credential_id, transports_json
        FROM webauthn_credentials
        WHERE user_id = ?
      `).all(optionsInput.userId) as Array<{ credential_id: string; transports_json: string | null }>;

      if (creds.length === 0) {
        const err: any = new Error('No passkeys are registered on this account yet.');
        err.status = 400;
        throw err;
      }
      allowCredentials = creds.map((c) => ({
        id: c.credential_id,
        transports: parseTransports(c.transports_json),
      }));
    } else if (optionsInput.username && optionsInput.username.trim()) {
      const trimmed = optionsInput.username.trim();
      const withAt = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
      const matchedUser = db.prepare(`
        SELECT u.id
        FROM users u
        LEFT JOIN user_profiles pr ON pr.user_id = u.id
        WHERE LOWER(COALESCE(u.username, '')) IN (LOWER(?), LOWER(?))
           OR LOWER(COALESCE(pr.handle, '')) IN (LOWER(?), LOWER(?))
        LIMIT 1
      `).get(trimmed, withAt, trimmed, withAt) as { id: string } | undefined;

      // Only narrow allowCredentials when the account actually has passkeys;
      // otherwise leave undefined so unknown usernames cannot be enumerated.
      if (matchedUser) {
        const creds = db.prepare(`
          SELECT credential_id, transports_json
          FROM webauthn_credentials
          WHERE user_id = ?
        `).all(matchedUser.id) as Array<{ credential_id: string; transports_json: string | null }>;
        if (creds.length > 0) {
          allowCredentials = creds.map((c) => ({
            id: c.credential_id,
            transports: parseTransports(c.transports_json),
          }));
        }
      }
    }

    const requestOptions = await generateAuthenticationOptions({
      rpID: config.rpID,
      timeout: 60_000,
      userVerification: 'preferred',
      ...(allowCredentials ? { allowCredentials } : {}),
    });

    const challengeId = `pkc-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

    db.prepare(`
      INSERT INTO webauthn_challenges (id, user_id, challenge, ceremony_type, purpose, rp_id, expires_at)
      VALUES (?, ?, ?, 'authentication', ?, ?, ?)
    `).run(challengeId, scopedUserId, requestOptions.challenge, optionsInput.purpose, config.rpID, expiresAt);

    recordRateLimitEvent(bucketKey, true, optionsInput.ipAddress);
    return requestOptions;
  },

  /**
   * Shared cryptographic assertion verification + single-use challenge deletion + counter protection.
   */
  async verifyAssertionInternal(params: {
    purpose: 'login' | 'recovery' | 'reauth';
    response: AuthenticationResponseJSON;
    expectedUserId?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const clientChallenge = decodeClientChallenge(params.response);
    const challengeRow = db.prepare(`
      SELECT id, user_id, challenge, rp_id, expires_at
      FROM webauthn_challenges
      WHERE challenge = ?
        AND ceremony_type = 'authentication'
        AND purpose = ?
      LIMIT 1
    `).get(clientChallenge, params.purpose) as
      | { id: string; user_id: string | null; challenge: string; rp_id: string; expires_at: string }
      | undefined;

    if (!challengeRow) {
      const err: any = new Error('Passkey challenge expired or was already used. Please try again.');
      err.status = 400;
      throw err;
    }

    if (params.expectedUserId && challengeRow.user_id && challengeRow.user_id !== params.expectedUserId) {
      const err: any = new Error('Passkey challenge does not match this account.');
      err.status = 403;
      throw err;
    }

    if (parseTimestampMs(challengeRow.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(challengeRow.id);
      const err: any = new Error('Passkey verification timed out. Please try again.');
      err.status = 400;
      throw err;
    }

    const credentialId = String(params.response?.id || '').trim();
    if (!credentialId) {
      const err: any = new Error('Missing passkey credential identifier.');
      err.status = 400;
      throw err;
    }

    const credRow = db.prepare(`
      SELECT wc.*, u.id as u_id, u.matric_number, u.username, u.role, u.status, u.is_verified,
             u.accepted_terms_version, pr.handle, pr.name
      FROM webauthn_credentials wc
      JOIN users u ON u.id = wc.user_id
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE wc.credential_id = ?
      LIMIT 1
    `).get(credentialId) as any;

    if (!credRow) {
      const err: any = new Error('No matching passkey was found on Schoolbackdoor. Sign in with your @username and password instead.');
      err.status = 401;
      throw err;
    }

    if (params.expectedUserId && credRow.user_id !== params.expectedUserId) {
      const err: any = new Error('This passkey belongs to a different account.');
      err.status = 403;
      throw err;
    }

    if (credRow.status === 'suspended') {
      const err: any = new Error('This account has been suspended by moderation.');
      err.status = 403;
      throw err;
    }

    const config = getWebAuthnConfig();
    const requireUV = credRow.role === 'admin' || credRow.role === 'moderator';

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: params.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: config.allowedOrigins,
        expectedRPID: challengeRow.rp_id || config.rpID,
        credential: {
          id: credRow.credential_id,
          publicKey: toWebAuthnPublicKeyBytes(credRow.public_key),
          counter: Number(credRow.counter || 0),
          transports: parseTransports(credRow.transports_json),
        },
        requireUserVerification: requireUV,
      });
    } catch (verifyErr: any) {
      const errMsg = String(verifyErr?.message || '');
      if (/counter value .* lower than expected/i.test(errMsg)) {
        db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(challengeRow.id);
        recordSecurityEvent({
          userId: credRow.user_id,
          eventType: 'PASSKEY_COUNTER_ANOMALY',
          severity: 'high',
          identifier: credRow.username || credRow.handle,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          details: { storedCounter: Number(credRow.counter || 0), label: credRow.label },
        });
        insertPasskeyNotification(
          credRow.user_id,
          'Security Alert: Passkey Sign-In Blocked',
          `A passkey ("${credRow.label}") reported an out-of-order signature counter and was blocked to protect your account.`
        );
        const err: any = new Error('Passkey signature counter anomaly detected. Sign in with your password and review your passkeys in Settings.');
        err.status = 401;
        throw err;
      }

      recordSecurityEvent({
        userId: credRow.user_id,
        eventType: 'PASSKEY_AUTH_FAILED',
        severity: 'warning',
        identifier: credRow.username || credRow.handle,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        details: {
          purpose: params.purpose,
          reason: sanitizeInputText(errMsg || 'signature_check_failed', 120),
        },
      });
      const err: any = new Error('Passkey verification failed. Please try again or use your password.');
      err.status = 401;
      throw err;
    }

    if (!verification.verified) {
      const err: any = new Error('Passkey verification failed.');
      err.status = 401;
      throw err;
    }

    const storedCounter = Number(credRow.counter || 0);
    const newCounter = Number(verification.authenticationInfo.newCounter || 0);

    // WebAuthn §7.2 counter check: if authenticator tracks a counter (>0), counter must strictly increase.
    if ((storedCounter > 0 || newCounter > 0) && newCounter <= storedCounter) {
      db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(challengeRow.id);
      recordSecurityEvent({
        userId: credRow.user_id,
        eventType: 'PASSKEY_COUNTER_ANOMALY',
        severity: 'high',
        identifier: credRow.username || credRow.handle,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        details: { storedCounter, newCounter, label: credRow.label },
      });
      insertPasskeyNotification(
        credRow.user_id,
        'Security Alert: Passkey Sign-In Blocked',
        `A passkey ("${credRow.label}") reported an out-of-order signature counter and was blocked to protect your account.`
      );
      const err: any = new Error('Passkey signature counter anomaly detected. Sign in with your password and review your passkeys in Settings.');
      err.status = 401;
      throw err;
    }

    return runInTransaction(() => {
      // Strictly delete single-use challenge inside transaction
      const delRes = db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(challengeRow.id);
      if (Number(delRes.changes || 0) !== 1) {
        const err: any = new Error('Passkey challenge has already been consumed.');
        err.status = 400;
        throw err;
      }

      db.prepare(`
        UPDATE webauthn_credentials
        SET counter = ?,
            device_type = COALESCE(?, device_type),
            backed_up = ?,
            last_used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        newCounter,
        verification.authenticationInfo.credentialDeviceType || credRow.device_type,
        verification.authenticationInfo.credentialBackedUp ? 1 : Number(credRow.backed_up || 0),
        credRow.id
      );

      db.prepare('UPDATE users SET last_reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ?').run(credRow.user_id);

      return {
        credRow,
        verification,
      };
    });
  },

  /**
   * Verifies a passkey login assertion and creates a standard multi-device session (5-device limit + cookies + security logs).
   */
  async verifyLogin(response: AuthenticationResponseJSON, ipAddress?: string, userAgent?: string) {
    const ipBucket = `pk_login_ip:${ipAddress || 'unknown'}`;
    if (!checkRateLimit(ipBucket, MAX_PASSKEY_AUTH_ATTEMPTS_PER_15M, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many passkey login attempts. Please wait 15 minutes before trying again.', 900);
    }

    try {
      const { credRow } = await this.verifyAssertionInternal({
        purpose: 'login',
        response,
        ipAddress,
        userAgent,
      });

      recordRateLimitEvent(ipBucket, true, ipAddress);
      const session = authService.createSession(credRow.user_id, ipAddress, userAgent, 'passkey');

      recordSecurityEvent({
        userId: credRow.user_id,
        eventType: 'LOGIN_SUCCESS',
        severity: 'info',
        identifier: credRow.username || credRow.handle,
        ipAddress,
        userAgent,
        deviceName: session.deviceName,
        details: { authMethod: 'passkey', passkeyLabel: credRow.label },
      });

      return {
        user: {
          id: credRow.user_id,
          matric_number: credRow.matric_number,
          username: credRow.username || credRow.handle,
          role: credRow.role,
          status: credRow.status,
          is_verified: Boolean(credRow.is_verified),
          acceptedTermsVersion: credRow.accepted_terms_version || null,
        },
        token: session.token,
        refreshToken: session.refreshToken,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        deviceName: session.deviceName,
        deviceType: session.deviceType,
      };
    } catch (err) {
      recordRateLimitEvent(ipBucket, false, ipAddress);
      throw err;
    }
  },

  /**
   * Step-up re-authentication using an existing passkey (updates users.last_reauthenticated_at).
   */
  async verifyReauth(userId: string, response: AuthenticationResponseJSON, ipAddress?: string, userAgent?: string) {
    const bucketKey = `pk_reauth:${userId}`;
    if (!checkRateLimit(bucketKey, MAX_PASSKEY_AUTH_ATTEMPTS_PER_15M, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many re-authentication attempts. Please wait 15 minutes.', 900);
    }

    try {
      const { credRow } = await this.verifyAssertionInternal({
        purpose: 'reauth',
        response,
        expectedUserId: userId,
        ipAddress,
        userAgent,
      });
      recordRateLimitEvent(bucketKey, true, ipAddress);
      recordSecurityEvent({
        userId,
        eventType: 'PASSKEY_REAUTHENTICATED',
        severity: 'info',
        identifier: credRow.username || credRow.handle,
        ipAddress,
        userAgent,
        details: { passkeyLabel: credRow.label },
      });
      return {
        success: true,
        lastReauthenticatedAt: new Date().toISOString(),
      };
    } catch (err) {
      recordRateLimitEvent(bucketKey, false, ipAddress);
      throw err;
    }
  },

  /**
   * Removes an individual registered passkey. Strictly requires recent re-authentication or current password.
   */
  removePasskey(
    userId: string,
    passkeyId: string,
    options: {
      currentPassword?: string;
      hasRecentReauth: boolean;
      ipAddress?: string;
      userAgent?: string;
    }
  ) {
    if (typeof options.currentPassword === 'string' && options.currentPassword.length > 0) {
      authService.reauthenticate(userId, options.currentPassword, options.ipAddress);
    } else if (!options.hasRecentReauth) {
      const err: any = new Error('Please re-authenticate with your password or passkey before removing a passkey.');
      err.status = 403;
      err.code = 'REAUTH_REQUIRED';
      throw err;
    }

    const existing = db.prepare(`
      SELECT id, label
      FROM webauthn_credentials
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(passkeyId, userId) as { id: string; label: string } | undefined;

    if (!existing) {
      const err: any = new Error('Passkey not found.');
      err.status = 404;
      throw err;
    }

    db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(passkeyId, userId);

    const parsedUa = parseDeviceFromUserAgent(options.userAgent);
    recordSecurityEvent({
      userId,
      eventType: 'PASSKEY_REMOVED',
      severity: 'warning',
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      deviceName: parsedUa.deviceName,
      details: { label: existing.label, passkeyId: existing.id },
    });

    insertPasskeyNotification(
      userId,
      'Passkey Removed',
      `The passkey "${existing.label}" was removed from your account.`
    );

    return {
      success: true,
      removedId: existing.id,
      message: `Passkey "${existing.label}" removed.`,
    };
  },

  /**
   * Method B Password Recovery Step 1: verify user ownership with a passkey and issue a short-lived single-use reset token.
   */
  async verifyRecoveryAssertion(response: AuthenticationResponseJSON, ipAddress?: string, userAgent?: string) {
    const ipBucket = `pk_rec_ip:${ipAddress || 'unknown'}`;
    if (!checkRateLimit(ipBucket, MAX_PASSKEY_RECOVERY_ATTEMPTS_PER_15M, RATE_LIMIT_WINDOW_MS, ipAddress)) {
      throw new AuthRateLimitError('Too many passkey recovery attempts. Please wait 15 minutes before trying again.', 900);
    }

    try {
      const { credRow } = await this.verifyAssertionInternal({
        purpose: 'recovery',
        response,
        ipAddress,
        userAgent,
      });

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashSessionToken(rawToken);
      const tokenId = `pkrt-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const expiresAt = new Date(Date.now() + PASSKEY_RECOVERY_TTL_MS).toISOString();

      purgeExpiredChallenges();
      db.prepare(`
        INSERT INTO passkey_recovery_tokens (id, user_id, token_hash, credential_id, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(tokenId, credRow.user_id, tokenHash, credRow.credential_id, expiresAt);

      recordRateLimitEvent(ipBucket, true, ipAddress);
      recordSecurityEvent({
        userId: credRow.user_id,
        eventType: 'PASSKEY_RECOVERY_VERIFIED',
        severity: 'warning',
        identifier: credRow.username || credRow.handle,
        ipAddress,
        userAgent,
        details: { passkeyLabel: credRow.label },
      });

      return {
        verified: true,
        recoveryToken: rawToken,
        expiresAt,
        username: credRow.username || credRow.handle,
      };
    } catch (err) {
      recordRateLimitEvent(ipBucket, false, ipAddress);
      throw err;
    }
  },

  /**
   * Method B Password Recovery Step 2: consume the single-use recovery token, hash new strong password with Argon2id,
   * revoke all prior sessions, and issue a fresh current session on the verified device.
   */
  resetPasswordWithPasskeyRecovery(input: {
    recoveryToken: string;
    newPassword: string;
    confirmPassword?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const ipBucket = `pk_rec_reset:${input.ipAddress || 'unknown'}`;
    if (!checkRateLimit(ipBucket, MAX_PASSKEY_RECOVERY_ATTEMPTS_PER_15M, RATE_LIMIT_WINDOW_MS, input.ipAddress)) {
      throw new AuthRateLimitError('Too many password reset attempts. Please wait 15 minutes.', 900);
    }

    const rawToken = String(input.recoveryToken || '').trim();
    const newPassword = String(input.newPassword || '');
    if (!rawToken) {
      const err: any = new Error('Passkey verification is required before setting a new password.');
      err.status = 400;
      throw err;
    }
    if (input.confirmPassword !== undefined && newPassword !== input.confirmPassword) {
      const err: any = new Error('New password and confirmation password do not match.');
      err.status = 400;
      throw err;
    }

    const tokenHash = hashSessionToken(rawToken);
    const tokenRow = db.prepare(`
      SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at,
             u.matric_number, u.username, u.role, u.status, u.is_verified, u.accepted_terms_version,
             pr.handle
      FROM passkey_recovery_tokens prt
      JOIN users u ON u.id = prt.user_id
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE prt.token_hash = ?
      LIMIT 1
    `).get(tokenHash) as any;

    if (!tokenRow || tokenRow.used_at) {
      recordRateLimitEvent(ipBucket, false, input.ipAddress);
      const err: any = new Error('Passkey recovery session expired or was already used. Verify your passkey again.');
      err.status = 400;
      throw err;
    }

    if (parseTimestampMs(tokenRow.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM passkey_recovery_tokens WHERE id = ?').run(tokenRow.id);
      recordRateLimitEvent(ipBucket, false, input.ipAddress);
      const err: any = new Error('Passkey recovery session timed out. Please verify your passkey again.');
      err.status = 400;
      throw err;
    }

    if (tokenRow.status === 'suspended') {
      const err: any = new Error('This account has been suspended by moderation.');
      err.status = 403;
      throw err;
    }

    const pwdCheck = validateStrongPassword(newPassword, [tokenRow.username || tokenRow.handle || '']);
    if (!pwdCheck.valid) {
      const err: any = new Error(pwdCheck.error || 'New password does not meet security requirements.');
      err.status = 400;
      throw err;
    }

    const passwordHash = hashPassword(newPassword);

    return runInTransaction(() => {
      const consumeRes = db.prepare(`
        DELETE FROM passkey_recovery_tokens
        WHERE id = ? AND used_at IS NULL
      `).run(tokenRow.id);

      if (Number(consumeRes.changes || 0) !== 1) {
        const err: any = new Error('Passkey recovery token has already been used.');
        err.status = 400;
        throw err;
      }

      db.prepare(`
        UPDATE users
        SET password_hash = ?,
            last_reauthenticated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(passwordHash, tokenRow.user_id);

      db.prepare('DELETE FROM account_lockouts WHERE user_id = ?').run(tokenRow.user_id);

      // Revoke all existing sessions before issuing a fresh session for this recovered device
      const revokedRes = db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'password_reset_passkey'
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(tokenRow.user_id);

      const session = authService.createSession(tokenRow.user_id, input.ipAddress, input.userAgent, 'passkey');

      recordRateLimitEvent(ipBucket, true, input.ipAddress);
      recordSecurityEvent({
        userId: tokenRow.user_id,
        eventType: 'PASSWORD_RESET_COMPLETED',
        severity: 'warning',
        identifier: tokenRow.username || tokenRow.handle,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        deviceName: session.deviceName,
        details: { method: 'passkey', revokedOtherSessions: Number(revokedRes.changes || 0) },
      });

      insertPasskeyNotification(
        tokenRow.user_id,
        'Password Reset via Passkey',
        `Your password was reset using a verified passkey and ${Number(revokedRes.changes || 0)} other active session(s) were signed out.`
      );

      return {
        success: true,
        message: 'Your password has been updated and all other sessions have been signed out.',
        revokedOtherSessions: Number(revokedRes.changes || 0),
        user: {
          id: tokenRow.user_id,
          matric_number: tokenRow.matric_number,
          username: tokenRow.username || tokenRow.handle,
          role: tokenRow.role,
          status: tokenRow.status,
          is_verified: Boolean(tokenRow.is_verified),
          acceptedTermsVersion: tokenRow.accepted_terms_version || null,
        },
        token: session.token,
        refreshToken: session.refreshToken,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
      };
    });
  },
};

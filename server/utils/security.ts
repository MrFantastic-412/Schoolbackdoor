import crypto from 'node:crypto';
import { db } from '../db/database';

const LEGACY_STATIC_SALT = 'futa_salt_2026';
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const COMMON_WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password1!',
  'password12',
  'password123',
  'p@ssword1',
  'p@ssw0rd',
  'qwerty123!',
  'qwerty123',
  '12345678',
  '12345678!',
  '12345678a!',
  'admin123!',
  'welcome1!',
  'welcome123!',
  'letmein1!',
  'letmein123!',
  'futastudent1!',
  'schoolbackdoor1!',
  'iloveyou1!',
  'changeme1!',
  'abc12345!',
]);

/**
 * Per-user random 16-byte salted scrypt password hash with high work factors (v3:<saltHex>:<hashHex>).
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS).toString('hex');
  return `v3:${salt}:${derived}`;
}

/**
 * Constant-time password verification supporting v3 high-work-factor scrypt,
 * legacy v2 scrypt, and static-salted hashes (for seamless migration on next login).
 */
export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!password || !storedHash) return false;

  try {
    if (storedHash.startsWith('v3:') || storedHash.startsWith('v2:')) {
      const parts = storedHash.split(':');
      if (parts.length !== 3) return false;
      const [version, salt, expectedHex] = parts;
      if (!salt || !expectedHex) return false;
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const actualBuf =
        version === 'v3'
          ? crypto.scryptSync(password, salt, expectedBuf.length, SCRYPT_PARAMS)
          : crypto.scryptSync(password, salt, expectedBuf.length);
      if (actualBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(actualBuf, expectedBuf);
    }

    // Legacy hash compatibility (verified with timingSafeEqual, rehashed on login)
    const expectedBuf = Buffer.from(storedHash, 'hex');
    if (expectedBuf.length !== 32) return false;
    const actualBuf = crypto.scryptSync(password, LEGACY_STATIC_SALT, 32);
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

export function needsPasswordRehash(storedHash: string | null | undefined): boolean {
  return Boolean(storedHash && !storedHash.startsWith('v3:'));
}

/**
 * Computes deterministic SHA-256 hex digest of an opaque session token for safe DB persistence.
 */
export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(String(rawToken || ''), 'utf8').digest('hex');
}

/**
 * Enforces strong password policy: >=8 chars, upper, lower, digit, symbol, not common weak password.
 */
export function validateStrongPassword(
  password: string,
  disallowedTerms: string[] = []
): { valid: boolean; error?: string } {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password must be at least 8 characters long.' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'Password must not exceed 128 characters.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must include at least one uppercase letter.' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must include at least one lowercase letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must include at least one number.' };
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    return { valid: false, error: 'Password must include at least one symbol (e.g., !@#$%^&*).' };
  }

  const lower = password.toLowerCase();
  if (COMMON_WEAK_PASSWORDS.has(lower)) {
    return { valid: false, error: 'This password is too common. Please choose a stronger password.' };
  }

  for (const term of disallowedTerms) {
    const cleanTerm = String(term || '').replace(/^@/, '').trim().toLowerCase();
    if (cleanTerm.length >= 4 && lower.includes(cleanTerm)) {
      return { valid: false, error: 'Password cannot contain your username or email.' };
    }
  }

  return { valid: true };
}

/**
 * Strips control characters and HTML brackets from registration/profile text fields.
 */
export function sanitizeInputText(raw: unknown, maxLen = 120): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x1F\x7F<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Cryptographically strong 6-digit numeric code generator using CSPRNG.
 */
export function generateNumericOtp(digits = 6): string {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits);
  return crypto.randomInt(min, max).toString();
}

/**
 * Validates that a URL is either a safe app-relative path (/foo) or http(s) URL,
 * blocking javascript:, vbscript:, data:, file:, and protocol-relative // URLs.
 */
export function sanitizeSafeUrl(
  rawUrl: unknown,
  options: { allowRelative?: boolean; defaultFallback?: string } = {}
): string | null {
  const { allowRelative = true } = options;
  if (typeof rawUrl !== 'string') return options.defaultFallback ?? null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Reject control characters or whitespace inside scheme
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error('Invalid URL characters.');
  }

  if (trimmed.startsWith('/')) {
    if (!allowRelative || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
      throw new Error('Invalid URL scheme.');
    }
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Malformed URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}". Only http(s) or internal paths are allowed.`);
  }

  return parsed.toString();
}

/**
 * Database-backed rate limiter across login, registration, and password recovery
 * so protections survive restarts/workers.
 */
export function checkRateLimit(
  bucketKey: string,
  maxEvents: number,
  windowMs: number,
  ipAddress?: string
): boolean {
  const windowStart = new Date(Date.now() - windowMs).toISOString().replace('T', ' ').slice(0, 19);
  const row = db
    .prepare(
      `
      SELECT COUNT(*) as c
      FROM login_attempts
      WHERE (identifier = ? OR (ip_address = ? AND ip_address IS NOT NULL AND identifier LIKE ?))
        AND success = 0
        AND datetime(attempted_at) >= datetime(?)
    `
    )
    .get(
      bucketKey,
      ipAddress || null,
      `${bucketKey.split(':')[0]}:%`,
      windowStart
    ) as { c: number } | undefined;

  return (row?.c ?? 0) < maxEvents;
}

export function recordRateLimitEvent(bucketKey: string, success: boolean, ipAddress?: string) {
  db.prepare(
    `
    INSERT INTO login_attempts (id, identifier, ip_address, success)
    VALUES (?, ?, ?, ?)
  `
  ).run(
    `rl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    bucketKey,
    ipAddress || null,
    success ? 1 : 0
  );
}

/**
 * Escapes SQLite LIKE pattern metacharacters (`\`, `%`, `_`) so user search input
 * cannot act as a wildcard DoS or enumeration bypass when paired with `ESCAPE '\'`.
 */
export function escapeLikePattern(raw: string): string {
  return String(raw || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Validates and normalizes pinned CampusLocation payloads to prevent malformed
 * JSON pollution or scriptable fields.
 */
export function validateLocationInput(raw: unknown): {
  id: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  campusZone?: string;
  description?: string;
  isOffCampus?: boolean;
} | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid location payload.');
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 120) : '';
  if (!name) {
    throw new Error('Location name is required.');
  }
  const coords = obj.coordinates;
  if (
    !Array.isArray(coords) ||
    coords.length !== 2 ||
    typeof coords[0] !== 'number' ||
    typeof coords[1] !== 'number' ||
    !Number.isFinite(coords[0]) ||
    !Number.isFinite(coords[1]) ||
    coords[0] < -90 ||
    coords[0] > 90 ||
    coords[1] < -180 ||
    coords[1] > 180
  ) {
    throw new Error('Invalid geographic coordinates.');
  }
  const id =
    typeof obj.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(obj.id.trim())
      ? obj.id.trim()
      : `spot-${Date.now()}`;

  return {
    id,
    name,
    coordinates: [Number(coords[0].toFixed(6)), Number(coords[1].toFixed(6))],
    ...(typeof obj.category === 'string' ? { category: obj.category.trim().slice(0, 32) } : {}),
    ...(typeof obj.campusZone === 'string' ? { campusZone: obj.campusZone.trim().slice(0, 80) } : {}),
    ...(typeof obj.description === 'string' ? { description: obj.description.trim().slice(0, 300) } : {}),
    ...(typeof obj.isOffCampus === 'boolean' ? { isOffCampus: obj.isOffCampus } : {}),
  };
}

/**
 * Neutralizes spreadsheet formula injection (`=`, `+`, `-`, `@`, tab, CR) before CSV export.
 */
export function escapeCsvCell(value: unknown): string {
  const raw = String(value ?? '');
  const neutralized = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

export const CURRENT_TERMS_VERSION = '2026.11';

export const SESSION_POLICY = {
  accessTtlMinutes: Math.min(60, Math.max(5, Number(process.env.ACCESS_TOKEN_TTL_MINUTES) || 15)),
  refreshInactivityDays: Math.min(90, Math.max(7, Number(process.env.REFRESH_SESSION_DAYS) || 30)),
  sessionMaxLifetimeDays: Math.min(180, Math.max(30, Number(process.env.SESSION_MAX_LIFETIME_DAYS) || 90)),
  maxActiveDevices: Math.min(10, Math.max(1, Number(process.env.MAX_ACTIVE_DEVICES) || 5)),
  reauthWindowMinutes: Math.min(30, Math.max(5, Number(process.env.REAUTH_WINDOW_MINUTES) || 15)),
};

export function parseDeviceFromUserAgent(userAgent?: string | null): {
  deviceName: string;
  deviceType: 'phone' | 'tablet' | 'desktop';
} {
  const ua = String(userAgent || '').trim();
  const lower = ua.toLowerCase();

  let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) {
    deviceType = 'tablet';
  } else if (/iphone|ipod|android.*mobile|windows phone|blackberry|mobile/i.test(ua)) {
    deviceType = 'phone';
  }

  let os = 'Unknown Device';
  if (lower.includes('iphone')) os = 'iPhone';
  else if (lower.includes('ipad')) os = 'iPad';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('mac os') || lower.includes('macintosh')) os = 'macOS';
  else if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('linux')) os = 'Linux';
  else if (lower.includes('curl') || lower.includes('undici') || lower.includes('node')) os = 'API Client';

  let browser = 'Browser';
  if (lower.includes('edg/')) browser = 'Edge';
  else if (lower.includes('crios') || lower.includes('chrome')) browser = 'Chrome';
  else if (lower.includes('firefox') || lower.includes('fxios')) browser = 'Firefox';
  else if (lower.includes('safari') && !lower.includes('chrome')) browser = 'Safari';
  else if (os === 'API Client') browser = 'CLI';

  return {
    deviceName: sanitizeInputText(`${os} · ${browser}`, 80) || 'Web Browser',
    deviceType,
  };
}

export function recordSecurityEvent(params: {
  userId?: string | null;
  eventType: string;
  severity?: 'info' | 'warning' | 'high' | 'critical';
  identifier?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceName?: string | null;
  details?: Record<string, unknown>;
}) {
  try {
    const id = `sec-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    let safeUserId: string | null = params.userId || null;
    if (safeUserId) {
      const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(safeUserId);
      if (!exists) safeUserId = null;
    }

    // Never log sensitive keys into details_json
    let sanitizedDetails: string | null = null;
    if (params.details) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params.details)) {
        const lk = k.toLowerCase();
        if (lk.includes('password') || lk.includes('token') || lk.includes('secret') || lk.includes('code') || lk.includes('otp')) {
          continue;
        }
        clean[k] = v;
      }
      sanitizedDetails = JSON.stringify(clean);
    }

    db.prepare(`
      INSERT INTO security_events (
        id, user_id, event_type, severity, identifier, ip_address, user_agent, device_name, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      safeUserId,
      sanitizeInputText(params.eventType, 64) || 'SECURITY_EVENT',
      params.severity || 'info',
      params.identifier ? sanitizeInputText(params.identifier, 120) : null,
      params.ipAddress ? sanitizeInputText(params.ipAddress, 64) : null,
      params.userAgent ? sanitizeInputText(params.userAgent, 220) : null,
      params.deviceName ? sanitizeInputText(params.deviceName, 80) : null,
      sanitizedDetails
    );
    return id;
  } catch {
    return null;
  }
}

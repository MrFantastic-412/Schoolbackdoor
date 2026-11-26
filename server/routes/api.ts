import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import {
  authMiddleware,
  extractRefreshToken,
  extractSessionToken,
  hasRecentReauth,
  requireAuth,
  requireNotRestricted,
  requireRecentReauth,
  requireRole,
  requireTermsAccepted,
} from '../middleware/auth.js';
import { AuthRateLimitError, authService } from '../services/authService.js';
import { passkeyService } from '../services/passkeyService.js';
import { SESSION_POLICY } from '../utils/security.js';
import { blockService } from '../services/blockService.js';
import { userService } from '../services/userService.js';
import { postService } from '../services/postService.js';
import { commentReactionService } from '../services/commentReactionService.js';
import { chatService } from '../services/chatService.js';
import { communityService } from '../services/communityService.js';
import { notificationService } from '../services/notificationService.js';
import { mentionService } from '../services/mentionService.js';
import { fileService, PROTECTION_MODE_MAX_UPLOAD_BYTES } from '../services/fileService.js';
import { adminReportService } from '../services/adminReportService.js';
import { adminSecurityService } from '../services/adminSecurityService.js';
import { adminControlService } from '../services/adminControlService.js';
import { ForbiddenModeratorActionError, moderatorService } from '../services/moderatorService.js';
import { adminAnalyticsService, AnalyticsRange } from '../services/adminAnalyticsService.js';
import { adminAdsPaymentsService } from '../services/adminAdsPaymentsService.js';
import { landmarkService } from '../services/landmarkService.js';
import { savedLocationService } from '../services/savedLocationService.js';
import { presenceService } from '../services/presenceService.js';
import { deletionService } from '../services/deletionService.js';
import { sseManager } from '../realtime/sseManager.js';
import { db, withReadConnection, getPoolStats } from '../db/database.js';
import { cache } from '../utils/cache.js';
import type { FeedFilter } from '../services/postService.js';
import { feedRankingService, normalizeFeedCategory } from '../services/feedRankingService.js';
import { CAMPUS_AREAS, isValidLocationFilter } from '../services/locationTaxonomy.js';
import type { LocationFilterKey } from '../services/locationTaxonomy.js';

export const apiRouter = Router();

function sendPublicCachedJson(req: Request, res: Response, payload: unknown, maxAgeSec: number, swrSec: number) {
  const json = JSON.stringify(payload);
  const etag = `W/"${crypto.createHash('sha1').update(json).digest('hex').slice(0, 16)}"`;
  res.removeHeader('Pragma');
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`);
  res.setHeader('CDN-Cache-Control', `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.type('application/json').send(json);
}

// Apply auth resolver to all API routes
apiRouter.use(authMiddleware);

// Strict private no-store default for every API endpoint so personal student data is never shared-cached
apiRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.includes('/realtime/stream')) {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('CDN-Cache-Control', 'no-store');
  }
  next();
});

const IS_SERVERLESS_RUNTIME = Boolean(
  process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY
);

const REALTIME_TICKET_SECRET =
  process.env.REALTIME_TICKET_SECRET ||
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString('hex');

function signRealtimeTicket(userId: string, ttlMs = 60_000): string {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      exp: Date.now() + ttlMs,
      jti: crypto.randomBytes(12).toString('hex'),
    }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', REALTIME_TICKET_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySignedRealtimeTicket(token: string): string | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;
  const expectedSig = crypto.createHmac('sha256', REALTIME_TICKET_SECRET).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sigB64, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      uid?: string;
      exp?: number;
    };
    if (!parsed?.uid || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
      return null;
    }
    return parsed.uid;
  } catch {
    return null;
  }
}

// --- System & Diagnostics ---
apiRouter.get('/health', (_req: Request, res: Response) => {
  const clusterWorkers = Math.max(1, Number(process.env.CLUSTER_WORKERS) || 1);
  res.json({
    status: 'ok',
    app: 'Schoolbackdoor API',
    database: 'SQLite 3.51 (Node 22 native WAL)',
    timestamp: new Date().toISOString(),
    dbPool: getPoolStats(),
    cache: cache.getStats(),
    realtime: {
      mode: IS_SERVERLESS_RUNTIME ? 'polling' : 'sse',
      sseSupported: !IS_SERVERLESS_RUNTIME,
      pollIntervalMs: 4000,
    },
    scaling: {
      clusterWorkers,
      mode: clusterWorkers > 1 ? 'multi-worker' : 'single-process',
      cdnConfigured: Boolean(process.env.CDN_BASE_URL),
    },
  });
});

apiRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(adminReportService.getPlatformStats());
});

apiRouter.get('/platform/config', (req: Request, res: Response) => {
  try {
    sendPublicCachedJson(req, res, adminControlService.getPublicPlatformConfig(), 5, 15);
  } catch {
    res.status(500).json({ error: 'Unable to load platform configuration.' });
  }
});

const SESSION_COOKIE_NAME = 'sb_session';
const REFRESH_COOKIE_NAME = 'sb_refresh';

function shouldSetSecureCookie(req: Request): boolean {
  if (req.secure) return true;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (forwardedProto === 'https') return true;
  if (process.env.NODE_ENV === 'production') {
    const host = String(req.hostname || '').toLowerCase();
    return host !== '127.0.0.1' && host !== 'localhost';
  }
  return false;
}

function formatCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${name}=${value ? encodeURIComponent(value) : ''}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(req: Request, res: Response, rawToken: string, rawRefreshToken?: string) {
  const secure = shouldSetSecureCookie(req);
  const accessMaxAge = SESSION_POLICY.accessTtlMinutes * 60;
  const refreshMaxAge = SESSION_POLICY.refreshInactivityDays * 24 * 60 * 60;
  const cookies = [formatCookie(SESSION_COOKIE_NAME, rawToken, accessMaxAge, secure)];
  if (rawRefreshToken) {
    cookies.push(formatCookie(REFRESH_COOKIE_NAME, rawRefreshToken, refreshMaxAge, secure));
  }
  res.setHeader('Set-Cookie', cookies);
}

function clearSessionCookie(req: Request, res: Response) {
  const secure = shouldSetSecureCookie(req);
  res.setHeader('Set-Cookie', [
    formatCookie(SESSION_COOKIE_NAME, '', 0, secure),
    formatCookie(REFRESH_COOKIE_NAME, '', 0, secure),
  ]);
}

function sanitizeAuthUserPayload(user: Record<string, any> | null | undefined) {
  if (!user) return user;
  const { verification_code: _vc, password_hash: _ph, password: _pw, mfa_secret: _ms, ...safeUser } = user;
  return safeUser;
}

function sendApiMediaError(res: Response, err: any, fallbackStatus = 400) {
  const msg = String(err?.message || 'Request failed.');
  if (err?.status === 413 || err?.code === 'IMAGE_TOO_LARGE') {
    res.status(413).json({ error: msg, code: 'IMAGE_TOO_LARGE' });
    return;
  }
  if (err?.status === 507 || err?.code === 'STORAGE_PROTECTION_ACTIVE' || msg.includes('Storage Protection Mode')) {
    res.status(507).json({ error: msg, code: 'STORAGE_PROTECTION_ACTIVE' });
    return;
  }
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : fallbackStatus;
  res.status(status).json({ error: msg, ...(err?.code ? { code: err.code } : {}) });
}

// --- Authentication & Account Lifecycle ---
apiRouter.get('/auth/challenge', (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    res.json(authService.issueRegistrationChallenge(ip));
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 3600));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 3600 });
      return;
    }
    res.status(400).json({ error: err?.message || 'Unable to issue signup challenge.' });
  }
});

apiRouter.get('/auth/setup-status', (_req: Request, res: Response) => {
  res.json(authService.getFirstRunAdminSetupStatus());
});

apiRouter.post('/auth/setup-admin', (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = authService.claimFirstRunAdminPassword(
      req.body?.password || '',
      req.body?.confirmPassword,
      ip,
      req.headers['user-agent']
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(err?.status || 400).json({ error: err?.message || 'Unable to complete first-run admin setup.' });
  }
});

apiRouter.post('/auth/register', (req: Request, res: Response) => {
  try {
    if (req.body?.acceptTerms !== true) {
      res.status(400).json({
        error: 'You must accept the Terms of Service and Community Guidelines before creating an account.',
        code: 'TERMS_ACCEPTANCE_REQUIRED',
      });
      return;
    }
    const ip = req.ip || req.socket.remoteAddress;
    const idempotencyKey =
      (typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.trim()) ||
      (typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim()) ||
      undefined;

    const result = authService.register(
      {
        ...req.body,
        idempotencyKey,
        userAgent: req.headers['user-agent'],
        requireBotChallenge: true,
      },
      ip
    );

    if (result.token) {
      setSessionCookie(req, res, result.token, result.refreshToken);
    }
    const { refreshToken: _rt, ...safeResult } = result as Record<string, any>;
    res.status(201).json({
      ...safeResult,
      user: sanitizeAuthUserPayload(result.user),
      message: 'Account created! Save your 10 single-use recovery codes somewhere safe — they are shown only once.',
    });
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 3600));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 3600 });
      return;
    }
    sendApiMediaError(res, err, 400);
  }
});

apiRouter.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, identifier, password, mfaCode } = req.body || {};
    const loginHandle = typeof username === 'string' && username.trim() ? username : identifier;
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const result = authService.login(loginHandle, password, ip, userAgent, mfaCode);
    const profile = userService.getProfileByUserId(result.user.id, result.user.id, result.user.role);
    if (result.token) {
      setSessionCookie(req, res, result.token, result.refreshToken);
    }
    const { refreshToken: _rt, ...safeResult } = result as Record<string, any>;
    res.json({
      ...safeResult,
      user: sanitizeAuthUserPayload(result.user),
      profile,
    });
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    if (typeof err?.progressiveDelayMs === 'number' && err.progressiveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(err.progressiveDelayMs, 5000)));
    }
    const statusCode = typeof err?.message === 'string' && err.message.startsWith('MFA_REQUIRED:') ? 403 : 401;
    res.status(statusCode).json({ error: err.message, mfaRequired: statusCode === 403 });
  }
});

apiRouter.post('/auth/refresh', (req: Request, res: Response) => {
  try {
    const rawRefresh = extractRefreshToken(req);
    if (!rawRefresh) {
      res.status(401).json({ error: 'Refresh session cookie is missing or expired.' });
      return;
    }
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const refreshed = authService.refreshSession(rawRefresh, ip, userAgent);
    setSessionCookie(req, res, refreshed.token, refreshed.refreshToken);
    res.json({
      token: refreshed.token,
      sessionId: refreshed.sessionId,
      expiresAt: refreshed.expiresAt,
      user: sanitizeAuthUserPayload(refreshed.user),
    });
  } catch (err: any) {
    clearSessionCookie(req, res);
    res.status(401).json({
      error: err?.message || 'Session refresh failed.',
      ...(err?.code ? { code: err.code } : {}),
    });
  }
});

apiRouter.post('/auth/reauthenticate', requireAuth, (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = authService.reauthenticate(req.user!.id, req.body?.password || '', ip);
    res.json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(401).json({ error: err?.message || 'Re-authentication failed.' });
  }
});

apiRouter.post('/auth/change-password', requireAuth, (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = authService.changePassword(
      req.user!.id,
      req.body?.currentPassword || '',
      req.body?.newPassword || '',
      req.sessionTokenHash,
      ip
    );
    res.json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(400).json({ error: err?.message || 'Unable to change password.' });
  }
});

apiRouter.get('/auth/mfa/status', requireRole('admin', 'moderator'), (req: Request, res: Response) => {
  res.json(authService.getMfaStatus(req.user!.id));
});

apiRouter.post('/auth/mfa/setup', requireRole('admin', 'moderator'), (req: Request, res: Response) => {
  res.json(authService.initiateMfaSetup(req.user!.id, req.user!.username || req.user!.matric_number));
});

apiRouter.post('/auth/mfa/verify', requireRole('admin', 'moderator'), (req: Request, res: Response) => {
  try {
    res.json(authService.verifyAndEnableMfa(req.user!.id, req.body?.code || ''));
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/auth/mfa/disable', requireRole('admin', 'moderator'), (req: Request, res: Response) => {
  try {
    res.json(authService.disableMfa(req.user!.id, req.body?.password || ''));
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/auth/logout', (req: Request, res: Response) => {
  const token = extractSessionToken(req);
  const ip = req.ip || req.socket.remoteAddress;
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : undefined;
  if (req.user?.id) {
    const summary = presenceService.removeClientPresence(req.user.id, clientId);
    sseManager.broadcastPresenceUpdate(summary);
  }
  if (token) {
    authService.logout(token, ip);
  }
  clearSessionCookie(req, res);
  res.json({ success: true, message: 'Signed out successfully.' });
});

// --- Live Presence & Unique Online Users ---
apiRouter.get('/presence/online', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, max-age=2');
  // Strictly returns count & display string — zero PII
  res.json(presenceService.getOnlineSummary());
});

apiRouter.post('/presence/heartbeat', requireAuth, (req: Request, res: Response) => {
  try {
    if (!req.isAuthenticatedUser || !req.user) {
      res.status(401).json({ error: 'Authenticated session required for presence heartbeat.' });
      return;
    }
    const clientId =
      typeof req.body?.clientId === 'string' && req.body.clientId.trim()
        ? req.body.clientId.trim()
        : `cli-${req.user.id}`;
    const summary = presenceService.recordHeartbeat(
      req.user.id,
      clientId,
      req.headers['user-agent']
    );
    sseManager.broadcastPresenceUpdate(summary);
    res.json(summary);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/presence/offline', requireAuth, (req: Request, res: Response) => {
  try {
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : undefined;
    const summary = presenceService.removeClientPresence(req.user!.id, clientId);
    sseManager.broadcastPresenceUpdate(summary);
    res.json(summary);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Recovery Codes & Password Recovery (Method A) ---
apiRouter.post('/auth/recovery/reset', (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const { username, recoveryCode, newPassword, confirmPassword } = req.body || {};
    const result = authService.resetPasswordWithRecoveryCode({
      username,
      recoveryCode,
      newPassword,
      confirmPassword,
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });
    clearSessionCookie(req, res);
    res.json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(400).json({ error: err?.message || 'Unable to reset password.' });
  }
});

apiRouter.get('/auth/recovery-codes/status', requireAuth, (req: Request, res: Response) => {
  res.json(authService.getRecoveryCodeStatus(req.user!.id));
});

apiRouter.post('/auth/recovery-codes/regenerate', requireAuth, (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = authService.regenerateRecoveryCodes(
      req.user!.id,
      req.body?.currentPassword || '',
      ip,
      req.headers['user-agent'],
      {
        hasRecentReauth: hasRecentReauth(req.user),
        usePasskeyReauth: Boolean(req.body?.usePasskeyReauth),
      }
    );
    res.json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({
      error: err?.message || 'Unable to regenerate recovery codes.',
      ...(err?.code ? { code: err.code } : {}),
    });
  }
});

// --- Passkeys / WebAuthn (Stage 3C) ---
apiRouter.get('/auth/passkeys', requireAuth, (req: Request, res: Response) => {
  res.json({ passkeys: passkeyService.listPasskeys(req.user!.id) });
});

apiRouter.post('/auth/passkeys/register/options', requireAuth, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const options = await passkeyService.createRegistrationOptions(
      req.user!.id,
      ip,
      req.headers['user-agent']
    );
    res.json(options);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({ error: err?.message || 'Unable to start passkey setup.' });
  }
});

apiRouter.post('/auth/passkeys/register/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = await passkeyService.verifyRegistration(
      req.user!.id,
      req.body?.response,
      req.body?.label,
      ip,
      req.headers['user-agent']
    );
    res.status(201).json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({ error: err?.message || 'Passkey verification failed.' });
  }
});

apiRouter.delete('/auth/passkeys/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = passkeyService.removePasskey(req.user!.id, req.params.id, {
      currentPassword: req.body?.currentPassword ?? req.body?.password,
      hasRecentReauth: hasRecentReauth(req.user),
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });
    res.json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({
      error: err?.message || 'Unable to remove passkey.',
      ...(err?.code ? { code: err.code } : {}),
    });
  }
});

apiRouter.post('/auth/passkeys/reauth/options', requireAuth, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const options = await passkeyService.createAuthenticationOptions({
      purpose: 'reauth',
      userId: req.user!.id,
      ipAddress: ip,
    });
    res.json(options);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({ error: err?.message || 'Unable to initialize passkey verification.' });
  }
});

apiRouter.post('/auth/passkeys/reauth/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = await passkeyService.verifyReauth(
      req.user!.id,
      req.body?.response,
      ip,
      req.headers['user-agent']
    );
    res.json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 401).json({ error: err?.message || 'Passkey verification failed.' });
  }
});

apiRouter.post('/auth/passkeys/login/options', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const options = await passkeyService.createAuthenticationOptions({
      purpose: 'login',
      username: typeof req.body?.username === 'string' ? req.body.username : undefined,
      ipAddress: ip,
    });
    res.json(options);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({ error: err?.message || 'Unable to initialize passkey sign-in.' });
  }
});

apiRouter.post('/auth/passkeys/login/verify', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const result = await passkeyService.verifyLogin(req.body?.response, ip, userAgent);
    const profile = userService.getProfileByUserId(result.user.id, result.user.id, result.user.role);
    if (result.token) {
      setSessionCookie(req, res, result.token, result.refreshToken);
    }
    const { refreshToken: _rt, ...safeResult } = result as Record<string, any>;
    res.json({
      ...safeResult,
      user: sanitizeAuthUserPayload(result.user),
      profile,
    });
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 401).json({ error: err?.message || 'Passkey sign-in failed.' });
  }
});

apiRouter.post('/auth/passkeys/recovery/options', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const options = await passkeyService.createAuthenticationOptions({
      purpose: 'recovery',
      username: typeof req.body?.username === 'string' ? req.body.username : undefined,
      ipAddress: ip,
    });
    res.json(options);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({ error: err?.message || 'Unable to start passkey recovery.' });
  }
});

apiRouter.post('/auth/passkeys/recovery/verify', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = await passkeyService.verifyRecoveryAssertion(
      req.body?.response,
      ip,
      req.headers['user-agent']
    );
    res.json(result);
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 401).json({ error: err?.message || 'Passkey verification failed.' });
  }
});

apiRouter.post('/auth/passkeys/recovery/reset', (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    const result = passkeyService.resetPasswordWithPasskeyRecovery({
      recoveryToken: req.body?.recoveryToken,
      newPassword: req.body?.newPassword,
      confirmPassword: req.body?.confirmPassword,
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });
    const profile = userService.getProfileByUserId(result.user.id, result.user.id, result.user.role);
    if (result.token) {
      setSessionCookie(req, res, result.token, result.refreshToken);
    }
    const { refreshToken: _rt, ...safeResult } = result as Record<string, any>;
    res.json({
      ...safeResult,
      user: sanitizeAuthUserPayload(result.user),
      profile,
    });
  } catch (err: any) {
    if (err instanceof AuthRateLimitError || err?.status === 429) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 900));
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds || 900 });
      return;
    }
    res.status(err?.status || 400).json({ error: err?.message || 'Unable to reset password via passkey.' });
  }
});

// --- User & Profile ---
apiRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  const profile = userService.getProfileByUserId(req.user!.id, req.user!.id, req.user!.role);
  if (!profile) {
    res.status(404).json({ error: 'Profile not found.' });
    return;
  }
  res.json({
    user: req.user,
    profile,
  });
});

apiRouter.post('/me/accept-terms', requireAuth, (req: Request, res: Response) => {
  if (req.body?.accept !== true) {
    res.status(400).json({ error: 'Explicit acceptance of Terms of Service and Community Guidelines is required.' });
    return;
  }
  res.json(authService.acceptTerms(req.user!.id));
});

apiRouter.get('/me/sessions', requireAuth, (req: Request, res: Response) => {
  res.json({
    maxActiveDevices: SESSION_POLICY.maxActiveDevices,
    accessTtlMinutes: SESSION_POLICY.accessTtlMinutes,
    refreshTtlDays: SESSION_POLICY.refreshInactivityDays,
    maxLifetimeDays: SESSION_POLICY.sessionMaxLifetimeDays,
    sessions: authService.getUserSessions(req.user!.id, req.sessionTokenHash),
  });
});

apiRouter.delete('/me/sessions/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const result = authService.revokeUserSession(req.user!.id, req.params.id, req.sessionTokenHash);
    if (result.revokedSelf) {
      clearSessionCookie(req, res);
    }
    res.json(result);
  } catch (err: any) {
    res.status(404).json({ error: err?.message || 'Device session not found.' });
  }
});

apiRouter.post('/me/sessions/revoke-others', requireAuth, (req: Request, res: Response) => {
  res.json(authService.revokeOtherUserSessions(req.user!.id, req.sessionTokenHash));
});

apiRouter.post('/me/sessions/revoke-all', requireAuth, (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress;
  const result = authService.revokeAllUserSessions(req.user!.id, ip);
  clearSessionCookie(req, res);
  res.json({ ...result, signedOutEverywhere: true });
});

apiRouter.get('/me/security-events', requireAuth, (req: Request, res: Response) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  res.json({
    events: authService.getUserSecurityEvents(req.user!.id, limit),
  });
});

apiRouter.put('/me/profile', requireAuth, (req: Request, res: Response) => {
  try {
    if (
      req.body &&
      (req.body.latitude !== undefined ||
        req.body.longitude !== undefined ||
        req.body.lat !== undefined ||
        req.body.lng !== undefined ||
        req.body.coords !== undefined)
    ) {
      res.status(400).json({ error: 'Precise GPS coordinates are never stored. Select a coarse campus area instead.' });
      return;
    }
    const updated = userService.updateProfile(req.user!.id, req.body, req.user!.role);
    if (req.body?.show_online_status !== undefined || req.body?.showOnlineStatus !== undefined) {
      sseManager.broadcastPresenceUpdate(presenceService.getOnlineSummary(), true);
    }
    res.json(updated);
  } catch (err: any) {
    sendApiMediaError(res, err, 400);
  }
});

apiRouter.put('/me/location-preference', requireAuth, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    if (
      body.latitude !== undefined ||
      body.longitude !== undefined ||
      body.lat !== undefined ||
      body.lng !== undefined ||
      body.coords !== undefined ||
      body.coordinates !== undefined
    ) {
      res.status(400).json({ error: 'Precise GPS coordinates are never stored on the server. Only coarse campus areas are accepted.' });
      return;
    }
    const locationSharingEnabled = Boolean(body.locationSharingEnabled ?? body.location_sharing_enabled);
    const preferredLocationArea =
      body.preferredLocationArea !== undefined
        ? body.preferredLocationArea
        : body.preferred_location_area;
    const updated = userService.updateProfile(
      req.user!.id,
      {
        locationSharingEnabled,
        preferredLocationArea: locationSharingEnabled ? preferredLocationArea ?? null : null,
      },
      req.user!.role
    );
    res.json({
      locationSharingEnabled: Boolean(updated?.locationSharingEnabled),
      preferredLocationArea: updated?.preferredLocationArea || null,
      profile: updated,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/users/search', (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(40, Math.max(1, Number(req.query.limit) || 20));
  const list = userService.searchStudents(q, limit, req.user?.id);
  res.json(list);
});

apiRouter.get('/mentions/candidates', requireAuth, (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const chatId = typeof req.query.chatId === 'string' && req.query.chatId.trim() ? req.query.chatId.trim() : undefined;
  const communityId =
    typeof req.query.communityId === 'string' && req.query.communityId.trim()
      ? req.query.communityId.trim()
      : undefined;
  const limit = Math.min(15, Math.max(1, Number(req.query.limit) || 8));
  const candidates = mentionService.getCandidates({
    viewerId: req.user!.id,
    query: q,
    chatId,
    communityId,
    limit,
  });
  res.json(candidates);
});

apiRouter.get('/users/:id/profile', (req: Request, res: Response) => {
  const viewerId = req.user?.id;
  const viewerRole = req.user?.role;
  const profile = userService.getProfileByUserId(req.params.id, viewerId, viewerRole);
  if (!profile) {
    res.status(404).json({ error: 'Student profile not found.' });
    return;
  }
  res.json(profile);
});

apiRouter.post('/users/:id/connect', requireAuth, (req: Request, res: Response) => {
  try {
    const result = userService.toggleConnection(req.user!.id, req.params.id);
    res.json(result);
  } catch (err: any) {
    const status = String(err?.message || '').includes('blocked') ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.get('/users/:id/posts', (req: Request, res: Response) => {
  const viewerId = req.user?.id || '';
  const viewerRole = req.user?.role || 'student';
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const posts = postService.getUserPublicPosts(req.params.id, viewerId, viewerRole, limit);
  res.json(posts);
});

// --- Blocking & Privacy ---
apiRouter.get('/me/blocks', requireAuth, (req: Request, res: Response) => {
  const blocks = blockService.getBlockedUsers(req.user!.id);
  res.json(blocks);
});

apiRouter.post('/users/:id/block', requireAuth, (req: Request, res: Response) => {
  try {
    const result = blockService.blockUser(req.user!.id, req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/users/:id/unblock', requireAuth, (req: Request, res: Response) => {
  try {
    const result = blockService.unblockUser(req.user!.id, req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/chats/direct', requireAuth, (req: Request, res: Response) => {
  try {
    const featureGuard = adminControlService.checkFeatureAccess('chats');
    if (!featureGuard.allowed) {
      res.status(featureGuard.status).json({ error: featureGuard.reason });
      return;
    }
    const { targetUserId } = req.body;
    if (!targetUserId) {
      res.status(400).json({ error: 'targetUserId is required.' });
      return;
    }
    const result = chatService.createDirectChat(req.user!.id, targetUserId);
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// --- Posts & Feed ---
apiRouter.get('/feed/locations', (req: Request, res: Response) => {
  const payload = CAMPUS_AREAS.map((area) => ({
    key: area.key,
    label: area.label,
    shortLabel: area.shortLabel,
    description: area.description,
    isOffCampus: area.isOffCampus,
  }));
  sendPublicCachedJson(req, res, payload, 300, 600);
});

apiRouter.get('/posts', (req: Request, res: Response) => {
  const userId = req.user?.id || '';
  const viewerRole = req.user?.role || 'student';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rawFilter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
  const validFilters: FeedFilter[] = ['all', 'general', 'entertainment', 'discussions', 'soc', 'seet', 'hostel'];
  const filter: FeedFilter = validFilters.includes(rawFilter as FeedFilter) ? (rawFilter as FeedFilter) : 'all';
  const category = normalizeFeedCategory(req.query.category);
  const location: LocationFilterKey = isValidLocationFilter(req.query.location)
    ? req.query.location
    : 'all';

  if (req.query.paginated === '1' || req.query.paginated === 'true') {
    const paginated = postService.getFeedPostsPaginated(
      userId,
      { limit: Math.min(50, Number(req.query.limit) || 15), offset, filter, category, location },
      viewerRole
    );
    res.json(paginated);
    return;
  }

  const posts = postService.getFeedPosts(userId, limit, offset, viewerRole, filter, category, location);
  res.json(posts);
});

apiRouter.post('/posts/views', (req: Request, res: Response) => {
  try {
    const postIds = Array.isArray(req.body?.postIds) ? req.body.postIds : [];
    const visitorId = typeof req.body?.visitorId === 'string' ? req.body.visitorId : undefined;
    const source = typeof req.body?.source === 'string' ? req.body.source : 'feed';
    const dwellMs = req.body?.dwellMs !== undefined ? Number(req.body.dwellMs) : undefined;
    const explicitUserId = extractSessionToken(req) && req.user?.id ? req.user.id : undefined;
    const result = feedRankingService.recordPostViews(postIds, {
      userId: explicitUserId,
      visitorId,
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      source,
      dwellMs,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Unable to record post views.' });
  }
});

apiRouter.post('/posts/:id/view', (req: Request, res: Response) => {
  try {
    const visitorId = typeof req.body?.visitorId === 'string' ? req.body.visitorId : undefined;
    const source = typeof req.body?.source === 'string' ? req.body.source : 'detail';
    const dwellMs = req.body?.dwellMs !== undefined ? Number(req.body.dwellMs) : undefined;
    const explicitUserId = extractSessionToken(req) && req.user?.id ? req.user.id : undefined;
    const result = feedRankingService.recordPostViews([req.params.id], {
      userId: explicitUserId,
      visitorId,
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      source,
      dwellMs,
    });
    res.json({
      ...result,
      views: result.viewsByPost[req.params.id] ?? 0,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Unable to record view.' });
  }
});

apiRouter.post('/posts/:id/share', (req: Request, res: Response) => {
  try {
    const postsGuard = adminControlService.checkFeatureAccess('posts');
    if (!postsGuard.allowed) {
      res.status(postsGuard.status).json({ error: postsGuard.reason });
      return;
    }
    const visitorId = typeof req.body?.visitorId === 'string' ? req.body.visitorId : undefined;
    const explicitUserId = extractSessionToken(req) && req.user?.id ? req.user.id : undefined;
    const result = feedRankingService.recordPostShare(req.params.id, {
      userId: explicitUserId,
      visitorId,
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('block') || msg.includes('privacy')
      ? 403
      : msg.includes('not found') || msg.includes('expired')
      ? 404
      : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.get('/posts/:id', (req: Request, res: Response) => {
  const userId = req.user?.id || '';
  const viewerRole = req.user?.role || 'student';
  const post = postService.getPostById(req.params.id, userId, viewerRole);
  if (!post) {
    res.status(404).json({ error: 'Post not found.' });
    return;
  }
  res.json(post);
});

apiRouter.post('/posts', requireAuth, requireNotRestricted, requireTermsAccepted, (req: Request, res: Response) => {
  try {
    const postsGuard = adminControlService.checkFeatureAccess('posts');
    if (!postsGuard.allowed) {
      res.status(postsGuard.status).json({ error: postsGuard.reason });
      return;
    }
    if (req.body?.is_anonymous) {
      const anonGuard = adminControlService.checkFeatureAccess('anonymous_posting');
      if (!anonGuard.allowed) {
        res.status(anonGuard.status).json({ error: anonGuard.reason });
        return;
      }
    }
    const maxLen = Number(postsGuard.limits?.maxPostLength || 2000);
    if (typeof req.body?.content === 'string' && req.body.content.trim().length > maxLen) {
      res.status(400).json({ error: `Dispatch exceeds configured maximum length of ${maxLen} characters.` });
      return;
    }
    const maxImgs = Number(postsGuard.limits?.maxImagesPerPost || 4);
    if (Array.isArray(req.body?.images) && req.body.images.length > maxImgs) {
      res.status(400).json({ error: `Maximum of ${maxImgs} images allowed per dispatch.` });
      return;
    }

    const post = postService.createPost(req.user!.id, req.body, req.user!.role);
    if (post?.location) {
      try {
        savedLocationService.autoSavePinnedLocation(req.user!.id, post.location, 'post');
      } catch {
        // Non-fatal auto-pin persistence
      }
    }
    if (post && post.content) {
      mentionService.syncMentionsOnContent({
        text: post.content,
        sourceType: 'post',
        sourceId: post.id,
        actorId: req.user!.id,
        targetLink: post.communityId ? `/communities?id=${post.communityId}&post=${post.id}` : `/home?post=${post.id}`,
        contextTitle: post.communityId ? 'Community post' : 'Campus Commons dispatch',
        isAnonymous: Boolean(req.body?.is_anonymous),
        communityId: post.communityId || undefined,
      });
    }
    res.status(201).json(post);
  } catch (err: any) {
    const fallbackStatus = String(err?.message || '').includes('Only administrators') ? 403 : 400;
    sendApiMediaError(res, err, fallbackStatus);
  }
});

apiRouter.patch('/posts/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const postsGuard = adminControlService.checkFeatureAccess('posts');
    if (!postsGuard.allowed) {
      res.status(postsGuard.status).json({ error: postsGuard.reason });
      return;
    }
    const maxLen = Number(postsGuard.limits?.maxPostLength || 2000);
    if (typeof req.body?.content === 'string' && req.body.content.trim().length > maxLen) {
      res.status(400).json({ error: `Dispatch exceeds configured maximum length of ${maxLen} characters.` });
      return;
    }
    const updated = postService.editPost(req.params.id, req.user!.id, req.user!.role, {
      content: req.body?.content,
    });
    res.json(updated);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('Only the author') ? 403 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.delete('/posts/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const result = postService.deletePost(req.params.id, req.user!.id, req.user!.role);
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// --- Reactions & Comments ---
apiRouter.post('/posts/:id/like', requireAuth, (req: Request, res: Response) => {
  try {
    const result = commentReactionService.toggleLike(req.params.id, req.user!.id);
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('block') || msg.includes('privacy') || msg.includes('Permission denied') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.post('/posts/:id/repost', requireAuth, (req: Request, res: Response) => {
  try {
    const result = commentReactionService.toggleRepost(req.params.id, req.user!.id);
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('block') || msg.includes('privacy') || msg.includes('Permission denied') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.post('/posts/:id/poll/vote', requireAuth, (req: Request, res: Response) => {
  try {
    const result = postService.voteOnPoll(req.params.id, req.user!.id, req.body?.optionId);
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('block') || msg.includes('privacy') || msg.includes('Permission denied')
      ? 403
      : msg.includes('not found') || msg.includes('expired')
      ? 404
      : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.post('/posts/:id/comments', requireAuth, requireNotRestricted, requireTermsAccepted, (req: Request, res: Response) => {
  try {
    const postsGuard = adminControlService.checkFeatureAccess('posts');
    if (!postsGuard.allowed) {
      res.status(postsGuard.status).json({ error: postsGuard.reason });
      return;
    }
    const maxImgs = Number(postsGuard.limits?.maxImagesPerPost || 4);
    if (Array.isArray(req.body?.images) && req.body.images.length > maxImgs) {
      res.status(400).json({ error: `Maximum of ${maxImgs} images allowed per comment.` });
      return;
    }
    const comment = commentReactionService.addComment(
      req.params.id,
      req.user!.id,
      req.body?.content,
      typeof req.body?.parentCommentId === 'string' ? req.body.parentCommentId : undefined,
      Array.isArray(req.body?.images) ? req.body.images : undefined
    );
    res.status(201).json(comment);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const fallbackStatus = msg.includes('block') || msg.includes('privacy') || msg.includes('Permission denied') ? 403 : 400;
    sendApiMediaError(res, err, fallbackStatus);
  }
});

apiRouter.patch('/comments/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const postsGuard = adminControlService.checkFeatureAccess('posts');
    if (!postsGuard.allowed) {
      res.status(postsGuard.status).json({ error: postsGuard.reason });
      return;
    }
    const updated = commentReactionService.editComment(req.params.id, req.user!.id, req.body?.content);
    res.json(updated);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('Only the author') ? 403 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.delete('/comments/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const result = commentReactionService.deleteComment(req.params.id, req.user!.id, req.user!.role);
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// --- Real-time SSE Stream (with stateless HMAC-signed tickets + serverless polling fallback) ---
apiRouter.post('/realtime/ticket', requireAuth, (req: Request, res: Response) => {
  if (!req.isAuthenticatedUser || !req.user) {
    res.status(401).json({ error: 'Authenticated session required for SSE ticket.' });
    return;
  }
  const ticket = signRealtimeTicket(req.user.id, 60_000);
  cache.set(`sse:ticket:${ticket}`, req.user, 60_000);
  res.json({
    ticket,
    expiresInMs: 60_000,
    mode: IS_SERVERLESS_RUNTIME ? 'polling' : 'sse',
    pollIntervalMs: 4000,
  });
});

apiRouter.get('/realtime/stream', (req: Request, res: Response) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  let user: any = req.user;
  let isExplicitAuth = Boolean(req.isAuthenticatedUser);
  if (req.query.ticket && typeof req.query.ticket === 'string') {
    const ticketKey = `sse:ticket:${req.query.ticket}`;
    const ticketUser = cache.get<any>(ticketKey);
    if (ticketUser) {
      cache.invalidate(ticketKey);
      user = ticketUser;
      isExplicitAuth = true;
    } else {
      const verifiedUserId = verifySignedRealtimeTicket(req.query.ticket);
      if (verifiedUserId) {
        const dbUser = db
          .prepare('SELECT id, matric_number, username, role, status FROM users WHERE id = ?')
          .get(verifiedUserId) as any;
        if (dbUser && dbUser.status === 'active') {
          user = dbUser;
          isExplicitAuth = true;
        }
      }
    }
  }
  // Security: Unauthenticated SSE connections subscribe only to anonymous public channel, never a private student's feed/messages
  const userId = isExplicitAuth && user?.id ? user.id : '__anon__';
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : undefined;

  if (IS_SERVERLESS_RUNTIME) {
    // On serverless hosts, avoid holding open HTTP sockets until function timeout; send initial state and instruct client to poll
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (isExplicitAuth && user?.id && clientId) {
      try {
        presenceService.recordHeartbeat(user.id, clientId, req.headers['user-agent']);
      } catch {
        // non-fatal
      }
    }
    const summary = presenceService.getOnlineSummary();
    res.write(`event: presence:count\ndata: ${JSON.stringify(summary)}\n\n`);
    res.write(
      `event: realtime:fallback\ndata: ${JSON.stringify({ mode: 'polling', pollIntervalMs: 4000 })}\n\n`
    );
    res.end();
    return;
  }

  sseManager.addClient(userId, res, {
    clientId,
    isAuthenticated: isExplicitAuth,
    userAgent: req.headers['user-agent'],
  });
});

apiRouter.get('/realtime/poll', (req: Request, res: Response) => {
  try {
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId.trim().slice(0, 128) : undefined;
    const isAuth = Boolean(req.isAuthenticatedUser && req.user?.id);
    if (isAuth && req.user && clientId) {
      try {
        presenceService.recordHeartbeat(req.user.id, clientId, req.headers['user-agent']);
      } catch {
        // non-fatal
      }
    }

    const presence = presenceService.getOnlineSummary();
    const config = adminControlService.getPublicPlatformConfig();

    if (!isAuth || !req.user) {
      res.json({
        serverTime: new Date().toISOString(),
        mode: IS_SERVERLESS_RUNTIME ? 'polling' : 'sse',
        presence,
        config,
      });
      return;
    }

    const notifications = notificationService.getUserNotifications(req.user.id, false, 20, 0);
    const chats = chatService.getUserChats(req.user.id);
    const canViewReportsInPoll =
      req.user.role === 'admin' ||
      (req.user.role === 'moderator' &&
        Boolean(moderatorService.getModeratorPermissions(req.user.id)?.canReviewReports));
    const adminReports = canViewReportsInPoll
      ? adminReportService.getAllReports('pending').slice(0, 10)
      : undefined;

    res.json({
      serverTime: new Date().toISOString(),
      mode: IS_SERVERLESS_RUNTIME ? 'polling' : 'sse',
      presence,
      config,
      notifications,
      chats,
      ...(adminReports ? { adminReports } : {}),
    });
  } catch {
    res.status(500).json({ error: 'Realtime poll failed.' });
  }
});

// --- Chats & Messenger ---
apiRouter.get('/chats', requireAuth, (req: Request, res: Response) => {
  const chats = chatService.getUserChats(req.user!.id);
  res.json(chats);
});

apiRouter.get('/chats/eligible-users', requireAuth, (req: Request, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const list = chatService.searchEligiblePartners(req.user!.id, query);
  res.json(list);
});

apiRouter.get('/chats/:id/messages', requireAuth, (req: Request, res: Response) => {
  try {
    if (req.query.paginated === '1' || req.query.paginated === 'true') {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      res.json(chatService.getChatMessagesPaginated(req.params.id, req.user!.id, limit, offset));
      return;
    }
    const messages = chatService.getChatMessages(req.params.id, req.user!.id);
    res.json(messages);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

apiRouter.post('/chats/:id/messages', requireAuth, requireNotRestricted, (req: Request, res: Response) => {
  try {
    const chatRow = db.prepare('SELECT type FROM chats WHERE id = ?').get(req.params.id) as { type?: string } | undefined;
    const featureKey = chatRow?.type === 'group' ? 'groups' : 'chats';
    const featureGuard = adminControlService.checkFeatureAccess(featureKey);
    if (!featureGuard.allowed) {
      res.status(featureGuard.status).json({ error: featureGuard.reason });
      return;
    }

    const maxMsgLen = Number(featureGuard.limits?.maxMessageLength || 2000);
    if (typeof req.body?.text === 'string' && req.body.text.trim().length > maxMsgLen) {
      res.status(400).json({ error: `Message exceeds configured limit of ${maxMsgLen} characters.` });
      return;
    }

    const message = chatService.sendMessage(req.params.id, req.user!.id, req.body);
    if (message?.location) {
      try {
        savedLocationService.autoSavePinnedLocation(req.user!.id, message.location, 'chat');
      } catch {
        // Non-fatal auto-pin persistence
      }
    }
    res.status(201).json(message);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const fallbackStatus = msg.includes('Access denied') || msg.includes('restricted') ? 403 : 400;
    sendApiMediaError(res, err, fallbackStatus);
  }
});

apiRouter.patch('/chats/:id/messages/:messageId', requireAuth, (req: Request, res: Response) => {
  try {
    const chatRow = db.prepare('SELECT type FROM chats WHERE id = ?').get(req.params.id) as { type?: string } | undefined;
    const featureKey = chatRow?.type === 'group' ? 'groups' : 'chats';
    const featureGuard = adminControlService.checkFeatureAccess(featureKey);
    if (!featureGuard.allowed) {
      res.status(featureGuard.status).json({ error: featureGuard.reason });
      return;
    }

    const maxMsgLen = Number(featureGuard.limits?.maxMessageLength || 2000);
    if (typeof req.body?.text === 'string' && req.body.text.trim().length > maxMsgLen) {
      res.status(400).json({ error: `Message exceeds configured limit of ${maxMsgLen} characters.` });
      return;
    }

    const updated = chatService.editMessage(
      req.params.id,
      req.params.messageId,
      req.user!.id,
      req.body?.text
    );
    res.json(updated);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('Only the sender') ? 403 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.delete('/chats/:id/messages/:messageId', requireAuth, (req: Request, res: Response) => {
  try {
    const result = chatService.deleteMessage(
      req.params.id,
      req.params.messageId,
      req.user!.id,
      req.user!.role
    );
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('Unauthorized') ? 403 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.post('/chats/:id/read', requireAuth, (req: Request, res: Response) => {
  try {
    const result = chatService.markChatAsRead(req.params.id, req.user!.id);
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    res.status(msg.includes('Access denied') ? 403 : 400).json({ error: msg });
  }
});

apiRouter.post('/chats/maintenance/purge-expired', requireRole('admin'), (req: Request, res: Response) => {
  const result = adminSecurityService.run72HourPurgeJob(req.user!.id);
  res.json(result);
});

// --- Communities & Groups ---
apiRouter.get('/communities', (req: Request, res: Response) => {
  const userId = req.user?.id || '';
  const communities = communityService.getAllCommunities(userId);
  res.json(communities);
});

apiRouter.post('/communities', requireAuth, (req: Request, res: Response) => {
  try {
    const commGuard = adminControlService.checkFeatureAccess('communities');
    if (!commGuard.allowed) {
      res.status(commGuard.status).json({ error: commGuard.reason });
      return;
    }
    const { name, acronym, category, description, location, leaders, rules, settings } = req.body;
    if (!name || !acronym || !category || !description || !location) {
      res.status(400).json({ error: 'Name, acronym, category, description, and location are required.' });
      return;
    }
    const community = communityService.createCommunity(req.user!.id, {
      name,
      acronym,
      category,
      description,
      location,
      leaders,
      rules,
      settings,
    });
    res.status(201).json(community);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/communities/:id', (req: Request, res: Response) => {
  const userId = req.user?.id || '';
  const comm = communityService.getCommunityById(req.params.id, userId);
  if (!comm) {
    res.status(404).json({ error: 'Community not found.' });
    return;
  }
  res.json(comm);
});

apiRouter.put('/communities/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const updated = communityService.editCommunity(
      req.params.id,
      req.user!.id,
      req.user!.role,
      req.body
    );
    res.json(updated);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

apiRouter.post('/communities/:id/toggle-join', requireAuth, (req: Request, res: Response) => {
  try {
    const result = communityService.toggleMembership(req.params.id, req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/communities/:id/members', (req: Request, res: Response) => {
  try {
    const viewerId = req.user?.id || '';
    const viewerRole = req.user?.role || 'student';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    if (req.query.paginated === '1' || req.query.paginated === 'true') {
      res.json(communityService.getCommunityMembersPaginated(req.params.id, limit, offset, viewerId, viewerRole));
      return;
    }
    const members = communityService.getCommunityMembers(req.params.id, limit, offset, viewerId, viewerRole);
    res.json(members);
  } catch (err: any) {
    const status = String(err?.message || '').includes('Access denied') ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.put('/communities/:id/members/:userId/role', requireAuth, (req: Request, res: Response) => {
  try {
    const { role } = req.body;
    if (role !== 'lead' && role !== 'moderator' && role !== 'member') {
      res.status(400).json({ error: 'Invalid role specified.' });
      return;
    }
    const result = communityService.updateMemberRole(
      req.params.id,
      req.user!.id,
      req.user!.role,
      req.params.userId,
      role
    );
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

apiRouter.delete('/communities/:id/members/:userId', requireAuth, (req: Request, res: Response) => {
  try {
    const result = communityService.removeMember(
      req.params.id,
      req.user!.id,
      req.user!.role,
      req.params.userId
    );
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

apiRouter.get('/communities/:id/posts', (req: Request, res: Response) => {
  try {
    const viewerId = req.user?.id || '';
    const viewerRole = req.user?.role || 'student';
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    if (req.query.paginated === '1' || req.query.paginated === 'true') {
      res.json(communityService.getCommunityPostsPaginated(req.params.id, viewerId, limit, offset, viewerRole));
      return;
    }
    const posts = communityService.getCommunityPosts(req.params.id, viewerId, limit, offset, viewerRole);
    res.json(posts);
  } catch (err: any) {
    const status = String(err?.message || '').includes('Access denied') ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.post('/communities/:id/posts', requireAuth, requireNotRestricted, requireTermsAccepted, (req: Request, res: Response) => {
  try {
    const commGuard = adminControlService.checkFeatureAccess('communities');
    if (!commGuard.allowed) {
      res.status(commGuard.status).json({ error: commGuard.reason });
      return;
    }
    const postsGuard = adminControlService.checkFeatureAccess('posts');
    const maxLen = Number(postsGuard.limits?.maxPostLength || 2000);
    if (typeof req.body?.content === 'string' && req.body.content.trim().length > maxLen) {
      res.status(400).json({ error: `Post exceeds configured maximum length of ${maxLen} characters.` });
      return;
    }
    const maxImgs = Number(postsGuard.limits?.maxImagesPerPost || 4);
    if (Array.isArray(req.body?.images) && req.body.images.length > maxImgs) {
      res.status(400).json({ error: `Maximum of ${maxImgs} images allowed per post.` });
      return;
    }
    const post = communityService.createCommunityPost(
      req.params.id,
      req.user!.id,
      req.body
    );
    if (post?.location) {
      try {
        savedLocationService.autoSavePinnedLocation(req.user!.id, post.location, 'post');
      } catch {
        // Non-fatal auto-pin persistence
      }
    }
    res.status(201).json(post);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const fallbackStatus =
      msg.includes('Only community') || msg.includes('must be a member') || msg.includes('disabled')
        ? 403
        : 400;
    sendApiMediaError(res, err, fallbackStatus);
  }
});

// --- Campus & Off-Campus Landmarks ---
apiRouter.get('/landmarks', (req: Request, res: Response) => {
  const zone = typeof req.query.zone === 'string' ? req.query.zone : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const isOffCampus = req.query.off_campus === 'true' ? true : req.query.off_campus === 'false' ? false : undefined;

  const landmarks = landmarkService.getAllLandmarks({ zone, category, search, isOffCampus });
  sendPublicCachedJson(req, res, landmarks, 30, 60);
});

apiRouter.get('/landmarks/:id', (req: Request, res: Response) => {
  const landmark = landmarkService.getLandmarkById(req.params.id);
  if (!landmark) {
    res.status(404).json({ error: 'Landmark not found.' });
    return;
  }
  sendPublicCachedJson(req, res, landmark, 30, 60);
});

// --- Saved Locations & Search History (Strictly Authenticated & User-Scoped) ---
apiRouter.get('/locations/saved', requireAuth, (req: Request, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const rawFilter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    const filter = ['all', 'pinned', 'saved', 'off_campus', 'on_campus'].includes(rawFilter)
      ? (rawFilter as 'all' | 'pinned' | 'saved' | 'off_campus' | 'on_campus')
      : 'all';
    res.json(savedLocationService.getLocationsOverview(req.user!.id, { search, filter }));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to load saved locations.' });
  }
});

apiRouter.post('/locations/saved', requireAuth, (req: Request, res: Response) => {
  try {
    const saved = savedLocationService.saveOrPinLocation(req.user!.id, req.body || {});
    res.status(201).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to save location.' });
  }
});

apiRouter.patch('/locations/saved/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const updated = savedLocationService.updateSavedLocation(req.user!.id, req.params.id, req.body || {});
    res.json(updated);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.delete('/locations/saved/:id', requireAuth, (req: Request, res: Response) => {
  try {
    res.json(savedLocationService.deleteSavedLocation(req.user!.id, req.params.id));
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.get('/locations/history', requireAuth, (req: Request, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
    res.json(savedLocationService.listSearchHistory(req.user!.id, { search, limit }));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to load location search history.' });
  }
});

apiRouter.post('/locations/history', requireAuth, (req: Request, res: Response) => {
  try {
    const item = savedLocationService.recordSearchHistory(req.user!.id, req.body || {});
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to record search history.' });
  }
});

apiRouter.delete('/locations/history', requireAuth, (req: Request, res: Response) => {
  try {
    res.json(savedLocationService.clearSearchHistory(req.user!.id));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to clear search history.' });
  }
});

apiRouter.delete('/locations/history/:id', requireAuth, (req: Request, res: Response) => {
  try {
    res.json(savedLocationService.deleteSearchHistoryItem(req.user!.id, req.params.id));
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

// --- Notices & Announcements (Official University Bulletins) ---
apiRouter.get('/notices', (req: Request, res: Response) => {
  const notices = cache.getOrCompute('notices:all', 30000, () =>
    withReadConnection((conn) => {
      const rows = conn.prepare(`
        SELECT *
        FROM announcements
        ORDER BY created_at DESC
      `).all() as any[];

      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        source: r.source,
        category: r.category,
        date: r.date_str,
        summary: r.summary,
        fullBody: r.full_body,
        verified: Boolean(r.is_verified),
        urgency: r.urgency,
        readTime: r.read_time,
      }));
    })
  );

  sendPublicCachedJson(req, res, notices, 30, 60);
});

// --- Notifications ---
apiRouter.get('/notifications', requireAuth, (req: Request, res: Response) => {
  const unreadOnly = req.query.unread === 'true';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  if (req.query.paginated === '1' || req.query.paginated === 'true') {
    res.json(notificationService.getUserNotificationsPaginated(req.user!.id, unreadOnly, limit, offset));
    return;
  }
  const list = notificationService.getUserNotifications(req.user!.id, unreadOnly, limit, offset);
  res.json(list);
});

apiRouter.post('/notifications/:id/read', requireAuth, (req: Request, res: Response) => {
  res.json(notificationService.markAsRead(req.params.id, req.user!.id));
});

apiRouter.post('/notifications/read-all', requireAuth, (req: Request, res: Response) => {
  res.json(notificationService.markAllAsRead(req.user!.id));
});

// --- File Storage ---
apiRouter.post('/files/upload', requireAuth, (req: Request, res: Response) => {
  try {
    const { dataUrl, thumbnailDataUrl } = req.body;
    if (!dataUrl) {
      res.status(400).json({ error: 'Missing image data.' });
      return;
    }

    const protection = deletionService.isStorageProtectionActive();
    const saved = fileService.saveBase64Image(dataUrl, req.user!.id, {
      thumbnailDataUrl: !protection.active && typeof thumbnailDataUrl === 'string' ? thumbnailDataUrl : undefined,
      maxBytesOverride: protection.active ? PROTECTION_MODE_MAX_UPLOAD_BYTES : undefined,
    });
    res.status(201).json(saved);
  } catch (err: any) {
    sendApiMediaError(res, err, 400);
  }
});

apiRouter.get('/uploads/:filename', (req: Request, res: Response) => {
  const policy = fileService.getFileServePolicy(req.params.filename);
  if (!policy.accessible) {
    res.status(404).json({ error: 'File not found or expired after 72 hours.' });
    return;
  }
  if (policy.isPrivateChatMedia) {
    if (!req.user || !req.sessionTokenHash) {
      res.status(401).json({ error: 'Authentication required to view private chat attachments.' });
      return;
    }
    if (!fileService.canUserAccessFile(policy, req.user.id, req.user.role)) {
      res.status(403).json({ error: 'Forbidden. Only conversation participants may access private chat media.' });
      return;
    }
  }
  const filePath = fileService.getUploadPath(req.params.filename);
  if (!filePath) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }
  res.removeHeader('Pragma');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

  if (policy.isPrivateChatMedia) {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
  } else if (policy.isAvatar) {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('CDN-Cache-Control', 'public, max-age=86400');
  } else if (policy.expiresAtMs !== null) {
    const remainingSec = Math.max(0, Math.floor((policy.expiresAtMs - Date.now()) / 1000));
    if (remainingSec <= 0) {
      res.status(404).json({ error: 'File not found or expired after 72 hours.' });
      return;
    }
    const maxAge = Math.min(3600, remainingSec);
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.setHeader('CDN-Cache-Control', `public, max-age=${maxAge}`);
    res.setHeader('Expires', new Date(policy.expiresAtMs).toUTCString());
  }

  res.sendFile(filePath);
});

// --- Reports & Moderation ---
apiRouter.post('/reports', requireAuth, (req: Request, res: Response) => {
  try {
    const report = adminReportService.createReport(req.user!.id, req.body);
    res.status(201).json(report);
  } catch (err: any) {
    const msg = String(err?.message || 'Unable to submit report.');
    const status = msg.includes('already reported')
      ? 409
      : msg.includes('no longer exists')
      ? 404
      : 400;
    res.status(status).json({ error: msg });
  }
});

// --- Single Admin Role Complete Control API ---
apiRouter.get('/admin/dashboard', requireRole('admin'), (_req: Request, res: Response) => {
  try {
    const stats = adminSecurityService.getDashboardStatistics();
    res.json(stats);
  } catch {
    res.status(500).json({ error: 'Unable to retrieve dashboard statistics.' });
  }
});

// Moderation Reports Management
apiRouter.get('/admin/reports', requireRole('admin'), (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(adminReportService.getAllReports(status));
});

apiRouter.patch('/admin/reports/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const { status, resolutionNotes, actionTaken } = req.body || {};
    const cleanAction = typeof actionTaken === 'string' && actionTaken.trim() ? actionTaken.trim().slice(0, 120) : undefined;
    const result = adminReportService.updateReportStatus(
      req.params.id,
      req.user!.id,
      status,
      resolutionNotes,
      cleanAction
    );
    res.json(result);
  } catch (err: any) {
    const code = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(code).json({ error: err.message });
  }
});

// Users & Accounts Management
apiRouter.get('/admin/users', requireRole('admin'), (req: Request, res: Response) => {
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const role = typeof req.query.role === 'string' ? req.query.role : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(adminControlService.listUsers(search, role, status));
});

apiRouter.post('/admin/users', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const created = adminControlService.createUserByAdmin(req.user!.id, req.body);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/admin/users/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const updated = adminControlService.updateUserProfileByAdmin(req.user!.id, req.params.id, req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Moderation Actions: Warnings
apiRouter.post('/admin/users/:id/warn', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const { reason, severity, details } = req.body;
    if (!reason) {
      res.status(400).json({ error: 'Warning reason is required.' });
      return;
    }
    const result = adminSecurityService.issueWarning(
      req.user!.id,
      req.user!.role,
      req.params.id,
      reason,
      severity || 'standard',
      details
    );
    res.status(201).json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('not found') ? 404 : msg.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

// Moderation Actions: User Suspensions
apiRouter.post('/admin/users/:id/suspend', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const { durationDays, reason } = req.body || {};
    const rawDays = durationDays === undefined || durationDays === null || durationDays === '' ? 7 : Number(durationDays);
    if (!Number.isFinite(rawDays) || rawDays < 1 || rawDays > 365) {
      res.status(400).json({ error: 'Suspension duration must be between 1 and 365 days.' });
      return;
    }
    const result = adminSecurityService.suspendUser(
      req.user!.id,
      req.user!.role,
      req.params.id,
      Math.floor(rawDays),
      reason || 'Violation of Campus Guidelines'
    );
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('not found') ? 404 : msg.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.post('/admin/users/:id/unsuspend', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const { reason } = req.body || {};
    const result = adminSecurityService.unsuspendUser(
      req.user!.id,
      req.user!.role,
      req.params.id,
      reason
    );
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = msg.includes('not found') ? 404 : msg.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

// Appeals System
apiRouter.get('/admin/appeals', requireRole('admin'), (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(adminSecurityService.getAppeals(status));
});

apiRouter.post('/appeals', requireAuth, (req: Request, res: Response) => {
  try {
    const { type, statement, targetId } = req.body;
    if (!type || !statement) {
      res.status(400).json({ error: 'Appeal type and statement are required.' });
      return;
    }
    const appeal = adminSecurityService.submitAppeal(
      req.user!.id,
      type,
      statement,
      targetId
    );
    res.status(201).json(appeal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/appeals/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const { status, reviewNotes } = req.body;
    if (status !== 'accepted' && status !== 'rejected') {
      res.status(400).json({ error: 'Appeal status must be "accepted" or "rejected".' });
      return;
    }
    const result = adminSecurityService.reviewAppeal(
      req.user!.id,
      req.user!.role,
      req.params.id,
      status,
      reviewNotes
    );
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// Staff Roster & Single Admin Role Assignment (RBAC)
apiRouter.get('/admin/staff', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminSecurityService.getStaffRoster());
});

apiRouter.post('/admin/staff/role', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  try {
    const { userId, role } = req.body;
    if (!userId || !role) {
      res.status(400).json({ error: 'User ID and new role are required.' });
      return;
    }
    const result = adminSecurityService.assignStaffRole(
      req.user!.id,
      req.user!.role,
      userId,
      role
    );
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// Content, Chats & Notifications Control
apiRouter.get('/admin/content', requireRole('admin'), (req: Request, res: Response) => {
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  res.json(adminControlService.listContentOverview(search));
});

apiRouter.post('/admin/posts', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const created = adminControlService.createAdminPost(req.user!.id, req.body || {});
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/posts/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.updatePostByAdmin(req.user!.id, req.params.id, req.body || {}));
  } catch (err: any) {
    const status = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.patch('/admin/posts/:id/visibility', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.togglePostVisibility(req.user!.id, req.params.id, Boolean(req.body?.hidden)));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/posts/:id/pin', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.togglePostPinned(req.user!.id, req.params.id, Boolean(req.body?.pinned)));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/posts/:id/feature', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(
      adminControlService.togglePostFeatured(
        req.user!.id,
        req.params.id,
        Boolean(req.body?.featured),
        req.body?.distributionScope
      )
    );
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/admin/users/:id/lift-restriction', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.liftUserRestriction(req.user!.id, req.params.id, req.body?.reason));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/admin/posts/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const result = postService.deletePost(req.params.id, req.user!.id, req.user!.role);
    adminSecurityService.logAdminAction(req.user!.id, 'ADMIN_DELETE_POST', 'post', req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

apiRouter.delete('/admin/comments/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const result = commentReactionService.deleteComment(req.params.id, req.user!.id, req.user!.role);
    adminSecurityService.logAdminAction(req.user!.id, 'ADMIN_DELETE_COMMENT', 'comment', req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

apiRouter.get('/admin/chats', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminControlService.listChatsModerationOverview());
});

apiRouter.post('/admin/chats/:id/inspect', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.inspectChatForModeration(req.user!.id, req.params.id, req.body?.reason || ''));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/admin/chats/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.deleteChatByAdmin(req.user!.id, req.params.id, req.body?.reason || 'Removed by Admin moderation'));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/admin/notifications', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminControlService.listRecentNotifications());
});

apiRouter.post('/admin/notifications/broadcast', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.status(201).json(adminControlService.broadcastNotification(req.user!.id, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Communities Control
apiRouter.get('/admin/communities', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminControlService.listCommunitiesAdmin());
});

apiRouter.patch('/admin/communities/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.updateCommunityAdmin(req.user!.id, req.params.id, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/admin/communities/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.deleteCommunityAdmin(req.user!.id, req.params.id));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Data Lifecycle, 10 GB Storage Quota & Orphaned Files Cleanup
apiRouter.get('/admin/storage', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminControlService.getStorageOverview());
});

apiRouter.post('/admin/storage/clean-orphans', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  if (req.body?.confirmation !== 'CLEAN_ORPHANS') {
    res.status(400).json({ error: 'Explicit confirmation ("CLEAN_ORPHANS") is required before deleting orphaned files.' });
    return;
  }
  try {
    res.json(adminControlService.cleanOrphanedFiles(req.user!.id));
  } catch {
    res.status(500).json({ error: 'Unable to clean orphaned files.' });
  }
});

apiRouter.post('/admin/storage/clear-cache', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.clearExpiredCaches(req.user!.id));
  } catch {
    res.status(500).json({ error: 'Unable to clear expired caches.' });
  }
});

apiRouter.get('/admin/storage/report', requireRole('admin'), (req: Request, res: Response) => {
  res.json(adminControlService.generateStorageReport(req.user!.id));
});

apiRouter.post('/admin/jobs/purge-72h', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const summary = adminSecurityService.run72HourPurgeJob(req.user!.id);
    res.json(summary);
  } catch {
    res.status(500).json({ error: '72-hour purge job encountered an internal error.' });
  }
});

// Permanent Account Deletion ("Right to be Forgotten" / App Store Guideline 5.1.1)
apiRouter.post('/user/delete-account', requireAuth, (req: Request, res: Response) => {
  try {
    const { confirmation, reason, password } = req.body || {};
    if (confirmation !== 'PERMANENTLY_DELETE') {
      res.status(400).json({
        error: 'Please confirm deletion by typing PERMANENTLY_DELETE.',
      });
      return;
    }

    if (typeof password === 'string' && password.length > 0) {
      authService.reauthenticate(req.user!.id, password, req.ip || req.socket.remoteAddress);
    } else if (!hasRecentReauth(req.user)) {
      res.status(403).json({
        error: 'Please enter your current password or re-authenticate to permanently delete your account.',
        code: 'REAUTH_REQUIRED',
      });
      return;
    }

    const result = adminSecurityService.deleteUserPermanently(
      req.user!.id,
      req.user!.id,
      reason || 'Student requested voluntary account deletion'
    );
    clearSessionCookie(req, res);
    res.json(result);
  } catch (err: any) {
    const status = err?.status === 429 ? 429 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.delete('/admin/users/:id', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  try {
    const { reason, confirmation } = req.body || {};
    if (confirmation && confirmation !== 'PERMANENTLY_DELETE') {
      res.status(400).json({ error: 'Invalid deletion confirmation.' });
      return;
    }
    const result = adminSecurityService.deleteUserPermanently(
      req.params.id,
      req.user!.id,
      reason || 'Admin permanent account erasure'
    );
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// Backup Snapshots & Restoration
apiRouter.post('/admin/backups/create', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const backup = adminSecurityService.createBackup(req.user!.id, req.user!.role);
    res.status(201).json(backup);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

apiRouter.get('/admin/backups', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminSecurityService.getBackups());
});

apiRouter.post('/admin/backups/:id/restore', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  try {
    const result = adminSecurityService.restoreBackup(req.user!.id, req.user!.role, req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// Security & RFC-6238 TOTP MFA Control
apiRouter.get('/admin/security', requireRole('admin'), (req: Request, res: Response) => {
  res.json(adminControlService.getSecurityOverview(req.user!.id));
});

apiRouter.post('/admin/security/mfa/setup', requireRole('admin'), (req: Request, res: Response) => {
  res.json(adminControlService.initiateAdminMfaSetup(req.user!.id, req.user!.username || req.user!.matric_number || '@THEBACKDOOR'));
});

apiRouter.post('/admin/security/mfa/verify', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.verifyAndEnableAdminMfa(req.user!.id, req.body?.code || ''));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/admin/security/mfa/disable', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.disableAdminMfa(req.user!.id, req.body?.password || ''));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/admin/security/sessions/revoke', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  const token = extractSessionToken(req) || undefined;
  res.json(adminControlService.revokeExpiredOrAllSessions(req.user!.id, token));
});

apiRouter.get('/admin/security/sessions', requireRole('admin'), (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({
    maxActiveDevices: SESSION_POLICY.maxActiveDevices,
    sessions: adminControlService.listActiveSessionsForAdmin(limit),
  });
});

apiRouter.delete('/admin/security/sessions/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.revokeSessionByAdmin(req.user!.id, req.params.id, req.body?.reason));
  } catch (err: any) {
    res.status(404).json({ error: err?.message || 'Active session not found.' });
  }
});

apiRouter.post('/admin/security/users/:id/revoke-sessions', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.revokeUserSessionsByAdmin(req.user!.id, req.params.id, req.body?.reason));
  } catch (err: any) {
    res.status(404).json({ error: err?.message || 'User not found.' });
  }
});

apiRouter.get('/admin/security/events', requireRole('admin'), (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 40));
  const severity = typeof req.query.severity === 'string' ? req.query.severity : undefined;
  res.json({ events: adminControlService.listSecurityEvents(limit, severity) });
});

// Feature Flags & Website Settings Control
apiRouter.get('/admin/features', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminControlService.getPublicPlatformConfig().features);
});

apiRouter.post('/admin/features', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.status(201).json(adminControlService.registerConfigurableFeature(req.user!.id, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/features/:key', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminControlService.updateFeature(req.user!.id, req.params.key, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/admin/settings', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminControlService.getPublicPlatformConfig().settings);
});

apiRouter.put('/admin/settings', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  try {
    res.json(adminControlService.updateWebsiteSettings(req.user!.id, req.body || {}));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Administrative Audit Logs
apiRouter.get('/admin/audit-logs', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminSecurityService.getAuditLogs(100));
});

// Complete Real-DB Analytics & Exportable Reports (Admin Only)
apiRouter.get('/admin/analytics', requireRole('admin'), (req: Request, res: Response) => {
  const range = (typeof req.query.range === 'string' ? req.query.range : '7d') as AnalyticsRange;
  res.json(adminAnalyticsService.getComprehensiveAnalytics(range));
});

apiRouter.get('/admin/analytics/export', requireRole('admin'), (req: Request, res: Response) => {
  const range = (typeof req.query.range === 'string' ? req.query.range : '7d') as AnalyticsRange;
  const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'csv';
  if (format === 'json') {
    const payload = adminAnalyticsService.getComprehensiveAnalytics(range);
    res.setHeader('Content-Disposition', `attachment; filename="schoolbackdoor-analytics-${range}.json"`);
    res.json(payload);
    return;
  }
  const csv = adminAnalyticsService.exportAnalyticsCsv(range);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="schoolbackdoor-analytics-${range}.csv"`);
  res.send(csv);
});

// Moderator Accounts & Granular Permissions (Admin Only)
apiRouter.get('/admin/moderators', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(moderatorService.listModerators());
});

apiRouter.post('/admin/moderators', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  try {
    const created = moderatorService.assignModerator(req.user!.id, req.body || {});
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/moderators/:id/permissions', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  try {
    const updated = moderatorService.updateModeratorPermissions(req.user!.id, req.params.id, req.body || {});
    res.json(updated);
  } catch (err: any) {
    const status = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.delete('/admin/moderators/:id', requireRole('admin'), requireRecentReauth, (req: Request, res: Response) => {
  try {
    res.json(moderatorService.revokeModerator(req.user!.id, req.params.id));
  } catch (err: any) {
    const status = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// Advertisements & Payment Records (Admin Only — student social features remain 100% free)
apiRouter.get('/advertisements/active', (req: Request, res: Response) => {
  const area = typeof req.query.area === 'string' ? req.query.area : 'all';
  const placement = typeof req.query.placement === 'string' ? req.query.placement : 'feed';
  res.json(adminAdsPaymentsService.getActiveAdvertisements(area, placement));
});

apiRouter.post('/advertisements/:id/event', (req: Request, res: Response) => {
  try {
    const eventType = req.body?.eventType === 'click' ? 'click' : 'impression';
    res.json(adminAdsPaymentsService.recordAdEvent(req.params.id, eventType));
  } catch (err: any) {
    const status = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.get('/admin/advertisements', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(adminAdsPaymentsService.listAdvertisements());
});

apiRouter.post('/admin/advertisements', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const ad = adminAdsPaymentsService.createAdvertisement(req.user!.id, req.body || {});
    res.status(201).json(ad);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/advertisements/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminAdsPaymentsService.updateAdvertisement(req.user!.id, req.params.id, req.body || {}));
  } catch (err: any) {
    const status = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.delete('/admin/advertisements/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminAdsPaymentsService.deleteAdvertisement(req.user!.id, req.params.id));
  } catch (err: any) {
    const status = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.get('/admin/payment-records', requireRole('admin'), (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  res.json(adminAdsPaymentsService.listPaymentRecords({ status, search }));
});

apiRouter.post('/admin/payment-records', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const record = adminAdsPaymentsService.createPaymentRecord(req.user!.id, req.body || {});
    res.status(201).json(record);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/admin/payment-records/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(adminAdsPaymentsService.updatePaymentRecordStatus(req.user!.id, req.params.id, req.body?.status, req.body?.notes));
  } catch (err: any) {
    const status = String(err?.message || '').includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// =========================================================================
// MODERATOR DESK API (Strictly scoped permissions, zero Admin/Finance/Settings)
// =========================================================================
function handleModError(res: Response, err: any) {
  if (err instanceof ForbiddenModeratorActionError || String(err?.message || '').startsWith('Forbidden')) {
    res.status(403).json({ error: err.message, code: (err as any)?.code || 'FORBIDDEN' });
    return;
  }
  const msg = String(err?.message || 'Moderation action failed.');
  const status = msg.includes('not found') ? 404 : 400;
  res.status(status).json({ error: msg });
}

apiRouter.get('/mod/dashboard', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    res.json(moderatorService.getModeratorDashboard(req.user!.id, req.user!.role));
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.get('/mod/reports', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const scope = (typeof req.query.scope === 'string' ? req.query.scope : 'all') as 'all' | 'assigned' | 'escalated';
    res.json(moderatorService.listReportsForModerator(req.user!.id, req.user!.role, { status, scope }));
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.patch('/mod/reports/:id', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    const { status, resolutionNotes, actionTaken } = req.body || {};
    res.json(
      moderatorService.reviewReportByModerator(
        req.user!.id,
        req.user!.role,
        req.params.id,
        status,
        resolutionNotes,
        actionTaken
      )
    );
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.post('/mod/reports/:id/escalate', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    res.json(moderatorService.escalateReportToAdmin(req.user!.id, req.user!.role, req.params.id, req.body?.reason || ''));
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.patch('/mod/content/:type/:id', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    const rawType = String(req.params.type || '').trim();
    if (rawType !== 'post' && rawType !== 'comment') {
      res.status(400).json({ error: 'Invalid moderation target type. Allowed: post, comment.' });
      return;
    }
    const rawAction = String(req.body?.action || '').trim();
    if (rawAction !== 'hide' && rawAction !== 'unhide' && rawAction !== 'remove') {
      res.status(400).json({ error: 'Invalid moderation action. Allowed: hide, unhide, remove.' });
      return;
    }
    res.json(
      moderatorService.moderateContentByModerator(
        req.user!.id,
        req.user!.role,
        rawType,
        req.params.id,
        rawAction,
        req.body?.reason || ''
      )
    );
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.post('/mod/users/:id/warn', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    const { reason, severity, details } = req.body || {};
    res.status(201).json(
      moderatorService.warnUserByModerator(req.user!.id, req.user!.role, req.params.id, reason, severity || 'standard', details)
    );
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.post('/mod/users/:id/restrict', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    const hours = Number(req.body?.durationHours ?? req.body?.hours ?? 24);
    const reason = req.body?.reason || '';
    res.json(moderatorService.restrictUserByModerator(req.user!.id, req.user!.role, req.params.id, hours, reason));
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.get('/mod/communities', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    res.json(moderatorService.listCommunitiesForModerator(req.user!.id, req.user!.role));
  } catch (err: any) {
    handleModError(res, err);
  }
});

apiRouter.get('/mod/history', requireRole('moderator', 'admin'), (req: Request, res: Response) => {
  try {
    const scope = req.query.scope === 'team' ? 'team' : 'mine';
    res.json(moderatorService.getModerationHistory(req.user!.id, req.user!.role, scope));
  } catch (err: any) {
    handleModError(res, err);
  }
});

// Explicit JSON 404 for unknown or removed /api/* endpoints (prevents falling through to SPA HTML)
apiRouter.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import zlib from 'node:zlib';
import { initDatabase, db, checkpointDatabase, closeReadPool } from './db/database';
import { seedInitialData } from './db/seed';
import { apiRouter } from './routes/api';
import { presenceService } from './services/presenceService';
import { adminSecurityService } from './services/adminSecurityService';
import { adminControlService } from './services/adminControlService';
import { deletionService } from './services/deletionService';
import { sseManager } from './realtime/sseManager';
import { logger } from './utils/logger';
import { authService, AuthRateLimitError, verifyPassword } from './services/authService';
import { recordSecurityEvent } from './utils/security';

export interface CreateExpressAppOptions {
  isProduction?: boolean;
  startBackgroundWorkers?: boolean;
}

export interface ExpressAppBundle {
  app: Express;
  runServerlessMaintenanceTick: () => void;
  shutdown: () => void;
}

/**
 * Lightweight zero-dependency Brotli + Gzip compression middleware for API JSON and text/CSV payloads >= 1KB.
 * Skips SSE streams and pre-compressed binary uploads.
 */
function compressionMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path.includes('/realtime/stream') || req.path.includes('/uploads/')) {
    next();
    return;
  }

  const acceptEncoding = String(req.headers['accept-encoding'] || '').toLowerCase();
  const encoding: 'br' | 'gzip' | null = acceptEncoding.includes('br')
    ? 'br'
    : acceptEncoding.includes('gzip')
      ? 'gzip'
      : null;

  if (!encoding) {
    next();
    return;
  }

  const compressBuffer = (buf: Buffer): Buffer => {
    if (encoding === 'br') {
      return zlib.brotliCompressSync(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        },
      });
    }
    return zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_SPEED });
  };

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (body: any) => {
    try {
      const jsonStr = JSON.stringify(body);
      const buf = Buffer.from(jsonStr, 'utf8');
      if (buf.length < 1024) {
        return originalJson(body);
      }
      const compressed = compressBuffer(buf);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', compressed.length);
      return originalSend(compressed);
    } catch {
      return originalJson(body);
    }
  };

  res.send = (body?: any) => {
    if (res.getHeader('Content-Encoding') || typeof body !== 'string') {
      return originalSend(body);
    }
    try {
      const ct = String(res.getHeader('Content-Type') || 'text/html');
      const isTextLike = /json|text|csv|javascript|xml|svg/i.test(ct);
      if (!isTextLike) {
        return originalSend(body);
      }
      const buf = Buffer.from(body, 'utf8');
      if (buf.length < 1024) {
        return originalSend(body);
      }
      const compressed = compressBuffer(buf);
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', compressed.length);
      return originalSend(compressed);
    } catch {
      return originalSend(body);
    }
  };

  next();
}

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCompliancePage(title: string, badge: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="index, follow" />
  <title>${escapeHtml(title)} — Schoolbackdoor</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #F5EFE3; color: #171613; line-height: 1.6;
    }
    .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
    .top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid rgba(23,22,19,0.12); margin-bottom: 28px; }
    .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: #171613; font-weight: 700; font-size: 18px; }
    .brand img { width: 32px; height: 32px; border-radius: 8px; }
    .nav { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
    .nav a { color: #171613; text-decoration: none; padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(23,22,19,0.14); background: #FFFCF7; }
    .card { background: #FFFCF7; border: 1px solid rgba(23,22,19,0.12); border-radius: 20px; padding: 24px; box-shadow: 0 8px 24px rgba(23,22,19,0.04); }
    .badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; background: #F6E2E6; color: #8F3E5B; margin-bottom: 10px; }
    h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.2; font-family: Georgia, serif; }
    h2 { margin: 22px 0 8px; font-size: 18px; font-family: Georgia, serif; }
    p, li { font-size: 14px; color: #3A352E; }
    ul { padding-left: 20px; }
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 5px; }
    .field input { width: 100%; padding: 11px 12px; border-radius: 12px; border: 1px solid rgba(23,22,19,0.2); background: #FFFFFF; font-size: 14px; color: #171613; }
    .btn { display: inline-block; background: #171613; color: #F5EFE3; border: none; border-radius: 999px; padding: 11px 20px; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; }
    .btn-danger { background: #9F2D4E; color: #FFFFFF; }
    .alert { padding: 12px 14px; border-radius: 12px; font-size: 13px; margin-bottom: 16px; border: 1px solid rgba(23,22,19,0.14); }
    .alert-err { background: #F6E2E6; border-color: #C4718E; color: #6E233E; }
    .alert-ok { background: #E3EFE6; border-color: #6E9E7B; color: #1F4E2D; }
    footer { margin-top: 28px; font-size: 12px; color: #6B6359; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <a class="brand" href="/">
        <img src="/assets/aistudio/cbl_1989ed48.png" alt="Schoolbackdoor" />
        <span>Schoolbackdoor</span>
      </a>
      <nav class="nav">
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms &amp; Guidelines</a>
        <a href="/support">Support</a>
        <a href="/account-deletion">Account Deletion</a>
      </nav>
    </div>
    <main class="card">
      <span class="badge">${escapeHtml(badge)}</span>
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
    </main>
    <footer>Schoolbackdoor · Independent Student Social Network · <a href="/" style="color:#171613;">Return to App</a></footer>
  </div>
</body>
</html>`;
}

export function attachJsonErrorHandler(app: Express) {
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const rawStatus =
      err?.type === 'entity.too.large'
        ? 413
        : typeof err?.status === 'number'
          ? err.status
          : 400;
    const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
    const code =
      err?.type === 'entity.too.large'
        ? 'IMAGE_TOO_LARGE'
        : status < 500 && typeof err?.code === 'string'
          ? err.code
          : undefined;
    const message =
      err?.type === 'entity.too.large'
        ? 'Image upload exceeds the maximum allowed size of 20MB.'
        : err?.type === 'entity.parse.failed'
          ? 'Malformed JSON request payload.'
          : status >= 500
            ? 'Internal server error.'
            : err?.message || 'Request failed.';
    res.status(status).json({
      success: false,
      message,
      error: message,
      ...(code ? { code } : {}),
    });
  });
}

export function createExpressApp(options: CreateExpressAppOptions = {}): ExpressAppBundle {
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';
  const startBackgroundWorkers = options.startBackgroundWorkers ?? true;

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  logger.info('Database', 'Initializing SQLite database schema...');
  initDatabase();
  logger.info('Database', 'Seeding initial campus data...');
  seedInitialData();
  adminControlService.ensurePlatformDefaults();
  logger.info('Database', 'Ready.');

  let lastSweepAt = Date.now();
  const initialPurge = adminSecurityService.run72HourPurgeJob('u-system-job');
  const initialStorage = deletionService.getDetailedStorageMetrics();
  logger.info('ExpiryWorker', 'Initialized 72-hour lifecycle sweep', {
    postsPurged: initialPurge.postsPurged,
    messagesPurged: initialPurge.messagesPurged,
    filesDeleted: initialPurge.filesDeleted,
    storageUsagePercent: initialStorage.usagePercent,
    alertLevel: initialStorage.alertLevel,
  });

  const runServerlessMaintenanceTick = () => {
    const now = Date.now();
    if (now - lastSweepAt < 10 * 60 * 1000) return;
    lastSweepAt = now;
    try {
      adminSecurityService.run72HourPurgeJob('u-system-job');
      presenceService.expireInactivePresence();
    } catch {
      // non-fatal serverless sweep
    }
  };

  let expiryInterval: ReturnType<typeof setInterval> | null = null;
  let presenceSweepInterval: ReturnType<typeof setInterval> | null = null;

  if (startBackgroundWorkers) {
    expiryInterval = setInterval(() => {
      try {
        const outcome = adminSecurityService.run72HourPurgeJob('u-system-job');
        const storage = deletionService.getDetailedStorageMetrics();
        if (outcome.postsPurged > 0 || outcome.messagesPurged > 0 || outcome.filesDeleted > 0 || storage.alertLevel !== 'ok') {
          logger.info('ExpiryStorageWorker', 'Completed scheduled sweep', {
            postsPurged: outcome.postsPurged,
            messagesPurged: outcome.messagesPurged,
            filesDeleted: outcome.filesDeleted,
            freedBytes: outcome.freedBytes,
            storageUsagePercent: storage.usagePercent,
            alertLevel: storage.alertLevel,
          });
        }
      } catch (e: any) {
        logger.warn('ExpiryWorker', 'Scheduled sweep failed', { message: e?.message });
      }
    }, 10 * 60 * 1000);
    expiryInterval.unref();

    presenceSweepInterval = setInterval(() => {
      try {
        const purged = presenceService.expireInactivePresence();
        if (purged.purgedUsers > 0) {
          sseManager.broadcastPresenceUpdate(presenceService.getOnlineSummary());
        }
      } catch (e: any) {
        logger.warn('PresenceWorker', 'Error expiring inactive presence', { message: e?.message });
      }
    }, 30 * 1000);
    presenceSweepInterval.unref();
  }

  app.use(express.json({ limit: '32mb' }));
  app.use(express.urlencoded({ extended: true, limit: '32mb' }));
  app.use(compressionMiddleware);

  const rawAllowedOrigins = [
    process.env.APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
    ...(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ].filter(Boolean) as string[];

  const explicitAllowedOrigins = new Set(
    rawAllowedOrigins
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          return o.replace(/\/+$/, '');
        }
      })
      .filter(Boolean)
  );

  app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header('X-Download-Options', 'noopen');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    if (isProduction) {
      res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (!req.path.startsWith('/api')) {
      const connectSrc = [
        "'self'",
        'https://tile.openstreetmap.org',
        'https://*.tile.openstreetmap.org',
        'https://nominatim.openstreetmap.org',
        'https://router.project-osrm.org',
      ];
      for (const allowedOrigin of explicitAllowedOrigins) {
        if (/^https?:\/\//i.test(allowedOrigin)) {
          connectSrc.push(allowedOrigin);
        }
      }
      if (!isProduction) {
        connectSrc.push('ws://localhost:*', 'ws://127.0.0.1:*');
      }

      res.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
          "font-src 'self' https://fonts.gstatic.com data:",
          "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https:",
          `connect-src ${connectSrc.join(' ')}`,
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ')
      );
    }

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string' ? req.headers['x-forwarded-host'].split(',')[0].trim() : '';
    const hostHeader = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');
    let isAllowedOrigin = false;
    let isExplicitCrossOrigin = false;

    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        const sameHost = Boolean(hostHeader) && parsedOrigin.host === hostHeader;
        const explicitMatch = explicitAllowedOrigins.has(parsedOrigin.origin);
        const devLocal =
          !isProduction && (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1');
        isAllowedOrigin = explicitMatch || sameHost || devLocal;
        isExplicitCrossOrigin = explicitMatch && !sameHost;
      } catch {
        isAllowedOrigin = false;
      }
    }

    res.header('Vary', 'Origin');
    if (isAllowedOrigin && origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
      res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
      );
    }

    if (req.method === 'OPTIONS') {
      if (origin && !isAllowedOrigin) {
        res.sendStatus(403);
        return;
      }
      res.sendStatus(200);
      return;
    }

    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      res.header('X-Robots-Tag', 'noindex, nofollow');
    }

    const isStateChanging =
      req.method === 'POST' ||
      req.method === 'PUT' ||
      req.method === 'PATCH' ||
      req.method === 'DELETE';

    if ((req.path.startsWith('/api') || req.path === '/account-deletion') && isStateChanging) {
      if (origin && !isAllowedOrigin) {
        if (req.path.startsWith('/api')) {
          res.status(403).json({
            success: false,
            error: 'Cross-origin state-changing request denied.',
            message: 'Cross-origin state-changing request denied.',
          });
        } else {
          res.status(403).type('text/plain').send('Cross-origin form submission denied.');
        }
        return;
      }
      const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (secFetchSite === 'cross-site' && !isExplicitCrossOrigin) {
        if (req.path.startsWith('/api')) {
          res.status(403).json({
            success: false,
            error: 'Cross-site request blocked by CSRF policy.',
            message: 'Cross-site request blocked by CSRF policy.',
          });
        } else {
          res.status(403).type('text/plain').send('Cross-site form submission blocked.');
        }
        return;
      }
      if (req.path.startsWith('/api')) {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (
          contentType.includes('application/x-www-form-urlencoded') ||
          contentType.includes('multipart/form-data') ||
          contentType.includes('text/plain')
        ) {
          res.status(415).json({
            success: false,
            error: 'Unsupported Content-Type. Use application/json.',
            message: 'Unsupported Content-Type. Use application/json.',
          });
          return;
        }
      }
    }

    next();
  });

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send([
      'User-agent: *',
      'Disallow: /api/',
      'Disallow: /api/uploads/',
      'Disallow: /uploads/',
      'Disallow: /admin',
      'Disallow: /mod',
      'Disallow: /chats',
      'Disallow: /profile',
      'Disallow: /settings',
      'Allow: /privacy',
      'Allow: /terms',
      'Allow: /support',
      'Allow: /account-deletion',
    ].join('\n'));
  });

  app.get('/privacy', (_req, res) => {
    res.type('html').send(renderCompliancePage(
      'Privacy Policy',
      'Privacy & Data Protection',
      `
        <p><strong>Effective Date:</strong> November 2026 · <strong>Platform:</strong> Schoolbackdoor (Independent Student Social Network)</p>
        <h2>1. Data We Collect &amp; Why</h2>
        <ul>
          <li><strong>Account Credentials:</strong> Your Gmail address, @username handle, display name, and salted Scrypt password hash to authenticate your account cleanly.</li>
          <li><strong>Optional Profile Details:</strong> Department, hostel/area, bio, and avatar that you choose to display. Email addresses, phone numbers, and private messages are never shown publicly.</li>
          <li><strong>Coarse Area Preferences:</strong> Optional campus/neighborhood area tags only when explicitly enabled. Precise GPS coordinates are never stored on our servers.</li>
        </ul>
        <h2>2. Ephemeral Lifecycle &amp; Zero Data Sales</h2>
        <ul>
          <li>Posts, comments, direct/group chats, and uploaded media automatically expire and purge after <strong>72 hours</strong>.</li>
          <li>We do not sell personal data, embed third-party ad tracking SDKs, or share user data with data brokers.</li>
          <li>Short-lived access tokens (15 minutes) and rotating refresh sessions (30-day inactivity, 90-day hard cap, up to 5 concurrent devices) are stored as SHA-256 hashes inside HttpOnly cookies.</li>
        </ul>
        <h2>3. Your Controls &amp; Erasure</h2>
        <p>You can manage active devices in <strong>Settings &rarr; Devices &amp; Sessions</strong> or permanently erase your account at any time in Settings or on our public <a href="/account-deletion">Account Deletion Portal</a>.</p>
      `
    ));
  });

  app.get('/terms', (_req, res) => {
    res.type('html').send(renderCompliancePage(
      'Terms of Service & Community Guidelines',
      'Platform Terms · Version 2026.11',
      `
        <p><strong>Age Requirement:</strong> Schoolbackdoor is intended for university students aged <strong>17+ / 18+</strong>. By creating an account or publishing content, you confirm you meet this minimum age and agree to these rules.</p>
        <h2>1. Acceptable Use &amp; Zero-Tolerance Policy</h2>
        <ul>
          <li><strong>No Harassment or Threats:</strong> Hate speech, bullying, doxxing, non-consensual intimate imagery, extortion, or threats of violence result in immediate content removal and account suspension.</li>
          <li><strong>No Impersonation or Fraud:</strong> Impersonating students, university officials, or platform staff, or promoting scams, is strictly prohibited.</li>
          <li><strong>No Spam or Automated Manipulation:</strong> Bot scraping, view/engagement manipulation, or unsolicited commercial spam is blocked.</li>
        </ul>
        <h2>2. Moderation, Blocking &amp; Appeals</h2>
        <ul>
          <li>Users may report posts, comments, profiles, or messages and block any user directly in-app (blocking immediately removes their posts and group chat messages from your view).</li>
          <li>Community Moderators review flagged content within scoped moderation queues; final account suspension, restoration, data deletion, and platform governance rest solely with the Administrator (<code>@THEBACKDOOR</code>). All moderation and administrative actions are audit-logged.</li>
        </ul>
      `
    ));
  });

  app.get('/support', (_req, res) => {
    res.type('html').send(renderCompliancePage(
      'Support & Safety Desk',
      'Help & Trust Center',
      `
        <p>Need assistance with account recovery, safety reports, moderation appeals, or privacy requests?</p>
        <ul>
          <li><strong>Support &amp; Safety Email:</strong> <a href="mailto:support@schoolbackdoor.app">support@schoolbackdoor.app</a></li>
          <li><strong>Response SLA:</strong> Safety and abusive-content reports are prioritized and reviewed within 24 hours.</li>
          <li><strong>Account Deletion:</strong> Use <strong>Settings &rarr; Delete My Account</strong> inside the app or visit <a href="/account-deletion">/account-deletion</a> from any browser.</li>
          <li><strong>Review Policies:</strong> <a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms &amp; Community Guidelines</a></li>
        </ul>
      `
    ));
  });

  const renderDeletionForm = (alertHtml = '') =>
    renderCompliancePage(
      'Permanent Account & Data Deletion',
      'Right to Erasure',
      `
        ${alertHtml}
        <p>Submitting this form <strong>permanently deletes</strong> your Schoolbackdoor profile, posts, comments, likes, bookmarks, chats/messages, notifications, uploaded media, and active sessions across all devices. This action is irreversible (only non-PII SHA-256 tombstones and legally required accounting/audit hashes are retained).</p>
        <form method="POST" action="/account-deletion">
          <div class="field">
            <label for="identifier">Gmail Address or @username</label>
            <input id="identifier" name="identifier" type="text" required placeholder="student@gmail.com or @username" autocomplete="username" />
          </div>
          <div class="field">
            <label for="password">Account Password</label>
            <input id="password" name="password" type="password" required placeholder="Enter your password to verify ownership" autocomplete="current-password" />
          </div>
          <div class="field">
            <label for="confirmation">Type PERMANENTLY_DELETE to confirm</label>
            <input id="confirmation" name="confirmation" type="text" required placeholder="PERMANENTLY_DELETE" />
          </div>
          <div class="field">
            <label for="reason">Optional Reason</label>
            <input id="reason" name="reason" type="text" placeholder="Leaving platform" />
          </div>
          <button type="submit" class="btn btn-danger">Permanently Delete My Account</button>
        </form>
      `
    );

  app.get('/account-deletion', (_req, res) => {
    res.type('html').send(renderDeletionForm());
  });

  app.post('/account-deletion', (req, res) => {
    const wantsJson =
      String(req.headers.accept || '').includes('application/json') &&
      String(req.headers['content-type'] || '').includes('application/json');
    const fail = (status: number, msg: string) => {
      if (wantsJson) {
        res.status(status).json({ success: false, message: msg, error: msg });
        return;
      }
      res.status(status).type('html').send(renderDeletionForm(`<div class="alert alert-err">${escapeHtml(msg)}</div>`));
    };

    try {
      const identifier = String(req.body?.identifier || '').trim();
      const password = String(req.body?.password || '');
      const confirmation = String(req.body?.confirmation || '').trim();
      const reason = String(req.body?.reason || '').trim() || 'Public web account deletion request';
      const ip = req.ip || req.socket.remoteAddress;

      if (!identifier || !password) {
        fail(400, 'Please enter your email/@username and current password.');
        return;
      }
      if (confirmation !== 'PERMANENTLY_DELETE') {
        fail(400, 'Please type PERMANENTLY_DELETE exactly to confirm permanent erasure.');
        return;
      }

      const rl = authService.getLoginRateLimitStatus(identifier, ip);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        fail(429, `Too many failed attempts. Please wait ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s) before trying again.`);
        return;
      }

      const handleCandidate = identifier.startsWith('@') ? identifier : `@${identifier}`;
      const userRow = db.prepare(`
        SELECT u.id, u.password_hash, u.role, u.status
        FROM users u
        LEFT JOIN user_profiles pr ON pr.user_id = u.id
        WHERE LOWER(u.email) = LOWER(?)
           OR LOWER(COALESCE(u.username, '')) = LOWER(?)
           OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
           OR LOWER(COALESCE(pr.handle, '')) = LOWER(?)
        LIMIT 1
      `).get(identifier, identifier, identifier, handleCandidate) as
        | { id: string; password_hash: string; role: string; status: string }
        | undefined;

      if (!userRow || !verifyPassword(password, userRow.password_hash)) {
        authService.recordLoginAttempt(identifier, false, ip);
        fail(401, 'Invalid email/username or password.');
        return;
      }

      authService.recordLoginAttempt(identifier, true, ip);
      const outcome = adminSecurityService.deleteUserPermanently(userRow.id, userRow.id, reason);
      recordSecurityEvent({
        eventType: 'PUBLIC_WEB_ACCOUNT_DELETED',
        severity: 'info',
        identifier,
        ipAddress: ip,
        details: { tombstoneId: outcome.tombstoneId },
      });

      res.setHeader('Set-Cookie', [
        'sb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
        'sb_refresh=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      ]);

      if (wantsJson) {
        res.json({ ...outcome, success: true });
        return;
      }
      res.type('html').send(
        renderCompliancePage(
          'Account Permanently Deleted',
          'Erasure Complete',
          `<div class="alert alert-ok">Your Schoolbackdoor account and personal data have been permanently erased (Reference: <code>${escapeHtml(outcome.tombstoneId)}</code>). All active sessions have been signed out.</div><p><a class="btn" href="/">Return to Schoolbackdoor</a></p>`
        )
      );
    } catch (err: any) {
      if (err instanceof AuthRateLimitError || err?.status === 429) {
        fail(429, err.message);
        return;
      }
      fail(400, err?.message || 'Unable to process account deletion request.');
    }
  });

  app.use('/api', apiRouter);

  const shutdown = () => {
    if (expiryInterval) clearInterval(expiryInterval);
    if (presenceSweepInterval) clearInterval(presenceSweepInterval);
    sseManager.closeAllClients();
    closeReadPool();
    checkpointDatabase();
  };

  return { app, runServerlessMaintenanceTick, shutdown };
}

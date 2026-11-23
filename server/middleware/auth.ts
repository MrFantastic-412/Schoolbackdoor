import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/database';
import { logger } from '../utils/logger';
import { hashSessionToken, SESSION_POLICY } from '../utils/security';

export type UserRole = 'admin' | 'moderator' | 'staff' | 'student';

export interface AuthenticatedUser {
  id: string;
  matric_number: string;
  email: string;
  role: UserRole;
  status: 'active' | 'suspended' | 'pending_verification';
  restricted_until?: string | null;
  restriction_reason?: string | null;
  acceptedTermsVersion?: string | null;
  lastReauthenticatedAt?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      isAuthenticatedUser?: boolean;
      sessionId?: string;
      sessionTokenHash?: string;
    }
  }
}

const lastActivityTouchMap = new Map<string, number>();
const ACTIVITY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const part of pairs) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(eqIdx + 1).trim());
      } catch {
        return part.slice(eqIdx + 1).trim();
      }
    }
  }
  return null;
}

export function extractSessionToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.substring(7).trim();
    if (bearer) return bearer;
  }
  return parseCookieValue(req.headers.cookie, 'sb_session');
}

export function extractRefreshToken(req: Request): string | null {
  const bodyToken = typeof (req.body as any)?.refreshToken === 'string' ? (req.body as any).refreshToken.trim() : '';
  if (bodyToken) return bodyToken;
  return parseCookieValue(req.headers.cookie, 'sb_refresh');
}

function touchUserActivityThrottled(userId: string, sessionTokenHash?: string) {
  const now = Date.now();
  const key = sessionTokenHash ? `${userId}:${sessionTokenHash.slice(0, 12)}` : userId;
  const last = lastActivityTouchMap.get(key) || 0;
  if (now - last < ACTIVITY_TOUCH_INTERVAL_MS) return;

  lastActivityTouchMap.set(key, now);
  if (lastActivityTouchMap.size > 5000) {
    const oldestKey = lastActivityTouchMap.keys().next().value;
    if (oldestKey) lastActivityTouchMap.delete(oldestKey);
  }

  try {
    db.prepare('UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    if (sessionTokenHash) {
      db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE token = ? AND revoked_at IS NULL').run(
        sessionTokenHash
      );
    }
  } catch {
    // Non-critical telemetry update; never fail request
  }
}

export function parseTimestampMs(raw: unknown): number {
  if (!raw) return 0;
  const str = String(raw).trim();
  if (!str) return 0;
  return Date.parse(str.includes('T') ? str : `${str.replace(' ', 'T')}Z`);
}

function resolveActiveRestriction(userRow: any): { restricted_until: string | null; restriction_reason: string | null } {
  const rawUntil = userRow?.account_restricted_until;
  if (!rawUntil) {
    return { restricted_until: null, restriction_reason: null };
  }
  const untilMs = parseTimestampMs(rawUntil);
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
    try {
      db.prepare(`
        UPDATE users
        SET account_restricted_until = NULL,
            restriction_reason = NULL,
            restricted_by = NULL
        WHERE id = ?
      `).run(userRow.id);
    } catch {
      // non-fatal cleanup
    }
    return { restricted_until: null, restriction_reason: null };
  }
  return {
    restricted_until: new Date(untilMs).toISOString(),
    restriction_reason: userRow.restriction_reason || 'Temporary community restriction active.',
  };
}

/**
 * Resolves current user from Bearer session token or HttpOnly sb_session cookie.
 * Enforces non-revoked session state, short-lived access expiration, and hard max lifetime.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const rawToken = extractSessionToken(req);

  try {
    let resolvedUser: AuthenticatedUser | undefined;
    let isExplicitAuth = false;
    let resolvedSessionId: string | undefined;
    let resolvedTokenHash: string | undefined;

    if (rawToken) {
      const tokenHash = hashSessionToken(rawToken);
      const sessionRow = db.prepare(`
        SELECT s.token, s.id as session_id, s.expires_at, s.max_expires_at, s.revoked_at,
               u.id, u.matric_number, u.email, u.role, u.status,
               u.account_restricted_until, u.restriction_reason,
               u.accepted_terms_version, u.last_reauthenticated_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
          AND s.revoked_at IS NULL
          AND datetime(s.expires_at) > datetime('now')
          AND (s.max_expires_at IS NULL OR datetime(s.max_expires_at) > datetime('now'))
      `).get(tokenHash) as any;

      if (sessionRow) {
        isExplicitAuth = true;
        resolvedSessionId = sessionRow.session_id || undefined;
        resolvedTokenHash = sessionRow.token;
        const restriction = resolveActiveRestriction(sessionRow);
        resolvedUser = {
          id: sessionRow.id,
          matric_number: sessionRow.matric_number,
          email: sessionRow.email,
          role: sessionRow.role as UserRole,
          status: sessionRow.status,
          restricted_until: restriction.restricted_until,
          restriction_reason: restriction.restriction_reason,
          acceptedTermsVersion: sessionRow.accepted_terms_version || null,
          lastReauthenticatedAt: sessionRow.last_reauthenticated_at || null,
        };
      }
    }

    // Seeded demo fallback is strictly disabled in production builds and whenever any auth/refresh cookie is supplied
    const hasRefreshCookie = Boolean(parseCookieValue(req.headers.cookie, 'sb_refresh'));
    if (!resolvedUser && !rawToken && !hasRefreshCookie && process.env.NODE_ENV !== 'production') {
      const defaultUser = db.prepare(`
        SELECT id, matric_number, email, role, status, account_restricted_until, restriction_reason,
               accepted_terms_version, last_reauthenticated_at
        FROM users
        WHERE id = 'u-ayodele'
      `).get() as any;

      if (defaultUser) {
        const restriction = resolveActiveRestriction(defaultUser);
        resolvedUser = {
          id: defaultUser.id,
          matric_number: defaultUser.matric_number,
          email: defaultUser.email,
          role: defaultUser.role as UserRole,
          status: defaultUser.status,
          restricted_until: restriction.restricted_until,
          restriction_reason: restriction.restriction_reason,
          acceptedTermsVersion: defaultUser.accepted_terms_version || null,
          lastReauthenticatedAt: defaultUser.last_reauthenticated_at || null,
        };
      }
    }

    if (resolvedUser) {
      if (resolvedUser.status === 'suspended') {
        res.status(403).json({
          error: 'Account suspended. Contact campus admin.',
          code: 'ACCOUNT_SUSPENDED',
        });
        return;
      }
      req.user = resolvedUser;
      req.sessionId = resolvedSessionId;
      req.sessionTokenHash = resolvedTokenHash;
      req.isAuthenticatedUser = isExplicitAuth || (process.env.NODE_ENV !== 'production' && resolvedUser.id === 'u-ayodele');
      if (isExplicitAuth) {
        touchUserActivityThrottled(resolvedUser.id, resolvedTokenHash);
      }
    }

    next();
  } catch (err: any) {
    logger.error('AuthMiddleware', 'Auth middleware error', { message: err?.message });
    next();
  }
}

/**
 * Requires an authenticated user
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  next();
}

/**
 * Ensures the authenticated user has accepted Terms of Service & Community Guidelines before publishing UGC.
 */
export function requireTermsAccepted(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  if (!req.user.acceptedTermsVersion) {
    res.status(403).json({
      error: 'Please review and accept our Terms of Service and Community Guidelines before posting.',
      code: 'TERMS_ACCEPTANCE_REQUIRED',
    });
    return;
  }
  next();
}

/**
 * Checks whether the current user performed password re-authentication recently (within maxAgeMinutes).
 */
export function hasRecentReauth(user: AuthenticatedUser | undefined, maxAgeMinutes = SESSION_POLICY.reauthWindowMinutes): boolean {
  if (!user?.lastReauthenticatedAt) return false;
  const reauthMs = parseTimestampMs(user.lastReauthenticatedAt);
  if (!Number.isFinite(reauthMs) || reauthMs <= 0) return false;
  return Date.now() - reauthMs <= maxAgeMinutes * 60 * 1000;
}

/**
 * Blocks social write actions (posting, commenting, reactions, messaging) while a temporary account restriction is active
 */
export function requireNotRestricted(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  if (req.user.restricted_until) {
    const untilMs = parseTimestampMs(req.user.restricted_until);
    if (Number.isFinite(untilMs) && untilMs > Date.now()) {
      res.status(403).json({
        error: `Your account is temporarily restricted until ${req.user.restricted_until}. Reason: ${req.user.restriction_reason || 'Moderation action'}`,
        code: 'ACCOUNT_RESTRICTED',
        restrictedUntil: req.user.restricted_until,
      });
      return;
    }
  }
  next();
}

/**
 * Enforces role-based access control (RBAC)
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const userRole = req.user.role;
    if (allowedRoles.includes(userRole)) {
      return next();
    }

    res.status(403).json({
      error: `Forbidden. This operation requires: ${allowedRoles.join(', ')}`,
      code: 'INSUFFICIENT_PRIVILEGES',
    });
  };
}

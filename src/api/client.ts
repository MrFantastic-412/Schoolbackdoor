import {
  BlockedUser,
  CampusLandmark,
  CampusLocation,
  Community,
  CommunityMember,
  CommunitySettings,
  Conversation,
  FeedCategory,
  FeedFilter,
  LocationFilterKey,
  MentionCandidate,
  Message,
  Notice,
  PaginatedPostsResponse,
  Post,
  PostPoll,
  PresenceSummary,
  StudentProfile,
  UserSearchResult,
  AdminDashboardStats,
  AdminReport,
  StaffMember,
  AppealRecord,
  BackupSnapshot,
  AdminAuditLog,
  PlatformConfig,
  PlatformFeature,
  AdminUserRecord,
  AdminContentPost,
  AdminContentComment,
  AdminChatOverview,
  AdminNotificationRecord,
  AdminCommunityRecord,
  AdminStorageOverview,
  AdminSecurityOverview,
  DeviceSession,
  SecurityEventRecord,
  AppNotification,
  AdminAnalyticsReport,
  AnalyticsRange,
  ModeratorAccount,
  ModeratorPermissions,
  ModeratorDashboardData,
  ModeratorReportItem,
  ModeratorCommunityReviewData,
  ModerationHistoryEntry,
  AdvertisementRecord,
  PaymentRecordsResponse,
  SavedLocation,
  LocationSearchHistoryItem,
} from '../types';

export function resolveApiBase(rawConfiguredBase?: string): string {
  const envConfigured =
    rawConfiguredBase !== undefined
      ? rawConfiguredBase
      : typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL
        ? String((import.meta as any).env.VITE_API_URL)
        : '';
  const trimmed = envConfigured.trim().replace(/\/+$/, '');
  if (!trimmed) return '/api';
  if (trimmed === '/api' || /\/api$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/api`;
}

const API_BASE = resolveApiBase();

function isCrossOriginApi(): boolean {
  if (typeof window === 'undefined' || !/^https?:\/\//i.test(API_BASE)) {
    return false;
  }
  try {
    return new URL(API_BASE).origin !== window.location.origin;
  } catch {
    return false;
  }
}

export async function parseApiJson<T = any>(
  res: Response,
  fallbackMessage = 'Request failed.'
): Promise<T> {
  const rawText = await res.text();
  const trimmed = rawText.trim();

  if (!trimmed) {
    if (res.ok) {
      return {} as T;
    }
    const err: any = new Error(
      res.status === 404
        ? 'API endpoint not found (HTTP 404). Verify Vercel API routing or VITE_API_URL configuration.'
        : fallbackMessage
    );
    err.status = res.status;
    throw err;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const isNotFoundHtmlOrText =
      res.status === 404 || /the page could not be found/i.test(trimmed);
    const diagnostic = isNotFoundHtmlOrText
      ? 'API endpoint not found (HTTP 404). Verify Vercel API routing or VITE_API_URL configuration.'
      : res.status >= 500
        ? `Server returned an invalid non-JSON response (HTTP ${res.status}). Please try again shortly.`
        : `Unexpected non-JSON response from server (HTTP ${res.status || 0}).`;
    const err: any = new Error(diagnostic);
    err.status = res.status;
    err.code = 'NON_JSON_RESPONSE';
    throw err;
  }

  if (!res.ok || (parsed && typeof parsed === 'object' && parsed.success === false)) {
    const message =
      (parsed && typeof parsed === 'object' && (parsed.error || parsed.message)) ||
      fallbackMessage;
    const err: any = new Error(message);
    err.status = res.status;
    if (parsed && typeof parsed === 'object') {
      err.code = parsed.code;
      err.mfaRequired = Boolean(parsed.mfaRequired);
      err.retryAfterSeconds = parsed.retryAfterSeconds;
    }
    throw err;
  }

  return parsed as T;
}

// Client-side TTL cache strictly reserved for non-PII public read endpoints
const publicResponseCache = new Map<string, { value: unknown; expiresAt: number }>();

function getPublicCached<T>(key: string): T | null {
  const entry = publicResponseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    publicResponseCache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setPublicCached(key: string, value: unknown, ttlMs: number) {
  if (publicResponseCache.size >= 64) {
    const firstKey = publicResponseCache.keys().next().value;
    if (firstKey !== undefined) publicResponseCache.delete(firstKey);
  }
  publicResponseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clearPublicCache() {
  publicResponseCache.clear();
}

export function getOrCreateTabClientId(): string {
  if (typeof window === 'undefined') return 'cli-ssr';
  try {
    let cid = sessionStorage.getItem('sb_tab_client_id');
    if (!cid) {
      cid = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem('sb_tab_client_id', cid);
    }
    return cid;
  } catch {
    return `tab-${Date.now().toString(36)}`;
  }
}

function getOrCreateFeedVisitorId(): string {
  if (typeof window === 'undefined') return 'vis-ssr-0001';
  try {
    let vid = sessionStorage.getItem('sb_feed_visitor_id');
    if (!vid) {
      vid = `vis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('sb_feed_visitor_id', vid);
    }
    return vid;
  } catch {
    return `vis-${Date.now().toString(36)}`;
  }
}

const LEGACY_SESSION_TOKEN_KEY = 'sb_auth_session_token';
const LEGACY_LOCAL_TOKEN_KEY = 'sb_auth_token';
let inMemoryAuthToken: string | null = null;
let hasKnownSession = false;
let refreshPromise: Promise<boolean> | null = null;
let noRefreshCooldownUntil = 0;

function scrubLegacyStoredTokens() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(LEGACY_LOCAL_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_SESSION_TOKEN_KEY);
  } catch {
    // Ignore storage access restrictions
  }
}

scrubLegacyStoredTokens();

const rawFetch = globalThis.fetch.bind(globalThis);

async function refreshAccessToken(): Promise<boolean> {
  if (Date.now() < noRefreshCooldownUntil) return false;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const credentialsMode: RequestCredentials = isCrossOriginApi() ? 'include' : 'same-origin';
      const res = await rawFetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: credentialsMode,
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        inMemoryAuthToken = null;
        hasKnownSession = false;
        noRefreshCooldownUntil = Date.now() + 2500;
        return false;
      }
      const text = await res.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        return false;
      }
      const refreshedToken = data?.token ?? data?.data?.token;
      if (refreshedToken) {
        inMemoryAuthToken = refreshedToken;
      }
      hasKnownSession = true;
      noRefreshCooldownUntil = 0;
      clearPublicCache();
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

const SKIP_REFRESH_PATHS = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/logout',
  '/auth/forgot-password',
  '/auth/reset-password',
];

async function fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const defaultCredentials: RequestCredentials = isCrossOriginApi() ? 'include' : 'same-origin';

  const buildHeaders = (): Record<string, string> => {
    const merged: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          merged[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) merged[k] = v;
      } else {
        Object.assign(merged, init.headers as Record<string, string>);
      }
    }
    if (inMemoryAuthToken && !merged['Authorization'] && !merged['authorization']) {
      merged['Authorization'] = `Bearer ${inMemoryAuthToken}`;
    }
    return merged;
  };

  let res = await rawFetch(input, {
    ...init,
    credentials: init.credentials ?? defaultCredentials,
    headers: buildHeaders(),
  });

  const shouldAttemptRefresh =
    res.status === 401 &&
    !SKIP_REFRESH_PATHS.some((p) => urlStr.includes(p)) &&
    (hasKnownSession || Boolean(inMemoryAuthToken) || urlStr.endsWith('/api/me'));

  if (shouldAttemptRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const retryHeaders = buildHeaders();
      if (inMemoryAuthToken) {
        retryHeaders['Authorization'] = `Bearer ${inMemoryAuthToken}`;
      }
      res = await rawFetch(input, {
        ...init,
        credentials: init.credentials ?? defaultCredentials,
        headers: retryHeaders,
      });
    }
  }

  return res;
}

function getAuthHeaders(): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (inMemoryAuthToken) {
    headers['Authorization'] = `Bearer ${inMemoryAuthToken}`;
  }
  return headers;
}

export const api = {
  // --- Token helpers (memory-only; session authority lives in HttpOnly SameSite=Strict cookies) ---
  getToken(): string | null {
    return inMemoryAuthToken;
  },

  hasActiveSession(): boolean {
    return Boolean(inMemoryAuthToken) || hasKnownSession;
  },

  setToken(token: string) {
    clearPublicCache();
    scrubLegacyStoredTokens();
    inMemoryAuthToken = token;
    hasKnownSession = true;
    noRefreshCooldownUntil = 0;
  },

  clearToken() {
    clearPublicCache();
    scrubLegacyStoredTokens();
    inMemoryAuthToken = null;
    hasKnownSession = false;
  },

  // --- Diagnostics ---
  async getHealth() {
    const res = await fetch(`${API_BASE}/health`);
    return parseApiJson(res, 'Failed to check service health.');
  },

  async getStats() {
    const res = await fetch(`${API_BASE}/stats`);
    return parseApiJson(res, 'Failed to load service statistics.');
  },

  // --- Authentication ---
  async register(data: {
    identifier?: string;
    email?: string;
    username: string;
    password: string;
    acceptTerms: boolean;
    name?: string;
    department?: string;
    level?: string;
    hall_of_residence?: string;
    matric_number?: string;
    avatarDataUrl?: string;
    avatarThumbnailDataUrl?: string;
    avatarUrl?: string;
  }) {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await parseApiJson<any>(res, 'Registration failed.');
    const token = result.token ?? result.data?.token;
    const profile = result.profile ?? result.data?.profile;
    const user = result.user ?? result.data?.user;
    if (token) {
      this.setToken(token);
    } else {
      hasKnownSession = true;
    }
    return {
      ...result,
      token,
      profile,
      user,
    };
  },

  async getPlatformConfig(): Promise<PlatformConfig | null> {
    const cached = getPublicCached<PlatformConfig>('platform:config');
    if (cached) return cached;
    try {
      const res = await fetch(`${API_BASE}/platform/config`);
      if (!res.ok) return null;
      const data = await parseApiJson<PlatformConfig>(res, 'Failed to load platform configuration.');
      setPublicCached('platform:config', data, 10000);
      return data;
    } catch {
      return null;
    }
  },

  async login(identifier: string, password: string, mfaCode?: string) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password, mfaCode }),
    });
    const result = await parseApiJson<any>(res, 'Authentication failed.');
    const token = result.token ?? result.data?.token;
    const profile = result.profile ?? result.data?.profile;
    const user = result.user ?? result.data?.user;
    if (token) {
      this.setToken(token);
    } else {
      hasKnownSession = true;
    }
    return {
      ...result,
      token,
      profile,
      user,
    };
  },

  async refreshSession(): Promise<boolean> {
    return refreshAccessToken();
  },

  async logout() {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ clientId: getOrCreateTabClientId() }),
      });
    } finally {
      this.clearToken();
    }
    return { success: true };
  },

  // --- Live Presence ---
  async getOnlinePresence(): Promise<PresenceSummary> {
    try {
      const res = await fetch(`${API_BASE}/presence/online`, { headers: getAuthHeaders() });
      if (!res.ok) {
        return { onlineCount: 0, message: '0 students online now.', updatedAt: new Date().toISOString() };
      }
      return await parseApiJson(res, 'Failed to load presence.');
    } catch {
      return { onlineCount: 0, message: '0 students online now.', updatedAt: new Date().toISOString() };
    }
  },

  async sendPresenceHeartbeat(): Promise<PresenceSummary | null> {
    try {
      const res = await fetch(`${API_BASE}/presence/heartbeat`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ clientId: getOrCreateTabClientId() }),
      });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to record presence heartbeat.');
    } catch {
      return null;
    }
  },

  async sendPresenceOffline(): Promise<void> {
    try {
      const clientId = getOrCreateTabClientId();
      await fetch(`${API_BASE}/presence/offline`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ clientId }),
        keepalive: true,
      });
    } catch {
      // Ignore network teardown errors on pagehide
    }
  },

  async verifyAccount(code: string) {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ code }),
    });
    return parseApiJson(res, 'Verification failed.');
  },

  async resendVerificationCode() {
    const res = await fetch(`${API_BASE}/auth/verify/resend`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Unable to resend verification code.');
  },

  async forgotPassword(identifier: string) {
    const res = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
    });
    return parseApiJson(res, 'Password recovery failed.');
  },

  async resetPassword(resetCode: string, newPassword: string, identifier?: string) {
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetCode, newPassword, ...(identifier ? { identifier } : {}) }),
    });
    return parseApiJson(res, 'Password reset failed.');
  },

  // --- Profile & Multi-Device Session Controls ---
  async getProfile(): Promise<StudentProfile | null> {
    try {
      const res = await fetch(`${API_BASE}/me`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      const data = await parseApiJson<any>(res, 'Unable to load profile.');
      const profile = data?.profile ?? data?.data?.profile ?? null;
      if (profile?.userId) {
        hasKnownSession = true;
      }
      return profile;
    } catch {
      return null;
    }
  },

  async acceptTerms(): Promise<{ success: boolean; acceptedTermsVersion: string; acceptedTermsAt: string }> {
    const res = await fetch(`${API_BASE}/me/accept-terms`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    });
    return parseApiJson(res, 'Failed to accept Terms.');
  },

  async reauthenticate(password: string): Promise<{ success: boolean; lastReauthenticatedAt: string }> {
    const res = await fetch(`${API_BASE}/auth/reauthenticate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password }),
    });
    return parseApiJson(res, 'Password verification failed.');
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; revokedOtherSessions: number }> {
    const res = await fetch(`${API_BASE}/auth/change-password`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return parseApiJson(res, 'Failed to update password.');
  },

  async getMySessions(): Promise<{
    sessions: DeviceSession[];
    maxActiveDevices: number;
    accessTtlMinutes: number;
    refreshTtlDays: number;
    maxLifetimeDays: number;
  }> {
    const fallback = {
      sessions: [],
      maxActiveDevices: 5,
      accessTtlMinutes: 15,
      refreshTtlDays: 30,
      maxLifetimeDays: 90,
    };
    try {
      const res = await fetch(`${API_BASE}/me/sessions`, { headers: getAuthHeaders() });
      if (!res.ok) return fallback;
      return await parseApiJson(res, 'Failed to load sessions.');
    } catch {
      return fallback;
    }
  },

  async revokeMySession(sessionId: string): Promise<{ success: boolean; revokedSelf?: boolean }> {
    const res = await fetch(`${API_BASE}/me/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await parseApiJson<{ success: boolean; revokedSelf?: boolean }>(
      res,
      'Failed to sign out device.'
    );
    if (result.revokedSelf) {
      this.clearToken();
    }
    return result;
  },

  async revokeOtherSessions(): Promise<{ success: boolean; revokedCount: number }> {
    const res = await fetch(`${API_BASE}/me/sessions/revoke-others`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to revoke other device sessions.');
  },

  async getMfaStatus(): Promise<{ mfaEnabled: boolean; role: string }> {
    try {
      const res = await fetch(`${API_BASE}/auth/mfa/status`, { headers: getAuthHeaders() });
      if (!res.ok) return { mfaEnabled: false, role: 'student' };
      return await parseApiJson(res, 'Failed to check MFA status.');
    } catch {
      return { mfaEnabled: false, role: 'student' };
    }
  },

  async setupMfa(): Promise<{ secret: string; otpauthUri: string; sampleCurrentCode?: string }> {
    const res = await fetch(`${API_BASE}/auth/mfa/setup`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to start MFA setup.');
  },

  async verifyMfa(code: string): Promise<{ success: boolean; mfaEnabled: boolean }> {
    const res = await fetch(`${API_BASE}/auth/mfa/verify`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ code }),
    });
    return parseApiJson(res, 'Invalid verification code.');
  },

  async disableMfa(password: string): Promise<{ success: boolean; mfaEnabled: boolean }> {
    const res = await fetch(`${API_BASE}/auth/mfa/disable`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password }),
    });
    return parseApiJson(res, 'Failed to disable MFA.');
  },

  async searchUsers(query = '', limit = 20): Promise<UserSearchResult[]> {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      params.set('limit', String(limit));
      const res = await fetch(`${API_BASE}/users/search?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to search users.');
    } catch {
      return [];
    }
  },

  async getMentionCandidates(options: {
    q?: string;
    chatId?: string;
    communityId?: string;
    limit?: number;
  } = {}): Promise<MentionCandidate[]> {
    try {
      const params = new URLSearchParams();
      if (options.q) params.set('q', options.q);
      if (options.chatId) params.set('chatId', options.chatId);
      if (options.communityId) params.set('communityId', options.communityId);
      params.set('limit', String(options.limit ?? 8));
      const res = await fetch(`${API_BASE}/mentions/candidates?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load mention candidates.');
    } catch {
      return [];
    }
  },

  async getPublicProfile(userId: string): Promise<StudentProfile | null> {
    try {
      const res = await fetch(`${API_BASE}/users/${userId}/profile`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load user profile.');
    } catch {
      return null;
    }
  },

  async toggleConnectUser(targetUserId: string): Promise<{ isConnected: boolean; followersCount: number }> {
    const res = await fetch(`${API_BASE}/users/${targetUserId}/connect`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Unable to update connection.');
  },

  async getUserPosts(userId: string, limit = 20): Promise<Post[]> {
    try {
      const res = await fetch(`${API_BASE}/users/${userId}/posts?limit=${limit}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Unable to load user posts.');
    } catch {
      return [];
    }
  },

  async updateProfile(
    updates: Partial<StudentProfile> & {
      avatarDataUrl?: string;
      avatarThumbnailDataUrl?: string;
      removeAvatar?: boolean;
    }
  ): Promise<StudentProfile | null> {
    const res = await fetch(`${API_BASE}/me/profile`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(updates),
    });
    return parseApiJson(res, 'Failed to update profile.');
  },

  async uploadImage(
    dataUrl: string,
    thumbnailDataUrl?: string,
    onProgress?: (percent: number) => void
  ): Promise<{
    filename: string;
    url: string;
    thumbnailUrl?: string;
    bytes: number;
    mimetype: string;
  }> {
    const sendAttempt = (allowRetry: boolean): Promise<{
      filename: string;
      url: string;
      thumbnailUrl?: string;
      bytes: number;
      mimetype: string;
    }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/files/upload`, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (inMemoryAuthToken) {
          xhr.setRequestHeader('Authorization', `Bearer ${inMemoryAuthToken}`);
        }

        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable && ev.total > 0) {
            onProgress?.(Math.min(96, Math.max(5, Math.round((ev.loaded / ev.total) * 95))));
          }
        };

        xhr.onerror = () => {
          reject(new Error('Network error occurred while uploading image.'));
        };

        xhr.onload = async () => {
          let result: any = {};
          let isJson = true;
          try {
            result = xhr.responseText ? JSON.parse(xhr.responseText) : {};
          } catch {
            isJson = false;
            result = {};
          }

          if (xhr.status === 401 && allowRetry && (hasKnownSession || Boolean(inMemoryAuthToken))) {
            const refreshed = await refreshAccessToken();
            if (refreshed) {
              try {
                const retried = await sendAttempt(false);
                resolve(retried);
              } catch (err) {
                reject(err);
              }
              return;
            }
          }

          if (xhr.status < 200 || xhr.status >= 300 || !isJson) {
            const fallbackMsg =
              xhr.status === 404
                ? 'Image upload endpoint not found (HTTP 404). Verify Vercel API routing or VITE_API_URL configuration.'
                : 'Image upload failed.';
            const err: any = new Error(result.error || result.message || fallbackMsg);
            err.status = xhr.status;
            err.code = result.code || (!isJson ? 'NON_JSON_RESPONSE' : undefined);
            reject(err);
            return;
          }

          onProgress?.(100);
          resolve(result);
        };

        xhr.send(JSON.stringify({ dataUrl, thumbnailDataUrl }));
      });

    return sendAttempt(true);
  },

  // --- Blocking & Privacy ---
  async getBlockedUsers(): Promise<BlockedUser[]> {
    try {
      const res = await fetch(`${API_BASE}/me/blocks`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load blocked users.');
    } catch {
      return [];
    }
  },

  async blockUser(targetUserId: string) {
    const res = await fetch(`${API_BASE}/users/${targetUserId}/block`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to block student.');
  },

  async unblockUser(targetUserId: string) {
    const res = await fetch(`${API_BASE}/users/${targetUserId}/unblock`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to unblock student.');
  },

  // --- Posts & Feed ---
  async getFeedLocations(): Promise<
    Array<{
      key: string;
      label: string;
      shortLabel: string;
      description: string;
      isOffCampus: boolean;
    }>
  > {
    const cached = getPublicCached<any[]>('feed:locations');
    if (cached) return cached;
    try {
      const res = await fetch(`${API_BASE}/feed/locations`);
      if (!res.ok) return [];
      const data = await parseApiJson<any[]>(res, 'Failed to load feed locations.');
      setPublicCached('feed:locations', data, 60000);
      return data;
    } catch {
      return [];
    }
  },

  async updateLocationPreference(data: {
    locationSharingEnabled: boolean;
    preferredLocationArea?: string | null;
  }): Promise<{
    locationSharingEnabled: boolean;
    preferredLocationArea: string | null;
    profile?: StudentProfile | null;
  }> {
    const res = await fetch(`${API_BASE}/me/location-preference`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        locationSharingEnabled: Boolean(data.locationSharingEnabled),
        preferredLocationArea: data.locationSharingEnabled ? data.preferredLocationArea ?? null : null,
      }),
    });
    return parseApiJson(res, 'Failed to update location preference.');
  },

  async getPosts(): Promise<Post[]> {
    try {
      const res = await fetch(`${API_BASE}/posts`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Unable to load posts.');
    } catch {
      return [];
    }
  },

  async getPostsPaginated(options: {
    limit?: number;
    offset?: number;
    filter?: FeedFilter;
    category?: FeedCategory;
    location?: LocationFilterKey;
  } = {}): Promise<PaginatedPostsResponse> {
    const params = new URLSearchParams();
    params.set('paginated', '1');
    params.set('limit', String(options.limit ?? 15));
    params.set('offset', String(options.offset ?? 0));
    if (options.filter) params.set('filter', options.filter);
    if (options.category) params.set('category', options.category);
    if (options.location) params.set('location', options.location);

    const res = await fetch(`${API_BASE}/posts?${params.toString()}`, {
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Unable to load posts right now.');
  },

  async recordPostViews(
    postIds: string[],
    options: { source?: string; dwellMs?: number } = {}
  ): Promise<{ recorded: number; skippedBot: boolean; viewsByPost: Record<string, number> }> {
    if (!postIds.length) return { recorded: 0, skippedBot: false, viewsByPost: {} };
    try {
      const res = await fetch(`${API_BASE}/posts/views`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          postIds,
          visitorId: getOrCreateFeedVisitorId(),
          source: options.source || 'feed',
          dwellMs: options.dwellMs ?? 900,
        }),
      });
      if (!res.ok) return { recorded: 0, skippedBot: false, viewsByPost: {} };
      return await parseApiJson(res, 'Failed to record post views.');
    } catch {
      return { recorded: 0, skippedBot: false, viewsByPost: {} };
    }
  },

  async recordPostShare(postId: string): Promise<{ shares: number; incremented: boolean } | null> {
    try {
      const res = await fetch(`${API_BASE}/posts/${postId}/share`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          visitorId: getOrCreateFeedVisitorId(),
        }),
      });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to record post share.');
    } catch {
      return null;
    }
  },

  async getPostById(postId: string): Promise<Post | null> {
    try {
      const res = await fetch(`${API_BASE}/posts/${postId}`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load post.');
    } catch {
      return null;
    }
  },

  async createPost(post: {
    content: string;
    school_tag?: string;
    hostel_tag?: string;
    location?: CampusLocation;
    images?: string[];
    poll?: {
      question?: string;
      options: string[];
      allowMultiple?: boolean;
    };
    is_anonymous?: boolean;
  }): Promise<Post | null> {
    const res = await fetch(`${API_BASE}/posts`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(post),
    });
    return parseApiJson(res, 'Failed to publish post.');
  },

  async votePoll(postId: string, optionId: string): Promise<{ postId: string; poll: PostPoll }> {
    const res = await fetch(`${API_BASE}/posts/${postId}/poll/vote`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ optionId }),
    });
    return parseApiJson(res, 'Unable to record vote right now.');
  },

  async toggleLike(postId: string): Promise<{ isLiked: boolean; likes: number } | null> {
    const res = await fetch(`${API_BASE}/posts/${postId}/like`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Unable to update like right now.');
  },

  async toggleRepost(postId: string): Promise<{ isReposted: boolean; reposts: number } | null> {
    const res = await fetch(`${API_BASE}/posts/${postId}/repost`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Unable to repost right now.');
  },

  async editPost(postId: string, content: string): Promise<Post> {
    const res = await fetch(`${API_BASE}/posts/${postId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ content }),
    });
    return parseApiJson(res, 'Failed to update post.');
  },

  async deletePost(postId: string): Promise<{ success: boolean }> {
    const res = await fetch(`${API_BASE}/posts/${postId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete post.');
  },

  async addComment(postId: string, content: string, parentCommentId?: string, images?: string[]) {
    const res = await fetch(`${API_BASE}/posts/${postId}/comments`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ content, parentCommentId, images }),
    });
    return parseApiJson(res, 'Failed to post reply.');
  },

  async editComment(commentId: string, content: string) {
    const res = await fetch(`${API_BASE}/comments/${commentId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ content }),
    });
    return parseApiJson(res, 'Failed to edit comment.');
  },

  async deleteComment(commentId: string): Promise<{ success: boolean }> {
    const res = await fetch(`${API_BASE}/comments/${commentId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete comment.');
  },

  // --- Chats & Messaging ---
  async getChats(): Promise<Conversation[]> {
    try {
      const res = await fetch(`${API_BASE}/chats`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load chats.');
    } catch {
      return [];
    }
  },

  async getChatMessages(chatId: string): Promise<Message[]> {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/messages`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load chat messages.');
    } catch {
      return [];
    }
  },

  async getChatMessagesPaginated(
    chatId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ messages: Message[]; total: number; hasMore: boolean; nextOffset: number }> {
    try {
      const params = new URLSearchParams();
      params.set('paginated', '1');
      params.set('limit', String(options.limit ?? 60));
      params.set('offset', String(options.offset ?? 0));
      const res = await fetch(`${API_BASE}/chats/${chatId}/messages?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { messages: [], total: 0, hasMore: false, nextOffset: 0 };
      return await parseApiJson(res, 'Failed to load chat messages.');
    } catch {
      return { messages: [], total: 0, hasMore: false, nextOffset: 0 };
    }
  },

  async sendMessage(
    chatId: string,
    text: string,
    location?: CampusLocation,
    images?: string[],
    clientId?: string
  ): Promise<Message> {
    const res = await fetch(`${API_BASE}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ text, location, images, client_id: clientId }),
    });
    return parseApiJson(res, 'Failed to send message.');
  },

  async editMessage(chatId: string, messageId: string, text: string): Promise<Message> {
    const res = await fetch(`${API_BASE}/chats/${chatId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ text }),
    });
    return parseApiJson(res, 'Failed to update message.');
  },

  async deleteMessage(chatId: string, messageId: string): Promise<{ success: boolean; deletedMessageId: string; chatId: string }> {
    const res = await fetch(`${API_BASE}/chats/${chatId}/messages/${messageId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete message.');
  },

  async markChatAsRead(chatId: string): Promise<{ success: boolean; chatId?: string; readCount?: number; readAt?: string }> {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/read`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { success: false };
      return await parseApiJson(res, 'Failed to mark chat as read.');
    } catch {
      return { success: false };
    }
  },

  async searchEligibleChatPartners(query = ''): Promise<any[]> {
    try {
      const res = await fetch(`${API_BASE}/chats/eligible-users?q=${encodeURIComponent(query)}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to search users.');
    } catch {
      return [];
    }
  },

  async purgeExpiredMessages(): Promise<{ purgedCount: number }> {
    try {
      const res = await fetch(`${API_BASE}/chats/maintenance/purge-expired`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { purgedCount: 0 };
      return await parseApiJson(res, 'Failed to purge expired messages.');
    } catch {
      return { purgedCount: 0 };
    }
  },

  async createDirectChat(targetUserId: string): Promise<{ chatId: string; isNew: boolean }> {
    const res = await fetch(`${API_BASE}/chats/direct`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ targetUserId }),
    });
    return parseApiJson(res, 'Failed to start direct conversation.');
  },

  // --- Real-Time SSE Subscription ---
  connectRealtime(handlers: {
    onMessage?: (msg: any) => void;
    onMessageUpdated?: (data: any) => void;
    onMessageDeleted?: (data: any) => void;
    onMessageRead?: (data: any) => void;
    onNotification?: (notif: any) => void;
    onNotificationRead?: (data: any) => void;
    onPresenceUpdate?: (summary: PresenceSummary) => void;
    onConfigUpdated?: (config: PlatformConfig) => void;
    onAdminReport?: (report: AdminReport) => void;
  }): () => void {
    const clientId = getOrCreateTabClientId();
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;
    let isClosed = false;

    const connect = async () => {
      if (isClosed) return;
      try {
        const params = new URLSearchParams();
        params.set('clientId', clientId);

        try {
          const ticketRes = await fetch(`${API_BASE}/realtime/ticket`, {
            method: 'POST',
            headers: getAuthHeaders(),
          });
          if (ticketRes.ok) {
            const ticketData = await parseApiJson<any>(ticketRes, 'Failed to create realtime ticket.');
            if (ticketData?.ticket) {
              params.set('ticket', ticketData.ticket);
            }
          }
        } catch {
          // Fall back to anonymous SSE channel if ticket exchange fails temporarily
        }

        if (isClosed) return;
        const url = `${API_BASE}/realtime/stream?${params.toString()}`;
        eventSource = new EventSource(url, { withCredentials: isCrossOriginApi() });

        eventSource.addEventListener('message:new', (e) => {
          try {
            const data = JSON.parse(e.data);
            handlers.onMessage?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error message:new:', err);
          }
        });

        eventSource.addEventListener('message:updated', (e) => {
          try {
            const data = JSON.parse(e.data);
            handlers.onMessageUpdated?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error message:updated:', err);
          }
        });

        eventSource.addEventListener('message:deleted', (e) => {
          try {
            const data = JSON.parse(e.data);
            handlers.onMessageDeleted?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error message:deleted:', err);
          }
        });

        eventSource.addEventListener('message:read', (e) => {
          try {
            const data = JSON.parse(e.data);
            handlers.onMessageRead?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error message:read:', err);
          }
        });

        eventSource.addEventListener('notification:new', (e) => {
          try {
            const data = JSON.parse(e.data);
            handlers.onNotification?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error notification:new:', err);
          }
        });

        eventSource.addEventListener('notification:read', (e) => {
          try {
            const data = JSON.parse(e.data);
            handlers.onNotificationRead?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error notification:read:', err);
          }
        });

        eventSource.addEventListener('presence:count', (e) => {
          try {
            const data = JSON.parse(e.data) as PresenceSummary;
            handlers.onPresenceUpdate?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error presence:count:', err);
          }
        });

        eventSource.addEventListener('admin:report:new', (e) => {
          try {
            const data = JSON.parse(e.data) as AdminReport;
            handlers.onAdminReport?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error admin:report:new:', err);
          }
        });

        eventSource.addEventListener('config:updated', (e) => {
          try {
            const data = JSON.parse(e.data) as PlatformConfig;
            handlers.onConfigUpdated?.(data);
          } catch (err) {
            console.warn('[SSE] Parse error config:updated:', err);
          }
        });

        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          if (!isClosed) {
            // Reconnect with gentle backoff
            reconnectTimeout = setTimeout(connect, 3500);
          }
        };
      } catch (err) {
        console.warn('[SSE] Failed initializing EventSource:', err);
        if (!isClosed) {
          reconnectTimeout = setTimeout(connect, 5000);
        }
      }
    };

    connect();

    // Return cleanup unsubscribe function
    return () => {
      isClosed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  },

  // --- Notifications ---
  async getNotifications(unreadOnly = false): Promise<any[]> {
    try {
      const res = await fetch(`${API_BASE}/notifications?unread=${unreadOnly}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load notifications.');
    } catch {
      return [];
    }
  },

  async getNotificationsPaginated(options: {
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ notifications: AppNotification[]; total: number; hasMore: boolean; nextOffset: number }> {
    const params = new URLSearchParams();
    params.set('paginated', '1');
    params.set('unread', String(Boolean(options.unreadOnly)));
    params.set('limit', String(options.limit ?? 20));
    params.set('offset', String(options.offset ?? 0));
    const res = await fetch(`${API_BASE}/notifications?${params.toString()}`, {
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to load activity.');
  },

  async markNotificationAsRead(id: string): Promise<{ success: boolean }> {
    try {
      const res = await fetch(`${API_BASE}/notifications/${id}/read`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { success: false };
      return await parseApiJson(res, 'Failed to mark notification as read.');
    } catch {
      return { success: false };
    }
  },

  async markAllNotificationsAsRead(): Promise<{ success: boolean }> {
    try {
      const res = await fetch(`${API_BASE}/notifications/read-all`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { success: false };
      return await parseApiJson(res, 'Failed to mark notifications as read.');
    } catch {
      return { success: false };
    }
  },

  // --- Communities & Guilds ---
  async getCommunities(): Promise<Community[]> {
    try {
      const res = await fetch(`${API_BASE}/communities`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load communities.');
    } catch {
      return [];
    }
  },

  async getCommunity(id: string): Promise<Community | null> {
    try {
      const res = await fetch(`${API_BASE}/communities/${id}`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load community.');
    } catch {
      return null;
    }
  },

  async createCommunity(data: {
    name: string;
    acronym: string;
    category: 'school' | 'hostel' | 'tech' | 'academic' | 'social';
    description: string;
    location: string;
    leaders?: string;
    rules?: string;
    settings?: CommunitySettings;
  }): Promise<Community> {
    const res = await fetch(`${API_BASE}/communities`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to create community.');
  },

  async editCommunity(id: string, updates: {
    name?: string;
    description?: string;
    location?: string;
    leaders?: string;
    rules?: string;
    settings?: CommunitySettings;
  }): Promise<Community> {
    const res = await fetch(`${API_BASE}/communities/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(updates),
    });
    return parseApiJson(res, 'Failed to update community.');
  },

  async toggleJoinCommunity(communityId: string) {
    const res = await fetch(`${API_BASE}/communities/${communityId}/toggle-join`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to update membership.');
  },

  async getCommunityMembers(communityId: string): Promise<CommunityMember[]> {
    try {
      const res = await fetch(`${API_BASE}/communities/${communityId}/members`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load community members.');
    } catch {
      return [];
    }
  },

  async getCommunityMembersPaginated(
    communityId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ members: CommunityMember[]; total: number; hasMore: boolean; nextOffset: number }> {
    try {
      const params = new URLSearchParams();
      params.set('paginated', '1');
      params.set('limit', String(options.limit ?? 50));
      params.set('offset', String(options.offset ?? 0));
      const res = await fetch(`${API_BASE}/communities/${communityId}/members?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { members: [], total: 0, hasMore: false, nextOffset: 0 };
      return await parseApiJson(res, 'Failed to load community members.');
    } catch {
      return { members: [], total: 0, hasMore: false, nextOffset: 0 };
    }
  },

  async updateCommunityMemberRole(
    communityId: string,
    userId: string,
    role: 'lead' | 'moderator' | 'member'
  ) {
    const res = await fetch(`${API_BASE}/communities/${communityId}/members/${userId}/role`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ role }),
    });
    return parseApiJson(res, 'Failed to update member role.');
  },

  async removeCommunityMember(communityId: string, userId: string) {
    const res = await fetch(`${API_BASE}/communities/${communityId}/members/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to remove member.');
  },

  async getCommunityPosts(communityId: string): Promise<Post[]> {
    try {
      const res = await fetch(`${API_BASE}/communities/${communityId}/posts`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load community discussions.');
    } catch {
      return [];
    }
  },

  async getCommunityPostsPaginated(
    communityId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<PaginatedPostsResponse> {
    const params = new URLSearchParams();
    params.set('paginated', '1');
    params.set('limit', String(options.limit ?? 15));
    params.set('offset', String(options.offset ?? 0));
    const res = await fetch(`${API_BASE}/communities/${communityId}/posts?${params.toString()}`, {
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to load community discussions.');
  },

  async createCommunityPost(
    communityId: string,
    data: {
      content: string;
      isAnnouncement?: boolean;
      announcementUrgency?: 'normal' | 'high';
      location?: CampusLocation;
      images?: string[];
    }
  ): Promise<Post> {
    const res = await fetch(`${API_BASE}/communities/${communityId}/posts`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to post to community.');
  },

  // --- Campus & Off-Campus Landmarks (Zero paid API cost) ---
  async getLandmarks(options: {
    zone?: string;
    category?: string;
    search?: string;
    isOffCampus?: boolean;
  } = {}): Promise<CampusLandmark[]> {
    const params = new URLSearchParams();
    if (options.zone) params.set('zone', options.zone);
    if (options.category) params.set('category', options.category);
    if (options.search) params.set('search', options.search);
    if (options.isOffCampus !== undefined) params.set('off_campus', String(options.isOffCampus));
    const queryStr = params.toString() ? `?${params.toString()}` : '';
    const cacheKey = `landmarks:${queryStr}`;
    const cached = getPublicCached<CampusLandmark[]>(cacheKey);
    if (cached) return cached;
    try {
      const res = await fetch(`${API_BASE}/landmarks${queryStr}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      const data = await parseApiJson<CampusLandmark[]>(res, 'Failed to load landmarks.');
      setPublicCached(cacheKey, data, 30000);
      return data;
    } catch {
      return [];
    }
  },

  async getLandmark(id: string): Promise<CampusLandmark | null> {
    try {
      const res = await fetch(`${API_BASE}/landmarks/${id}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load landmark.');
    } catch {
      return null;
    }
  },


  // --- Announcements / Notices ---
  async getNotices(): Promise<Notice[]> {
    const cached = getPublicCached<Notice[]>('notices:all');
    if (cached) return cached;
    try {
      const res = await fetch(`${API_BASE}/notices`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      const data = await parseApiJson<Notice[]>(res, 'Failed to load notices.');
      setPublicCached('notices:all', data, 30000);
      return data;
    } catch {
      return [];
    }
  },

  async createReport(data: {
    target_type: 'post' | 'comment' | 'user' | 'chat';
    target_id: string;
    reason: string;
    details?: string;
  }): Promise<AdminReport> {
    const res = await fetch(`${API_BASE}/reports`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to submit moderation report.');
  },

  // --- Stage 8 Administration & Security Client Methods ---
  async getAdminDashboard(): Promise<AdminDashboardStats | null> {
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load admin dashboard.');
    } catch {
      return null;
    }
  },

  async getAdminReports(status?: string): Promise<AdminReport[]> {
    try {
      const url = status ? `${API_BASE}/admin/reports?status=${encodeURIComponent(status)}` : `${API_BASE}/admin/reports`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load reports.');
    } catch {
      return [];
    }
  },

  async updateAdminReport(id: string, status: string, resolutionNotes?: string, actionTaken?: string) {
    const res = await fetch(`${API_BASE}/admin/reports/${id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status, resolutionNotes, actionTaken }),
    });
    return parseApiJson(res, 'Failed to update report.');
  },

  async warnUser(userId: string, reason: string, severity = 'standard', details?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/warn`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason, severity, details }),
    });
    return parseApiJson(res, 'Failed to issue account warning.');
  },

  async suspendUser(userId: string, durationDays: number, reason: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/suspend`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ durationDays, reason }),
    });
    return parseApiJson(res, 'Failed to suspend user.');
  },

  async unsuspendUser(userId: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/unsuspend`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    return parseApiJson(res, 'Failed to lift suspension.');
  },

  async getAppeals(status?: string): Promise<AppealRecord[]> {
    try {
      const url = status ? `${API_BASE}/admin/appeals?status=${encodeURIComponent(status)}` : `${API_BASE}/admin/appeals`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load appeals.');
    } catch {
      return [];
    }
  },

  async submitAppeal(type: 'suspension' | 'warning' | 'content_removal', statement: string, targetId?: string): Promise<AppealRecord> {
    const res = await fetch(`${API_BASE}/appeals`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ type, statement, targetId }),
    });
    return parseApiJson(res, 'Failed to submit appeal.');
  },

  async reviewAppeal(id: string, status: 'accepted' | 'rejected', reviewNotes?: string) {
    const res = await fetch(`${API_BASE}/admin/appeals/${id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status, reviewNotes }),
    });
    return parseApiJson(res, 'Failed to review appeal.');
  },

  async getStaffRoster(): Promise<StaffMember[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/staff`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load staff roster.');
    } catch {
      return [];
    }
  },

  async assignStaffRole(userId: string, role: string) {
    const res = await fetch(`${API_BASE}/admin/staff/role`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ userId, role }),
    });
    return parseApiJson(res, 'Failed to assign role.');
  },

  async trigger72HourPurge(): Promise<any> {
    const res = await fetch(`${API_BASE}/admin/jobs/purge-72h`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to execute 72h purge job.');
  },

  async deleteAccountPermanently(reason?: string, password?: string) {
    const res = await fetch(`${API_BASE}/user/delete-account`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        confirmation: 'PERMANENTLY_DELETE',
        reason,
        ...(password ? { password } : {}),
      }),
    });
    const result = await parseApiJson(res, 'Failed to delete account.');
    this.clearToken();
    return result;
  },

  async getBackups(): Promise<BackupSnapshot[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/backups`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load backups.');
    } catch {
      return [];
    }
  },

  async createBackup(): Promise<BackupSnapshot> {
    const res = await fetch(`${API_BASE}/admin/backups/create`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to create backup.');
  },

  async restoreBackup(id: string) {
    const res = await fetch(`${API_BASE}/admin/backups/${id}/restore`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to restore backup snapshot.');
  },

  async getAdminAuditLogs(): Promise<AdminAuditLog[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/audit-logs`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load audit logs.');
    } catch {
      return [];
    }
  },

  // --- Complete Single-Admin Control Endpoints ---
  async adminListUsers(params?: { search?: string; role?: string; status?: string }): Promise<AdminUserRecord[]> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.role) qs.set('role', params.role);
    if (params?.status) qs.set('status', params.status);
    try {
      const res = await fetch(`${API_BASE}/admin/users${qs.toString() ? `?${qs.toString()}` : ''}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to list users.');
    } catch {
      return [];
    }
  },

  async adminCreateUser(data: {
    identifier: string;
    username: string;
    password: string;
    name: string;
    role: 'admin' | 'moderator' | 'staff' | 'student';
    department?: string;
    level?: string;
    hallOfResidence?: string;
    matricNumber?: string;
  }) {
    const res = await fetch(`${API_BASE}/admin/users`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to create account.');
  },

  async adminUpdateUserProfile(userId: string, patch: {
    name?: string;
    department?: string;
    level?: string;
    hallOfResidence?: string;
    campus?: string;
    bio?: string;
    verified?: boolean;
  }) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    return parseApiJson(res, 'Failed to update profile.');
  },

  async adminDeleteUserPermanently(userId: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ confirmation: 'PERMANENTLY_DELETE', reason }),
    });
    return parseApiJson(res, 'Failed to delete user.');
  },

  async adminListContent(search?: string): Promise<{ posts: AdminContentPost[]; comments: AdminContentComment[] }> {
    const url = search ? `${API_BASE}/admin/content?search=${encodeURIComponent(search)}` : `${API_BASE}/admin/content`;
    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) return { posts: [], comments: [] };
      return await parseApiJson(res, 'Failed to list content.');
    } catch {
      return { posts: [], comments: [] };
    }
  },

  async adminTogglePostVisibility(postId: string, hidden: boolean) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}/visibility`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ hidden }),
    });
    return parseApiJson(res, 'Failed to update post visibility.');
  },

  async adminTogglePostPin(postId: string, pinned: boolean) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}/pin`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ pinned }),
    });
    return parseApiJson(res, 'Failed to pin/unpin post.');
  },

  async adminDeletePost(postId: string) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete post.');
  },

  async adminDeleteComment(commentId: string) {
    const res = await fetch(`${API_BASE}/admin/comments/${commentId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete comment.');
  },

  async adminListChats(): Promise<AdminChatOverview[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/chats`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to list chats.');
    } catch {
      return [];
    }
  },

  async adminInspectChat(chatId: string, reason: string) {
    const res = await fetch(`${API_BASE}/admin/chats/${chatId}/inspect`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    return parseApiJson(res, 'Failed to inspect chat.');
  },

  async adminDeleteChat(chatId: string, reason: string) {
    const res = await fetch(`${API_BASE}/admin/chats/${chatId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    return parseApiJson(res, 'Failed to remove chat.');
  },

  async adminListNotifications(): Promise<AdminNotificationRecord[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/notifications`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to list notifications.');
    } catch {
      return [];
    }
  },

  async adminBroadcastNotification(data: { title: string; body: string; targetUserId?: string; link?: string }) {
    const res = await fetch(`${API_BASE}/admin/notifications/broadcast`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to broadcast notification.');
  },

  async adminListCommunities(): Promise<AdminCommunityRecord[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/communities`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to list communities.');
    } catch {
      return [];
    }
  },

  async adminUpdateCommunity(communityId: string, patch: { name?: string; description?: string; location?: string; isVerified?: boolean }) {
    const res = await fetch(`${API_BASE}/admin/communities/${communityId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    return parseApiJson(res, 'Failed to update community.');
  },

  async adminDeleteCommunity(communityId: string) {
    const res = await fetch(`${API_BASE}/admin/communities/${communityId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete community.');
  },

  async adminGetStorageOverview(): Promise<AdminStorageOverview | null> {
    try {
      const res = await fetch(`${API_BASE}/admin/storage`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load storage overview.');
    } catch {
      return null;
    }
  },

  async adminCleanOrphanedFiles() {
    const res = await fetch(`${API_BASE}/admin/storage/clean-orphans`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ confirmation: 'CLEAN_ORPHANS' }),
    });
    return parseApiJson(res, 'Failed to clean orphaned files.');
  },

  async adminClearExpiredCaches() {
    const res = await fetch(`${API_BASE}/admin/storage/clear-cache`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to clear caches.');
  },

  async adminDownloadStorageReport() {
    const res = await fetch(`${API_BASE}/admin/storage/report`, { headers: getAuthHeaders() });
    return parseApiJson(res, 'Failed to generate storage report.');
  },

  async adminGetSecurityOverview(): Promise<AdminSecurityOverview | null> {
    try {
      const res = await fetch(`${API_BASE}/admin/security`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load security overview.');
    } catch {
      return null;
    }
  },

  async adminSetupMfa(): Promise<{ secret: string; otpauthUri: string; sampleCurrentCode?: string }> {
    const res = await fetch(`${API_BASE}/admin/security/mfa/setup`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to start MFA setup.');
  },

  async adminVerifyMfa(code: string) {
    const res = await fetch(`${API_BASE}/admin/security/mfa/verify`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ code }),
    });
    return parseApiJson(res, 'Invalid MFA verification code.');
  },

  async adminDisableMfa(password: string) {
    const res = await fetch(`${API_BASE}/admin/security/mfa/disable`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password }),
    });
    return parseApiJson(res, 'Failed to disable MFA.');
  },

  async adminRevokeSessions() {
    const res = await fetch(`${API_BASE}/admin/security/sessions/revoke`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to revoke sessions.');
  },

  async adminGetSecuritySessions(): Promise<DeviceSession[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/security/sessions`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      const data = await parseApiJson<any>(res, 'Failed to load sessions.');
      return Array.isArray(data?.sessions) ? data.sessions : [];
    } catch {
      return [];
    }
  },

  async adminRevokeSession(sessionId: string): Promise<{ success: boolean }> {
    const res = await fetch(`${API_BASE}/admin/security/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to revoke session.');
  },

  async adminRevokeUserSessions(userId: string): Promise<{ success: boolean; revokedCount: number }> {
    const res = await fetch(`${API_BASE}/admin/security/users/${encodeURIComponent(userId)}/revoke-sessions`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to revoke user sessions.');
  },

  async adminGetSecurityEvents(severity?: string): Promise<SecurityEventRecord[]> {
    const qs = severity && severity !== 'all' ? `?severity=${encodeURIComponent(severity)}` : '';
    try {
      const res = await fetch(`${API_BASE}/admin/security/events${qs}`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      const data = await parseApiJson<any>(res, 'Failed to load security events.');
      return Array.isArray(data?.events) ? data.events : [];
    } catch {
      return [];
    }
  },

  async adminListFeatures(): Promise<PlatformFeature[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/features`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load platform features.');
    } catch {
      return [];
    }
  },

  async adminRegisterFeature(data: {
    key: string;
    name: string;
    description: string;
    category?: 'core' | 'social' | 'discovery' | 'governance';
    navTab?: string | null;
    limits?: Record<string, any>;
  }) {
    const res = await fetch(`${API_BASE}/admin/features`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    const result = await parseApiJson(res, 'Failed to register feature flag.');
    clearPublicCache();
    return result;
  },

  async adminUpdateFeature(key: string, patch: Partial<PlatformFeature>) {
    const res = await fetch(`${API_BASE}/admin/features/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const result = await parseApiJson(res, 'Failed to update feature configuration.');
    clearPublicCache();
    return result;
  },

  async adminGetWebsiteSettings(): Promise<Record<string, string>> {
    try {
      const res = await fetch(`${API_BASE}/admin/settings`, { headers: getAuthHeaders() });
      if (!res.ok) return {};
      return await parseApiJson(res, 'Failed to load settings.');
    } catch {
      return {};
    }
  },

  async adminUpdateWebsiteSettings(settings: Record<string, string>) {
    const res = await fetch(`${API_BASE}/admin/settings`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(settings),
    });
    const result = await parseApiJson(res, 'Failed to update website settings.');
    clearPublicCache();
    return result;
  },

  // --- Official Admin Posts, Featuring & Restriction Controls ---
  async adminCreatePost(data: {
    content: string;
    areaKey?: string;
    areaLabel?: string;
    schoolTag?: string;
    hostelTag?: string;
    isPinned?: boolean;
    isFeatured?: boolean;
    isAnnouncement?: boolean;
    announcementUrgency?: 'normal' | 'high';
    distributionScope?: 'feed' | 'nearby' | 'all';
    communityId?: string;
  }) {
    const res = await fetch(`${API_BASE}/admin/posts`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to publish official Admin post.');
  },

  async adminUpdatePost(
    postId: string,
    patch: {
      content?: string;
      isPinned?: boolean;
      isFeatured?: boolean;
      isAnnouncement?: boolean;
      announcementUrgency?: 'normal' | 'high';
      distributionScope?: 'feed' | 'nearby' | 'all';
      schoolTag?: string;
      hostelTag?: string;
    }
  ) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    return parseApiJson(res, 'Failed to update post.');
  },

  async adminTogglePostFeature(postId: string, featured: boolean, distributionScope?: string) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}/feature`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ featured, distributionScope }),
    });
    return parseApiJson(res, 'Failed to update featured status.');
  },

  async adminLiftUserRestriction(userId: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/lift-restriction`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    return parseApiJson(res, 'Failed to lift restriction.');
  },

  // --- Comprehensive Real-DB Analytics & Export ---
  async adminGetAnalytics(range: AnalyticsRange = '7d'): Promise<AdminAnalyticsReport | null> {
    try {
      const res = await fetch(`${API_BASE}/admin/analytics?range=${encodeURIComponent(range)}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load analytics.');
    } catch {
      return null;
    }
  },

  async adminDownloadAnalyticsExport(range: AnalyticsRange = '7d', format: 'csv' | 'json' = 'csv') {
    const res = await fetch(
      `${API_BASE}/admin/analytics/export?range=${encodeURIComponent(range)}&format=${encodeURIComponent(format)}`,
      { headers: getAuthHeaders() }
    );
    if (!res.ok) {
      await parseApiJson(res, 'Failed to export analytics report.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schoolbackdoor-analytics-${range}-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },

  // --- Moderator Role & Permission Management (Admin Only) ---
  async adminListModerators(): Promise<ModeratorAccount[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/moderators`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load moderators.');
    } catch {
      return [];
    }
  },

  async adminAssignModerator(data: {
    userId?: string;
    identifier?: string;
    username?: string;
    password?: string;
    name?: string;
    department?: string;
    permissions?: Partial<ModeratorPermissions>;
  }): Promise<ModeratorAccount> {
    const res = await fetch(`${API_BASE}/admin/moderators`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to assign Moderator.');
  },

  async adminUpdateModeratorPermissions(userId: string, patch: Partial<ModeratorPermissions>): Promise<ModeratorAccount> {
    const res = await fetch(`${API_BASE}/admin/moderators/${userId}/permissions`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    return parseApiJson(res, 'Failed to update Moderator permissions.');
  },

  async adminRevokeModerator(userId: string) {
    const res = await fetch(`${API_BASE}/admin/moderators/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to revoke Moderator.');
  },

  // --- Advertisements & Payment Records (Admin Only) ---
  async getActiveAdvertisements(area = 'all', placement = 'feed'): Promise<AdvertisementRecord[]> {
    try {
      const res = await fetch(
        `${API_BASE}/advertisements/active?area=${encodeURIComponent(area)}&placement=${encodeURIComponent(placement)}`
      );
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load advertisements.');
    } catch {
      return [];
    }
  },

  async recordAdvertisementEvent(adId: string, eventType: 'impression' | 'click') {
    try {
      await fetch(`${API_BASE}/advertisements/${adId}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType }),
      });
    } catch {
      // ignore non-blocking tracking errors
    }
  },

  async adminListAdvertisements(): Promise<AdvertisementRecord[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/advertisements`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load advertisements.');
    } catch {
      return [];
    }
  },

  async adminCreateAdvertisement(data: {
    title: string;
    sponsorName: string;
    body: string;
    targetUrl?: string;
    imageUrl?: string;
    placement?: 'feed' | 'communities' | 'updates' | 'sidebar';
    targetArea?: string;
    status?: 'draft' | 'active' | 'paused' | 'ended';
    budgetNaira?: number;
  }): Promise<AdvertisementRecord> {
    const res = await fetch(`${API_BASE}/admin/advertisements`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to create advertisement.');
  },

  async adminUpdateAdvertisement(adId: string, patch: Partial<AdvertisementRecord>): Promise<AdvertisementRecord> {
    const res = await fetch(`${API_BASE}/admin/advertisements/${adId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    return parseApiJson(res, 'Failed to update advertisement.');
  },

  async adminDeleteAdvertisement(adId: string) {
    const res = await fetch(`${API_BASE}/admin/advertisements/${adId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete advertisement.');
  },

  async adminListPaymentRecords(params?: { status?: string; search?: string }): Promise<PaymentRecordsResponse> {
    const fallback: PaymentRecordsResponse = {
      records: [],
      retainedArchives: [],
      summary: { totalRecords: 0, confirmedNaira: 0, pendingNaira: 0, retainedCount: 0 },
    };
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.search) qs.set('search', params.search);
    try {
      const res = await fetch(`${API_BASE}/admin/payment-records${qs.toString() ? `?${qs.toString()}` : ''}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return fallback;
      return await parseApiJson(res, 'Failed to load payment records.');
    } catch {
      return fallback;
    }
  },

  async adminCreatePaymentRecord(data: {
    userId?: string;
    reference?: string;
    amountNaira: number;
    purpose?: 'subscription' | 'campus_trade_listing' | 'ticket';
    channel?: string;
    payerName?: string;
    payerBankName?: string;
    note?: string;
    status?: 'pending' | 'awaiting_verification' | 'confirmed';
  }) {
    const res = await fetch(`${API_BASE}/admin/payment-records`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to record payment entry.');
  },

  async adminUpdatePaymentRecordStatus(
    paymentId: string,
    status: 'pending' | 'awaiting_verification' | 'confirmed' | 'failed' | 'reversed' | 'refunded',
    notes?: string
  ) {
    const res = await fetch(`${API_BASE}/admin/payment-records/${paymentId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status, notes }),
    });
    return parseApiJson(res, 'Failed to update payment record status.');
  },

  // --- Moderator Desk Scoped API (Zero Admin/Finance/Settings access) ---
  async modGetDashboard(): Promise<ModeratorDashboardData | null> {
    try {
      const res = await fetch(`${API_BASE}/mod/dashboard`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return await parseApiJson(res, 'Failed to load moderator dashboard.');
    } catch {
      return null;
    }
  },

  async modListReports(params?: { status?: string; scope?: 'all' | 'assigned' | 'escalated' }): Promise<ModeratorReportItem[]> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.scope) qs.set('scope', params.scope);
    try {
      const res = await fetch(`${API_BASE}/mod/reports${qs.toString() ? `?${qs.toString()}` : ''}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load moderator reports.');
    } catch {
      return [];
    }
  },

  async modReviewReport(
    reportId: string,
    status: 'reviewed' | 'resolved' | 'dismissed',
    resolutionNotes?: string,
    actionTaken?: string
  ) {
    const res = await fetch(`${API_BASE}/mod/reports/${reportId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status, resolutionNotes, actionTaken }),
    });
    return parseApiJson(res, 'Failed to update report.');
  },

  async modEscalateReport(reportId: string, reason: string) {
    const res = await fetch(`${API_BASE}/mod/reports/${reportId}/escalate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    return parseApiJson(res, 'Failed to escalate report to Admin.');
  },

  async modModerateContent(
    targetType: 'post' | 'comment',
    targetId: string,
    action: 'hide' | 'unhide' | 'remove',
    reason: string
  ) {
    const res = await fetch(`${API_BASE}/mod/content/${targetType}/${targetId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action, reason }),
    });
    return parseApiJson(res, 'Moderation action denied.');
  },

  async modWarnUser(userId: string, reason: string, severity: 'minor' | 'standard' | 'severe' = 'standard', details?: string) {
    const res = await fetch(`${API_BASE}/mod/users/${userId}/warn`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason, severity, details }),
    });
    return parseApiJson(res, 'Failed to issue warning.');
  },

  async modRestrictUser(userId: string, durationHours: number, reason: string) {
    const res = await fetch(`${API_BASE}/mod/users/${userId}/restrict`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ durationHours, reason }),
    });
    return parseApiJson(res, 'Failed to apply restriction.');
  },

  async modListCommunities(): Promise<ModeratorCommunityReviewData> {
    try {
      const res = await fetch(`${API_BASE}/mod/communities`, { headers: getAuthHeaders() });
      if (!res.ok) return { flaggedPosts: [], communities: [] };
      return await parseApiJson(res, 'Failed to load moderator communities.');
    } catch {
      return { flaggedPosts: [], communities: [] };
    }
  },

  async modGetHistory(scope: 'mine' | 'team' = 'mine'): Promise<ModerationHistoryEntry[]> {
    try {
      const res = await fetch(`${API_BASE}/mod/history?scope=${encodeURIComponent(scope)}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return await parseApiJson(res, 'Failed to load moderation history.');
    } catch {
      return [];
    }
  },

  // --- Saved & Pinned Locations + Search History (Strictly private per authenticated account) ---
  async getSavedLocationsAndHistory(params?: {
    search?: string;
    filter?: 'all' | 'pinned' | 'saved' | 'off_campus' | 'on_campus';
  }): Promise<{ savedLocations: SavedLocation[]; searchHistory: LocationSearchHistoryItem[] }> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.filter && params.filter !== 'all') qs.set('filter', params.filter);
    const res = await fetch(`${API_BASE}/locations/saved${qs.toString() ? `?${qs.toString()}` : ''}`, {
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to load saved locations.');
  },

  async saveOrPinLocation(data: {
    id?: string;
    landmarkId?: string;
    name: string;
    customLabel?: string;
    category?: CampusLocation['category'] | string;
    campusZone?: string;
    description?: string;
    address?: string;
    notes?: string;
    coordinates: [number, number];
    isOffCampus?: boolean;
    isPinned?: boolean;
    source?: SavedLocation['source'];
  }): Promise<SavedLocation> {
    const res = await fetch(`${API_BASE}/locations/saved`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to save location.');
  },

  async updateSavedLocation(
    locationId: string,
    patch: {
      name?: string;
      customLabel?: string | null;
      notes?: string | null;
      category?: string;
      isOffCampus?: boolean;
      isPinned?: boolean;
      markUsed?: boolean;
    }
  ): Promise<SavedLocation> {
    const res = await fetch(`${API_BASE}/locations/saved/${encodeURIComponent(locationId)}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    return parseApiJson(res, 'Failed to update saved location.');
  },

  async deleteSavedLocation(locationId: string): Promise<{ success: boolean; deletedId: string }> {
    const res = await fetch(`${API_BASE}/locations/saved/${encodeURIComponent(locationId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to delete saved location.');
  },

  async getLocationSearchHistory(params?: { search?: string; limit?: number }): Promise<LocationSearchHistoryItem[]> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.limit) qs.set('limit', String(params.limit));
    const res = await fetch(`${API_BASE}/locations/history${qs.toString() ? `?${qs.toString()}` : ''}`, {
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to load location search history.');
  },

  async recordLocationSearch(data: {
    queryText: string;
    location?: {
      id?: string;
      name?: string;
      category?: string;
      campusZone?: string;
      description?: string;
      address?: string;
      coordinates?: [number, number];
      isOffCampus?: boolean;
    } | null;
  }): Promise<LocationSearchHistoryItem> {
    const res = await fetch(`${API_BASE}/locations/history`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseApiJson(res, 'Failed to record search history.');
  },

  async deleteLocationSearchHistoryItem(historyId: string): Promise<{ success: boolean; deletedId: string }> {
    const res = await fetch(`${API_BASE}/locations/history/${encodeURIComponent(historyId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to remove search history entry.');
  },

  async clearLocationSearchHistory(): Promise<{ success: boolean; clearedCount: number }> {
    const res = await fetch(`${API_BASE}/locations/history`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseApiJson(res, 'Failed to clear location search history.');
  },
};


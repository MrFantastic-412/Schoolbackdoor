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

const API_BASE = '/api';

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
      const res = await rawFetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        inMemoryAuthToken = null;
        hasKnownSession = false;
        noRefreshCooldownUntil = Date.now() + 2500;
        return false;
      }
      const data = await res.json().catch(() => ({}));
      if (data?.token) {
        inMemoryAuthToken = data.token;
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
    credentials: init.credentials ?? 'same-origin',
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
        credentials: init.credentials ?? 'same-origin',
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
    return res.json();
  },

  async getStats() {
    const res = await fetch(`${API_BASE}/stats`);
    return res.json();
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
    const result = await res.json();
    if (!res.ok) {
      const err: any = new Error(result.error || 'Registration failed.');
      err.status = res.status;
      err.code = result.code;
      throw err;
    }
    if (result.token) {
      this.setToken(result.token);
    } else {
      hasKnownSession = true;
    }
    return result;
  },

  async getPlatformConfig(): Promise<PlatformConfig | null> {
    const cached = getPublicCached<PlatformConfig>('platform:config');
    if (cached) return cached;
    try {
      const res = await fetch(`${API_BASE}/platform/config`);
      if (!res.ok) return null;
      const data = (await res.json()) as PlatformConfig;
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
    const result = await res.json();
    if (!res.ok) {
      const err: any = new Error(result.error || 'Authentication failed.');
      err.mfaRequired = Boolean(result.mfaRequired);
      err.code = result.code;
      err.retryAfterSeconds = result.retryAfterSeconds;
      throw err;
    }
    if (result.token) {
      this.setToken(result.token);
    } else {
      hasKnownSession = true;
    }
    return result;
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
      return res.json();
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
      return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Verification failed.');
    return result;
  },

  async resendVerificationCode() {
    const res = await fetch(`${API_BASE}/auth/verify/resend`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Unable to resend verification code.');
    return result;
  },

  async forgotPassword(identifier: string) {
    const res = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Password recovery failed.');
    return result;
  },

  async resetPassword(resetCode: string, newPassword: string, identifier?: string) {
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetCode, newPassword, ...(identifier ? { identifier } : {}) }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Password reset failed.');
    return result;
  },

  // --- Profile & Multi-Device Session Controls ---
  async getProfile(): Promise<StudentProfile | null> {
    try {
      const res = await fetch(`${API_BASE}/me`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.profile?.userId) {
        hasKnownSession = true;
      }
      return data.profile;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to accept Terms.');
    return result;
  },

  async reauthenticate(password: string): Promise<{ success: boolean; lastReauthenticatedAt: string }> {
    const res = await fetch(`${API_BASE}/auth/reauthenticate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Password verification failed.');
    return result;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; revokedOtherSessions: number }> {
    const res = await fetch(`${API_BASE}/auth/change-password`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update password.');
    return result;
  },

  async getMySessions(): Promise<{
    sessions: DeviceSession[];
    maxActiveDevices: number;
    accessTtlMinutes: number;
    refreshTtlDays: number;
    maxLifetimeDays: number;
  }> {
    const res = await fetch(`${API_BASE}/me/sessions`, { headers: getAuthHeaders() });
    if (!res.ok) {
      return {
        sessions: [],
        maxActiveDevices: 5,
        accessTtlMinutes: 15,
        refreshTtlDays: 30,
        maxLifetimeDays: 90,
      };
    }
    return res.json();
  },

  async revokeMySession(sessionId: string): Promise<{ success: boolean; revokedSelf?: boolean }> {
    const res = await fetch(`${API_BASE}/me/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to sign out device.');
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to revoke other device sessions.');
    return result;
  },

  async getMfaStatus(): Promise<{ mfaEnabled: boolean; role: string }> {
    const res = await fetch(`${API_BASE}/auth/mfa/status`, { headers: getAuthHeaders() });
    if (!res.ok) return { mfaEnabled: false, role: 'student' };
    return res.json();
  },

  async setupMfa(): Promise<{ secret: string; otpauthUri: string; sampleCurrentCode?: string }> {
    const res = await fetch(`${API_BASE}/auth/mfa/setup`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to start MFA setup.');
    return result;
  },

  async verifyMfa(code: string): Promise<{ success: boolean; mfaEnabled: boolean }> {
    const res = await fetch(`${API_BASE}/auth/mfa/verify`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ code }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Invalid verification code.');
    return result;
  },

  async disableMfa(password: string): Promise<{ success: boolean; mfaEnabled: boolean }> {
    const res = await fetch(`${API_BASE}/auth/mfa/disable`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to disable MFA.');
    return result;
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
      return res.json();
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
      return res.json();
    } catch {
      return [];
    }
  },

  async getPublicProfile(userId: string): Promise<StudentProfile | null> {
    try {
      const res = await fetch(`${API_BASE}/users/${userId}/profile`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  },

  async toggleConnectUser(targetUserId: string): Promise<{ isConnected: boolean; followersCount: number }> {
    const res = await fetch(`${API_BASE}/users/${targetUserId}/connect`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Unable to update connection.');
    return result;
  },

  async getUserPosts(userId: string, limit = 20): Promise<Post[]> {
    try {
      const res = await fetch(`${API_BASE}/users/${userId}/posts?limit=${limit}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return res.json();
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
    const result = await res.json();
    if (!res.ok) {
      const err: any = new Error(result.error || 'Failed to update profile.');
      err.status = res.status;
      err.code = result.code;
      throw err;
    }
    return result;
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
          try {
            result = JSON.parse(xhr.responseText || '{}');
          } catch {
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

          if (xhr.status < 200 || xhr.status >= 300) {
            const err: any = new Error(result.error || 'Image upload failed.');
            err.status = xhr.status;
            err.code = result.code;
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
      return res.json();
    } catch {
      return [];
    }
  },

  async blockUser(targetUserId: string) {
    const res = await fetch(`${API_BASE}/users/${targetUserId}/block`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to block student.');
    return result;
  },

  async unblockUser(targetUserId: string) {
    const res = await fetch(`${API_BASE}/users/${targetUserId}/unblock`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to unblock student.');
    return result;
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
      const data = await res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update location preference.');
    return result;
  },

  async getPosts(): Promise<Post[]> {
    try {
      const res = await fetch(`${API_BASE}/posts`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
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
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || 'Unable to load posts right now.');
    }
    return res.json();
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
      return res.json();
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
      return res.json();
    } catch {
      return null;
    }
  },

  async getPostById(postId: string): Promise<Post | null> {
    try {
      const res = await fetch(`${API_BASE}/posts/${postId}`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return res.json();
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
    const result = await res.json();
    if (!res.ok) {
      const err: any = new Error(result.error || 'Failed to publish post.');
      err.status = res.status;
      err.code = result.code;
      throw err;
    }
    return result;
  },

  async votePoll(postId: string, optionId: string): Promise<{ postId: string; poll: PostPoll }> {
    const res = await fetch(`${API_BASE}/posts/${postId}/poll/vote`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ optionId }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Unable to record vote right now.');
    return result;
  },

  async toggleLike(postId: string): Promise<{ isLiked: boolean; likes: number } | null> {
    const res = await fetch(`${API_BASE}/posts/${postId}/like`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Unable to update like right now.');
    return result;
  },

  async toggleRepost(postId: string): Promise<{ isReposted: boolean; reposts: number } | null> {
    const res = await fetch(`${API_BASE}/posts/${postId}/repost`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Unable to repost right now.');
    return result;
  },

  async editPost(postId: string, content: string): Promise<Post> {
    const res = await fetch(`${API_BASE}/posts/${postId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ content }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update post.');
    return result;
  },

  async deletePost(postId: string): Promise<{ success: boolean }> {
    const res = await fetch(`${API_BASE}/posts/${postId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete post.');
    return result;
  },

  async addComment(postId: string, content: string, parentCommentId?: string, images?: string[]) {
    const res = await fetch(`${API_BASE}/posts/${postId}/comments`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ content, parentCommentId, images }),
    });
    const result = await res.json();
    if (!res.ok) {
      const err: any = new Error(result.error || 'Failed to post reply.');
      err.status = res.status;
      err.code = result.code;
      throw err;
    }
    return result;
  },

  async editComment(commentId: string, content: string) {
    const res = await fetch(`${API_BASE}/comments/${commentId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ content }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to edit comment.');
    return result;
  },

  async deleteComment(commentId: string): Promise<{ success: boolean }> {
    const res = await fetch(`${API_BASE}/comments/${commentId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete comment.');
    return result;
  },

  // --- Chats & Messaging ---
  async getChats(): Promise<Conversation[]> {
    try {
      const res = await fetch(`${API_BASE}/chats`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  },

  async getChatMessages(chatId: string): Promise<Message[]> {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/messages`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
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
      return res.json();
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
    const result = await res.json();
    if (!res.ok) {
      const err: any = new Error(result.error || 'Failed to send message.');
      err.status = res.status;
      err.code = result.code;
      throw err;
    }
    return result;
  },

  async editMessage(chatId: string, messageId: string, text: string): Promise<Message> {
    const res = await fetch(`${API_BASE}/chats/${chatId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ text }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update message.');
    return result;
  },

  async deleteMessage(chatId: string, messageId: string): Promise<{ success: boolean; deletedMessageId: string; chatId: string }> {
    const res = await fetch(`${API_BASE}/chats/${chatId}/messages/${messageId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete message.');
    return result;
  },

  async markChatAsRead(chatId: string): Promise<{ success: boolean; chatId?: string; readCount?: number; readAt?: string }> {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/read`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { success: false };
      return res.json();
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
      return res.json();
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
      return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to start direct conversation.');
    return result;
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
            const ticketData = await ticketRes.json();
            if (ticketData?.ticket) {
              params.set('ticket', ticketData.ticket);
            }
          }
        } catch {
          // Fall back to anonymous SSE channel if ticket exchange fails temporarily
        }

        if (isClosed) return;
        const url = `${API_BASE}/realtime/stream?${params.toString()}`;
        eventSource = new EventSource(url);

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
      return res.json();
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
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || 'Failed to load activity.');
    }
    return res.json();
  },

  async markNotificationAsRead(id: string): Promise<{ success: boolean }> {
    try {
      const res = await fetch(`${API_BASE}/notifications/${id}/read`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) return { success: false };
      return res.json();
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
      return res.json();
    } catch {
      return { success: false };
    }
  },

  // --- Communities & Guilds ---
  async getCommunities(): Promise<Community[]> {
    try {
      const res = await fetch(`${API_BASE}/communities`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  },

  async getCommunity(id: string): Promise<Community | null> {
    try {
      const res = await fetch(`${API_BASE}/communities/${id}`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to create community.');
    return result;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update community.');
    return result;
  },

  async toggleJoinCommunity(communityId: string) {
    const res = await fetch(`${API_BASE}/communities/${communityId}/toggle-join`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to update membership.');
    }
    return res.json();
  },

  async getCommunityMembers(communityId: string): Promise<CommunityMember[]> {
    try {
      const res = await fetch(`${API_BASE}/communities/${communityId}/members`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return res.json();
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
      return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update member role.');
    return result;
  },

  async removeCommunityMember(communityId: string, userId: string) {
    const res = await fetch(`${API_BASE}/communities/${communityId}/members/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to remove member.');
    return result;
  },

  async getCommunityPosts(communityId: string): Promise<Post[]> {
    try {
      const res = await fetch(`${API_BASE}/communities/${communityId}/posts`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return [];
      return res.json();
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
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || 'Failed to load community discussions.');
    }
    return res.json();
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
    const result = await res.json();
    if (!res.ok) {
      const err: any = new Error(result.error || 'Failed to post to community.');
      err.status = res.status;
      err.code = result.code;
      throw err;
    }
    return result;
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
      const data = (await res.json()) as CampusLandmark[];
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
      return res.json();
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
      const data = (await res.json()) as Notice[];
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to submit moderation report.');
    return result;
  },

  // --- Stage 8 Administration & Security Client Methods ---
  async getAdminDashboard(): Promise<AdminDashboardStats | null> {
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard`, { headers: getAuthHeaders() });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  },

  async getAdminReports(status?: string): Promise<AdminReport[]> {
    try {
      const url = status ? `${API_BASE}/admin/reports?status=${encodeURIComponent(status)}` : `${API_BASE}/admin/reports`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update report.');
    return result;
  },

  async warnUser(userId: string, reason: string, severity = 'standard', details?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/warn`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason, severity, details }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to issue account warning.');
    return result;
  },

  async suspendUser(userId: string, durationDays: number, reason: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/suspend`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ durationDays, reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to suspend user.');
    return result;
  },

  async unsuspendUser(userId: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/unsuspend`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to lift suspension.');
    return result;
  },

  async getAppeals(status?: string): Promise<AppealRecord[]> {
    try {
      const url = status ? `${API_BASE}/admin/appeals?status=${encodeURIComponent(status)}` : `${API_BASE}/admin/appeals`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to submit appeal.');
    return result;
  },

  async reviewAppeal(id: string, status: 'accepted' | 'rejected', reviewNotes?: string) {
    const res = await fetch(`${API_BASE}/admin/appeals/${id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status, reviewNotes }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to review appeal.');
    return result;
  },

  async getStaffRoster(): Promise<StaffMember[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/staff`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to assign role.');
    return result;
  },

  async trigger72HourPurge(): Promise<any> {
    const res = await fetch(`${API_BASE}/admin/jobs/purge-72h`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to execute 72h purge job.');
    return result;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete account.');
    this.clearToken();
    return result;
  },

  async getBackups(): Promise<BackupSnapshot[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/backups`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  },

  async createBackup(): Promise<BackupSnapshot> {
    const res = await fetch(`${API_BASE}/admin/backups/create`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to create backup.');
    return result;
  },

  async restoreBackup(id: string) {
    const res = await fetch(`${API_BASE}/admin/backups/${id}/restore`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to restore backup snapshot.');
    return result;
  },

  async getAdminAuditLogs(): Promise<AdminAuditLog[]> {
    try {
      const res = await fetch(`${API_BASE}/admin/audit-logs`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
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
    const res = await fetch(`${API_BASE}/admin/users${qs.toString() ? `?${qs.toString()}` : ''}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return [];
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to create account.');
    return result;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update profile.');
    return result;
  },

  async adminDeleteUserPermanently(userId: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ confirmation: 'PERMANENTLY_DELETE', reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete user.');
    return result;
  },

  async adminListContent(search?: string): Promise<{ posts: AdminContentPost[]; comments: AdminContentComment[] }> {
    const url = search ? `${API_BASE}/admin/content?search=${encodeURIComponent(search)}` : `${API_BASE}/admin/content`;
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) return { posts: [], comments: [] };
    return res.json();
  },

  async adminTogglePostVisibility(postId: string, hidden: boolean) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}/visibility`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ hidden }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update post visibility.');
    return result;
  },

  async adminTogglePostPin(postId: string, pinned: boolean) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}/pin`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ pinned }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to pin/unpin post.');
    return result;
  },

  async adminDeletePost(postId: string) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete post.');
    return result;
  },

  async adminDeleteComment(commentId: string) {
    const res = await fetch(`${API_BASE}/admin/comments/${commentId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete comment.');
    return result;
  },

  async adminListChats(): Promise<AdminChatOverview[]> {
    const res = await fetch(`${API_BASE}/admin/chats`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return res.json();
  },

  async adminInspectChat(chatId: string, reason: string) {
    const res = await fetch(`${API_BASE}/admin/chats/${chatId}/inspect`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to inspect chat.');
    return result;
  },

  async adminDeleteChat(chatId: string, reason: string) {
    const res = await fetch(`${API_BASE}/admin/chats/${chatId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to remove chat.');
    return result;
  },

  async adminListNotifications(): Promise<AdminNotificationRecord[]> {
    const res = await fetch(`${API_BASE}/admin/notifications`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return res.json();
  },

  async adminBroadcastNotification(data: { title: string; body: string; targetUserId?: string; link?: string }) {
    const res = await fetch(`${API_BASE}/admin/notifications/broadcast`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to broadcast notification.');
    return result;
  },

  async adminListCommunities(): Promise<AdminCommunityRecord[]> {
    const res = await fetch(`${API_BASE}/admin/communities`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return res.json();
  },

  async adminUpdateCommunity(communityId: string, patch: { name?: string; description?: string; location?: string; isVerified?: boolean }) {
    const res = await fetch(`${API_BASE}/admin/communities/${communityId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update community.');
    return result;
  },

  async adminDeleteCommunity(communityId: string) {
    const res = await fetch(`${API_BASE}/admin/communities/${communityId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete community.');
    return result;
  },

  async adminGetStorageOverview(): Promise<AdminStorageOverview | null> {
    const res = await fetch(`${API_BASE}/admin/storage`, { headers: getAuthHeaders() });
    if (!res.ok) return null;
    return res.json();
  },

  async adminCleanOrphanedFiles() {
    const res = await fetch(`${API_BASE}/admin/storage/clean-orphans`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ confirmation: 'CLEAN_ORPHANS' }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to clean orphaned files.');
    return result;
  },

  async adminClearExpiredCaches() {
    const res = await fetch(`${API_BASE}/admin/storage/clear-cache`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to clear caches.');
    return result;
  },

  async adminDownloadStorageReport() {
    const res = await fetch(`${API_BASE}/admin/storage/report`, { headers: getAuthHeaders() });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to generate storage report.');
    return result;
  },

  async adminGetSecurityOverview(): Promise<AdminSecurityOverview | null> {
    const res = await fetch(`${API_BASE}/admin/security`, { headers: getAuthHeaders() });
    if (!res.ok) return null;
    return res.json();
  },

  async adminSetupMfa(): Promise<{ secret: string; otpauthUri: string; sampleCurrentCode?: string }> {
    const res = await fetch(`${API_BASE}/admin/security/mfa/setup`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to start MFA setup.');
    return result;
  },

  async adminVerifyMfa(code: string) {
    const res = await fetch(`${API_BASE}/admin/security/mfa/verify`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ code }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Invalid MFA verification code.');
    return result;
  },

  async adminDisableMfa(password: string) {
    const res = await fetch(`${API_BASE}/admin/security/mfa/disable`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to disable MFA.');
    return result;
  },

  async adminRevokeSessions() {
    const res = await fetch(`${API_BASE}/admin/security/sessions/revoke`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to revoke sessions.');
    return result;
  },

  async adminGetSecuritySessions(): Promise<DeviceSession[]> {
    const res = await fetch(`${API_BASE}/admin/security/sessions`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.sessions) ? data.sessions : [];
  },

  async adminRevokeSession(sessionId: string): Promise<{ success: boolean }> {
    const res = await fetch(`${API_BASE}/admin/security/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to revoke session.');
    return result;
  },

  async adminRevokeUserSessions(userId: string): Promise<{ success: boolean; revokedCount: number }> {
    const res = await fetch(`${API_BASE}/admin/security/users/${encodeURIComponent(userId)}/revoke-sessions`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to revoke user sessions.');
    return result;
  },

  async adminGetSecurityEvents(severity?: string): Promise<SecurityEventRecord[]> {
    const qs = severity && severity !== 'all' ? `?severity=${encodeURIComponent(severity)}` : '';
    const res = await fetch(`${API_BASE}/admin/security/events${qs}`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.events) ? data.events : [];
  },

  async adminListFeatures(): Promise<PlatformFeature[]> {
    const res = await fetch(`${API_BASE}/admin/features`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to register feature flag.');
    clearPublicCache();
    return result;
  },

  async adminUpdateFeature(key: string, patch: Partial<PlatformFeature>) {
    const res = await fetch(`${API_BASE}/admin/features/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update feature configuration.');
    clearPublicCache();
    return result;
  },

  async adminGetWebsiteSettings(): Promise<Record<string, string>> {
    const res = await fetch(`${API_BASE}/admin/settings`, { headers: getAuthHeaders() });
    if (!res.ok) return {};
    return res.json();
  },

  async adminUpdateWebsiteSettings(settings: Record<string, string>) {
    const res = await fetch(`${API_BASE}/admin/settings`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(settings),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update website settings.');
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to publish official Admin post.');
    return result;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update post.');
    return result;
  },

  async adminTogglePostFeature(postId: string, featured: boolean, distributionScope?: string) {
    const res = await fetch(`${API_BASE}/admin/posts/${postId}/feature`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ featured, distributionScope }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update featured status.');
    return result;
  },

  async adminLiftUserRestriction(userId: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/lift-restriction`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to lift restriction.');
    return result;
  },

  // --- Comprehensive Real-DB Analytics & Export ---
  async adminGetAnalytics(range: AnalyticsRange = '7d'): Promise<AdminAnalyticsReport | null> {
    const res = await fetch(`${API_BASE}/admin/analytics?range=${encodeURIComponent(range)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    return res.json();
  },

  async adminDownloadAnalyticsExport(range: AnalyticsRange = '7d', format: 'csv' | 'json' = 'csv') {
    const res = await fetch(
      `${API_BASE}/admin/analytics/export?range=${encodeURIComponent(range)}&format=${encodeURIComponent(format)}`,
      { headers: getAuthHeaders() }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to export analytics report.');
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
    const res = await fetch(`${API_BASE}/admin/moderators`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to assign Moderator.');
    return result;
  },

  async adminUpdateModeratorPermissions(userId: string, patch: Partial<ModeratorPermissions>): Promise<ModeratorAccount> {
    const res = await fetch(`${API_BASE}/admin/moderators/${userId}/permissions`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update Moderator permissions.');
    return result;
  },

  async adminRevokeModerator(userId: string) {
    const res = await fetch(`${API_BASE}/admin/moderators/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to revoke Moderator.');
    return result;
  },

  // --- Advertisements & Payment Records (Admin Only) ---
  async getActiveAdvertisements(area = 'all', placement = 'feed'): Promise<AdvertisementRecord[]> {
    try {
      const res = await fetch(
        `${API_BASE}/advertisements/active?area=${encodeURIComponent(area)}&placement=${encodeURIComponent(placement)}`
      );
      if (!res.ok) return [];
      return res.json();
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
    const res = await fetch(`${API_BASE}/admin/advertisements`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to create advertisement.');
    return result;
  },

  async adminUpdateAdvertisement(adId: string, patch: Partial<AdvertisementRecord>): Promise<AdvertisementRecord> {
    const res = await fetch(`${API_BASE}/admin/advertisements/${adId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update advertisement.');
    return result;
  },

  async adminDeleteAdvertisement(adId: string) {
    const res = await fetch(`${API_BASE}/admin/advertisements/${adId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete advertisement.');
    return result;
  },

  async adminListPaymentRecords(params?: { status?: string; search?: string }): Promise<PaymentRecordsResponse> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.search) qs.set('search', params.search);
    const res = await fetch(`${API_BASE}/admin/payment-records${qs.toString() ? `?${qs.toString()}` : ''}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) {
      return {
        records: [],
        retainedArchives: [],
        summary: { totalRecords: 0, confirmedNaira: 0, pendingNaira: 0, retainedCount: 0 },
      };
    }
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to record payment entry.');
    return result;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update payment record status.');
    return result;
  },

  // --- Moderator Desk Scoped API (Zero Admin/Finance/Settings access) ---
  async modGetDashboard(): Promise<ModeratorDashboardData | null> {
    const res = await fetch(`${API_BASE}/mod/dashboard`, { headers: getAuthHeaders() });
    if (!res.ok) return null;
    return res.json();
  },

  async modListReports(params?: { status?: string; scope?: 'all' | 'assigned' | 'escalated' }): Promise<ModeratorReportItem[]> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.scope) qs.set('scope', params.scope);
    const res = await fetch(`${API_BASE}/mod/reports${qs.toString() ? `?${qs.toString()}` : ''}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return [];
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update report.');
    return result;
  },

  async modEscalateReport(reportId: string, reason: string) {
    const res = await fetch(`${API_BASE}/mod/reports/${reportId}/escalate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to escalate report to Admin.');
    return result;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Moderation action denied.');
    return result;
  },

  async modWarnUser(userId: string, reason: string, severity: 'minor' | 'standard' | 'severe' = 'standard', details?: string) {
    const res = await fetch(`${API_BASE}/mod/users/${userId}/warn`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason, severity, details }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to issue warning.');
    return result;
  },

  async modRestrictUser(userId: string, durationHours: number, reason: string) {
    const res = await fetch(`${API_BASE}/mod/users/${userId}/restrict`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ durationHours, reason }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to apply restriction.');
    return result;
  },

  async modListCommunities(): Promise<ModeratorCommunityReviewData> {
    const res = await fetch(`${API_BASE}/mod/communities`, { headers: getAuthHeaders() });
    if (!res.ok) return { flaggedPosts: [], communities: [] };
    return res.json();
  },

  async modGetHistory(scope: 'mine' | 'team' = 'mine'): Promise<ModerationHistoryEntry[]> {
    const res = await fetch(`${API_BASE}/mod/history?scope=${encodeURIComponent(scope)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return [];
    return res.json();
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load saved locations.');
    }
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to save location.');
    return result;
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update saved location.');
    return result;
  },

  async deleteSavedLocation(locationId: string): Promise<{ success: boolean; deletedId: string }> {
    const res = await fetch(`${API_BASE}/locations/saved/${encodeURIComponent(locationId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to delete saved location.');
    return result;
  },

  async getLocationSearchHistory(params?: { search?: string; limit?: number }): Promise<LocationSearchHistoryItem[]> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.limit) qs.set('limit', String(params.limit));
    const res = await fetch(`${API_BASE}/locations/history${qs.toString() ? `?${qs.toString()}` : ''}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load location search history.');
    }
    return res.json();
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
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to record search history.');
    return result;
  },

  async deleteLocationSearchHistoryItem(historyId: string): Promise<{ success: boolean; deletedId: string }> {
    const res = await fetch(`${API_BASE}/locations/history/${encodeURIComponent(historyId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to remove search history entry.');
    return result;
  },

  async clearLocationSearchHistory(): Promise<{ success: boolean; clearedCount: number }> {
    const res = await fetch(`${API_BASE}/locations/history`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to clear location search history.');
    return result;
  },
};


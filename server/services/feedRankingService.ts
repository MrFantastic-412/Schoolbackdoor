import crypto from 'node:crypto';
import { db, runInTransaction, withReadConnection } from '../db/database.js';
import { cache } from '../utils/cache.js';
import {
  CampusAreaKey,
  LocationFilterKey,
  computeLocationRelevanceScore,
  inferPostLocation,
  normalizeAreaKey,
} from './locationTaxonomy.js';

export type FeedCategory = 'for_you' | 'nearby' | 'latest' | 'trending';

const VALID_CATEGORIES = new Set<FeedCategory>(['for_you', 'nearby', 'latest', 'trending']);

export function normalizeFeedCategory(raw: unknown): FeedCategory {
  if (typeof raw === 'string' && VALID_CATEGORIES.has(raw as FeedCategory)) {
    return raw as FeedCategory;
  }
  return 'for_you';
}

const BOT_UA_PATTERN =
  /\b(bot|crawler|spider|slurp|curl|wget|python-requests|httpclient|scrapy|headlesschrome|puppeteer|playwright|phantomjs)\b/i;

// Lightweight sliding-window rate limiter for view/share beacons per viewer key
const viewRateBuckets = new Map<string, { windowStartMs: number; count: number }>();
const MAX_VIEWS_PER_MINUTE = 80;

function checkViewRateLimit(rateKey: string): boolean {
  const now = Date.now();
  if (viewRateBuckets.size > 4000) {
    for (const [k, v] of viewRateBuckets.entries()) {
      if (now - v.windowStartMs > 120_000) viewRateBuckets.delete(k);
    }
  }
  const existing = viewRateBuckets.get(rateKey);
  if (!existing || now - existing.windowStartMs > 60_000) {
    viewRateBuckets.set(rateKey, { windowStartMs: now, count: 1 });
    return true;
  }
  if (existing.count >= MAX_VIEWS_PER_MINUTE) {
    return false;
  }
  existing.count += 1;
  return true;
}

export function buildViewerIdentityKey(options: {
  userId?: string;
  visitorId?: string;
  ipAddress?: string;
  userAgent?: string;
}): { viewerKey: string; isAuthenticated: boolean; isSuspectedBot: boolean } {
  const ua = String(options.userAgent || '');
  const isSuspectedBot = BOT_UA_PATTERN.test(ua) || (!options.userId && !ua.trim());

  if (options.userId) {
    return {
      viewerKey: `u:${options.userId}`,
      isAuthenticated: true,
      isSuspectedBot,
    };
  }

  const rawVisitor =
    typeof options.visitorId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(options.visitorId.trim())
      ? options.visitorId.trim()
      : `${options.ipAddress || 'anon'}|${ua.slice(0, 120)}`;
  const hash = crypto.createHash('sha256').update(rawVisitor).digest('hex').slice(0, 24);
  return {
    viewerKey: `g:${hash}`,
    isAuthenticated: false,
    isSuspectedBot,
  };
}

export interface PostVelocityStats {
  views2h: number;
  views6h: number;
  views24h: number;
  authViewsTotal: number;
  guestViewsTotal: number;
  likes2h: number;
  likes6h: number;
  likes24h: number;
  comments2hUnique: number;
  comments6hUnique: number;
  comments24hUnique: number;
  commentsTotalUnique: number;
  reposts2h: number;
  reposts6h: number;
  reposts24h: number;
  shares2h: number;
  shares6h: number;
  shares24h: number;
  pollVotersTotal: number;
}

const EMPTY_VELOCITY: PostVelocityStats = {
  views2h: 0,
  views6h: 0,
  views24h: 0,
  authViewsTotal: 0,
  guestViewsTotal: 0,
  likes2h: 0,
  likes6h: 0,
  likes24h: 0,
  comments2hUnique: 0,
  comments6hUnique: 0,
  comments24hUnique: 0,
  commentsTotalUnique: 0,
  reposts2h: 0,
  reposts6h: 0,
  reposts24h: 0,
  shares2h: 0,
  shares6h: 0,
  shares24h: 0,
  pollVotersTotal: 0,
};

export interface FeedActivityContext {
  freshRatio: number;
  activeBurstRatio: number;
  medianAgeHours: number;
  adaptiveHalfLifeHours: number;
}

export interface DynamicForYouWeights {
  freshness: number;
  velocity: number;
  engagement: number;
  location: number;
  views: number;
  personalization: number;
}

export function computeDynamicForYouWeights(params: {
  ageHours: number;
  trendingVelocity: number;
  accelerationFactor: number;
  viewAnomalyFactor: number;
  feedContext: FeedActivityContext;
}): DynamicForYouWeights {
  const { ageHours, trendingVelocity, accelerationFactor, viewAnomalyFactor, feedContext } = params;

  // Baseline balanced blend
  let wFreshness = 0.25;
  let wVelocity = 0.16;
  let wEngagement = 0.23;
  let wLocation = 0.15;
  let wViews = 0.11;
  let wPersonalization = 0.10;

  // 1. Freshness discovery shift for brand-new campus dispatches (< 4h)
  if (ageHours < 4.0) {
    const newness = 1 - ageHours / 4.0;
    wFreshness += 0.08 * newness;
    wEngagement -= 0.03 * newness;
    wViews -= 0.02 * newness;
  }

  // 2. Dynamic velocity boost when post has genuine recent engagement momentum
  if (viewAnomalyFactor >= 0.99 && trendingVelocity > 0.18) {
    const velocitySurge = Math.min(1, trendingVelocity * 0.7 + accelerationFactor * 0.45);
    wVelocity += 0.11 * velocitySurge;
    wEngagement -= 0.04 * velocitySurge;
    wViews -= 0.03 * velocitySurge;
  } else if (ageHours >= 14 && trendingVelocity < 0.15) {
    // 3. Dormant aging posts surrender velocity share so yesterday's static posts cool naturally
    const dormancy = Math.min(1, (ageHours - 14) / 24);
    wVelocity -= 0.05 * dormancy;
    wFreshness += 0.04 * dormancy;
  }

  // 4. Campus stream activity adaptation: busy hours sharpen freshness & velocity; quiet hours cushion interests
  const pulse = Math.min(1, Math.max(0, feedContext.freshRatio * 1.4));
  const burst = Math.min(1, Math.max(0, feedContext.activeBurstRatio * 1.5));
  wFreshness += 0.025 * pulse;
  wVelocity += 0.025 * burst;
  if (feedContext.freshRatio < 0.18) {
    wPersonalization += 0.025;
  }

  // Clamp bounds so no single metric exceeds 35% and core signals stay represented
  const clamped = {
    freshness: Math.min(0.35, Math.max(0.18, wFreshness)),
    velocity: Math.min(0.32, Math.max(0.09, wVelocity)),
    engagement: Math.min(0.28, Math.max(0.15, wEngagement)),
    location: Math.min(0.18, Math.max(0.10, wLocation)),
    views: Math.min(0.15, Math.max(0.07, wViews)),
    personalization: Math.min(0.14, Math.max(0.07, wPersonalization)),
  };

  const sum =
    clamped.freshness +
    clamped.velocity +
    clamped.engagement +
    clamped.location +
    clamped.views +
    clamped.personalization;

  return {
    freshness: clamped.freshness / sum,
    velocity: clamped.velocity / sum,
    engagement: clamped.engagement / sum,
    location: clamped.location / sum,
    views: clamped.views / sum,
    personalization: clamped.personalization / sum,
  };
}

export interface ViewerRankingContext {
  userId: string;
  consentedArea: CampusAreaKey | null;
  locationSharingEnabled: boolean;
  department: string | null;
  school: string | null;
  connectedAuthorIds: Set<string>;
  joinedCommunityIds: Set<string>;
  preferredSchoolTags: Map<string, number>;
  preferredAuthors: Map<string, number>;
}

function parseSqlTimestampMs(ts: string | null | undefined): number {
  if (!ts) return Date.now();
  const raw = String(ts).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export const feedRankingService = {
  /**
   * Records genuine, deduplicated post views with anti-bot & self-view protections.
   * Each user (or unique anonymous visitor key) counts at most once per post.
   */
  recordPostViews(
    postIds: string[],
    options: {
      userId?: string;
      visitorId?: string;
      ipAddress?: string;
      userAgent?: string;
      source?: string;
      dwellMs?: number;
    } = {}
  ): { recorded: number; skippedBot: boolean; viewsByPost: Record<string, number> } {
    const cleanIds = Array.from(
      new Set(
        (Array.isArray(postIds) ? postIds : [])
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 80)
          .slice(0, 25)
      )
    );

    if (cleanIds.length === 0) {
      return { recorded: 0, skippedBot: false, viewsByPost: {} };
    }

    const identity = buildViewerIdentityKey(options);
    if (identity.isSuspectedBot) {
      return { recorded: 0, skippedBot: true, viewsByPost: {} };
    }

    // Require sensible human viewport dwell if explicitly passed (< 400ms is treated as drive-by bot)
    const safeDwell = options.dwellMs !== undefined ? Math.min(600_000, Math.max(0, Number(options.dwellMs) || 0)) : 900;
    if (options.dwellMs !== undefined && safeDwell < 400) {
      return { recorded: 0, skippedBot: false, viewsByPost: {} };
    }

    if (!checkViewRateLimit(identity.viewerKey)) {
      return { recorded: 0, skippedBot: true, viewsByPost: {} };
    }

    const source = typeof options.source === 'string' ? options.source.trim().slice(0, 32) || 'feed' : 'feed';

    const placeholders = cleanIds.map(() => '?').join(',');
    const result = runInTransaction(() => {
      const posts = db
        .prepare(
          `
          SELECT id, author_id, is_anonymous, COALESCE(views_count, 0) as views_count
          FROM posts
          WHERE id IN (${placeholders})
            AND COALESCE(is_hidden, 0) = 0
            AND created_at >= datetime('now', '-72 hours')
        `
        )
        .all(...cleanIds) as Array<{
        id: string;
        author_id: string;
        is_anonymous: number;
        views_count: number;
      }>;

      if (posts.length === 0) {
        return { recorded: 0, viewsByPost: {} as Record<string, number> };
      }

      const blockedAuthors = new Set<string>();
      if (options.userId) {
        const blockRows = db
          .prepare(
            `SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?`
          )
          .all(options.userId, options.userId) as Array<{ blocker_id: string; blocked_id: string }>;
        for (const b of blockRows) {
          blockedAuthors.add(b.blocker_id === options.userId ? b.blocked_id : b.blocker_id);
        }
      }

      const insertViewStmt = db.prepare(`
        INSERT OR IGNORE INTO post_views (id, post_id, viewer_key, user_id, is_authenticated, source, dwell_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const incrementStmt = db.prepare(`
        UPDATE posts
        SET views_count = COALESCE(views_count, 0) + 1
        WHERE id = ?
      `);

      let recorded = 0;
      const viewsByPost: Record<string, number> = {};

      for (const p of posts) {
        let currentViews = Number(p.views_count || 0);

        // Author self-views and blocked interactions do not count toward view metrics
        const isSelfView = Boolean(options.userId && options.userId === p.author_id);
        const isBlocked = Boolean(!p.is_anonymous && blockedAuthors.has(p.author_id));

        if (!isSelfView && !isBlocked) {
          const viewId = `pv-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const ins = insertViewStmt.run(
            viewId,
            p.id,
            identity.viewerKey,
            options.userId || null,
            identity.isAuthenticated ? 1 : 0,
            source,
            Math.round(safeDwell)
          );
          if (Number(ins.changes || 0) > 0) {
            incrementStmt.run(p.id);
            currentViews += 1;
            recorded += 1;
          }
        }

        viewsByPost[p.id] = currentViews;
      }

      return { recorded, viewsByPost };
    });

    if (result.recorded > 0) {
      cache.invalidatePrefix('posts:');
    }

    return {
      recorded: result.recorded,
      skippedBot: false,
      viewsByPost: result.viewsByPost,
    };
  },

  /**
   * Records a deduplicated share interaction to power engagement & trending signals.
   */
  recordPostShare(
    postId: string,
    options: {
      userId?: string;
      visitorId?: string;
      ipAddress?: string;
      userAgent?: string;
    } = {}
  ): { shares: number; incremented: boolean } {
    const identity = buildViewerIdentityKey(options);
    if (identity.isSuspectedBot) {
      const row = withReadConnection((conn) =>
        conn.prepare('SELECT COALESCE(shares_count, 0) as c FROM posts WHERE id = ?').get(postId) as
          | { c: number }
          | undefined
      );
      return { shares: Number(row?.c || 0), incremented: false };
    }

    const res = runInTransaction(() => {
      const post = db
        .prepare(
          `SELECT id, author_id, is_anonymous, COALESCE(shares_count, 0) as shares_count
           FROM posts
           WHERE id = ? AND COALESCE(is_hidden, 0) = 0 AND created_at >= datetime('now', '-72 hours')`
        )
        .get(postId) as
        | { id: string; author_id: string; is_anonymous: number; shares_count: number }
        | undefined;

      if (!post) {
        throw new Error('Post not found or has expired after 72 hours.');
      }

      if (options.userId && !post.is_anonymous && post.author_id !== options.userId) {
        const block = db
          .prepare(
            `SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
          )
          .get(options.userId, post.author_id, post.author_id, options.userId);
        if (block) {
          throw new Error('Interaction unavailable due to privacy or block settings.');
        }
      }

      // Self-share does not artificially inflate shares_count
      if (options.userId && options.userId === post.author_id) {
        return { shares: Number(post.shares_count || 0), incremented: false };
      }

      const shareId = `ps-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const ins = db
        .prepare(
          `INSERT OR IGNORE INTO post_shares (id, post_id, sharer_key, user_id) VALUES (?, ?, ?, ?)`
        )
        .run(shareId, postId, identity.viewerKey, options.userId || null);

      if (Number(ins.changes || 0) > 0) {
        db.prepare(`UPDATE posts SET shares_count = COALESCE(shares_count, 0) + 1 WHERE id = ?`).run(postId);
        return { shares: Number(post.shares_count || 0) + 1, incremented: true };
      }

      return { shares: Number(post.shares_count || 0), incremented: false };
    });

    if (res.incremented) {
      cache.invalidatePrefix('posts:');
    }
    return res;
  },

  /**
   * Aggregates 6h & 24h velocity + distinct-actor engagement metrics across active 72h posts.
   * Cached briefly so rapid pagination and concurrent requests do not hammer SQLite.
   */
  getVelocitySnapshot(): Map<string, PostVelocityStats> {
    return cache.getOrCompute<Map<string, PostVelocityStats>>('posts:velocity:snapshot', 8000, () =>
      withReadConnection((conn) => {
        const map = new Map<string, PostVelocityStats>();
        const ensure = (postId: string): PostVelocityStats => {
          let entry = map.get(postId);
          if (!entry) {
            entry = { ...EMPTY_VELOCITY };
            map.set(postId, entry);
          }
          return entry;
        };

        const viewRows = conn
          .prepare(
            `
            SELECT
              post_id,
              SUM(CASE WHEN created_at >= datetime('now', '-2 hours') THEN CASE WHEN is_authenticated = 1 THEN 1.0 ELSE 0.45 END ELSE 0 END) as v2h,
              SUM(CASE WHEN created_at >= datetime('now', '-6 hours') THEN CASE WHEN is_authenticated = 1 THEN 1.0 ELSE 0.45 END ELSE 0 END) as v6h,
              SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN CASE WHEN is_authenticated = 1 THEN 1.0 ELSE 0.45 END ELSE 0 END) as v24h,
              SUM(CASE WHEN is_authenticated = 1 THEN 1 ELSE 0 END) as auth_total,
              SUM(CASE WHEN is_authenticated = 0 THEN 1 ELSE 0 END) as guest_total
            FROM post_views
            WHERE created_at >= datetime('now', '-72 hours')
            GROUP BY post_id
          `
          )
          .all() as any[];

        for (const r of viewRows) {
          const e = ensure(r.post_id);
          e.views2h = Number(r.v2h || 0);
          e.views6h = Number(r.v6h || 0);
          e.views24h = Number(r.v24h || 0);
          e.authViewsTotal = Number(r.auth_total || 0);
          e.guestViewsTotal = Number(r.guest_total || 0);
        }

        const likeRows = conn
          .prepare(
            `
            SELECT
              post_id,
              SUM(CASE WHEN created_at >= datetime('now', '-2 hours') THEN 1 ELSE 0 END) as l2h,
              SUM(CASE WHEN created_at >= datetime('now', '-6 hours') THEN 1 ELSE 0 END) as l6h,
              SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as l24h
            FROM likes
            WHERE created_at >= datetime('now', '-72 hours')
            GROUP BY post_id
          `
          )
          .all() as any[];

        for (const r of likeRows) {
          const e = ensure(r.post_id);
          e.likes2h = Number(r.l2h || 0);
          e.likes6h = Number(r.l6h || 0);
          e.likes24h = Number(r.l24h || 0);
        }

        // Distinct author counts stop single-account reply spamming
        const commentRows = conn
          .prepare(
            `
            SELECT
              post_id,
              COUNT(DISTINCT CASE WHEN created_at >= datetime('now', '-2 hours') THEN author_id END) as c2h_u,
              COUNT(DISTINCT CASE WHEN created_at >= datetime('now', '-6 hours') THEN author_id END) as c6h_u,
              COUNT(DISTINCT CASE WHEN created_at >= datetime('now', '-24 hours') THEN author_id END) as c24h_u,
              COUNT(DISTINCT author_id) as ctotal_u
            FROM comments
            WHERE created_at >= datetime('now', '-72 hours')
            GROUP BY post_id
          `
          )
          .all() as any[];

        for (const r of commentRows) {
          const e = ensure(r.post_id);
          e.comments2hUnique = Number(r.c2h_u || 0);
          e.comments6hUnique = Number(r.c6h_u || 0);
          e.comments24hUnique = Number(r.c24h_u || 0);
          e.commentsTotalUnique = Number(r.ctotal_u || 0);
        }

        const repostRows = conn
          .prepare(
            `
            SELECT
              post_id,
              SUM(CASE WHEN created_at >= datetime('now', '-2 hours') THEN 1 ELSE 0 END) as r2h,
              SUM(CASE WHEN created_at >= datetime('now', '-6 hours') THEN 1 ELSE 0 END) as r6h,
              SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as r24h
            FROM post_reposts
            WHERE created_at >= datetime('now', '-72 hours')
            GROUP BY post_id
          `
          )
          .all() as any[];

        for (const r of repostRows) {
          const e = ensure(r.post_id);
          e.reposts2h = Number(r.r2h || 0);
          e.reposts6h = Number(r.r6h || 0);
          e.reposts24h = Number(r.r24h || 0);
        }

        const shareRows = conn
          .prepare(
            `
            SELECT
              post_id,
              SUM(CASE WHEN created_at >= datetime('now', '-2 hours') THEN 1 ELSE 0 END) as s2h,
              SUM(CASE WHEN created_at >= datetime('now', '-6 hours') THEN 1 ELSE 0 END) as s6h,
              SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as s24h
            FROM post_shares
            WHERE created_at >= datetime('now', '-72 hours')
            GROUP BY post_id
          `
          )
          .all() as any[];

        for (const r of shareRows) {
          const e = ensure(r.post_id);
          e.shares2h = Number(r.s2h || 0);
          e.shares6h = Number(r.s6h || 0);
          e.shares24h = Number(r.s24h || 0);
        }

        const pollRows = conn
          .prepare(
            `
            SELECT post_id, COUNT(DISTINCT user_id) as pv
            FROM poll_votes
            WHERE created_at >= datetime('now', '-72 hours')
            GROUP BY post_id
          `
          )
          .all() as any[];

        for (const r of pollRows) {
          const e = ensure(r.post_id);
          e.pollVotersTotal = Number(r.pv || 0);
        }

        return map;
      })
    );
  },

  /**
   * Loads privacy-respecting personalization signals for a signed-in viewer.
   * Location preference is ONLY read if the user explicitly enabled location_sharing_enabled.
   */
  getViewerContext(viewerId: string): ViewerRankingContext {
    if (!viewerId) {
      return {
        userId: '',
        consentedArea: null,
        locationSharingEnabled: false,
        department: null,
        school: null,
        connectedAuthorIds: new Set(),
        joinedCommunityIds: new Set(),
        preferredSchoolTags: new Map(),
        preferredAuthors: new Map(),
      };
    }

    return cache.getOrCompute<ViewerRankingContext>(`posts:viewer_ctx:${viewerId}`, 15000, () =>
      withReadConnection((conn) => {
        const profile = conn
          .prepare(
            `SELECT department, school, campus, hall_of_residence,
                    COALESCE(location_sharing_enabled, 0) as location_sharing_enabled,
                    preferred_location_area
             FROM user_profiles
             WHERE user_id = ?`
          )
          .get(viewerId) as any;

        const locationSharingEnabled = Boolean(profile?.location_sharing_enabled);
        const consentedArea = locationSharingEnabled
          ? normalizeAreaKey(profile?.preferred_location_area) ||
            normalizeAreaKey(profile?.hall_of_residence) ||
            normalizeAreaKey(profile?.campus)
          : null;

        const connRows = conn
          .prepare('SELECT following_id FROM user_connections WHERE follower_id = ?')
          .all(viewerId) as Array<{ following_id: string }>;
        const connectedAuthorIds = new Set(connRows.map((r) => r.following_id));

        const commRows = conn
          .prepare('SELECT community_id FROM community_memberships WHERE user_id = ?')
          .all(viewerId) as Array<{ community_id: string }>;
        const joinedCommunityIds = new Set(commRows.map((r) => r.community_id));

        // Infer topic & author affinities strictly from the viewer's own explicit interactions
        const preferredSchoolTags = new Map<string, number>();
        const preferredAuthors = new Map<string, number>();

        const interactionRows = conn
          .prepare(
            `
            SELECT p.school_tag, p.author_id, 2.0 as w
            FROM likes l
            JOIN posts p ON p.id = l.post_id
            WHERE l.user_id = ?
            UNION ALL
            SELECT p.school_tag, p.author_id, 3.0 as w
            FROM comments c
            JOIN posts p ON p.id = c.post_id
            WHERE c.author_id = ?
            UNION ALL
            SELECT p.school_tag, p.author_id, 2.5 as w
            FROM post_reposts rp
            JOIN posts p ON p.id = rp.post_id
            WHERE rp.user_id = ?
            LIMIT 120
          `
          )
          .all(viewerId, viewerId, viewerId) as Array<{
          school_tag: string | null;
          author_id: string | null;
          w: number;
        }>;

        for (const ir of interactionRows) {
          if (ir.school_tag) {
            preferredSchoolTags.set(
              ir.school_tag,
              (preferredSchoolTags.get(ir.school_tag) || 0) + Number(ir.w || 1)
            );
          }
          if (ir.author_id && ir.author_id !== viewerId) {
            preferredAuthors.set(
              ir.author_id,
              (preferredAuthors.get(ir.author_id) || 0) + Number(ir.w || 1)
            );
          }
        }

        return {
          userId: viewerId,
          consentedArea,
          locationSharingEnabled,
          department: profile?.department || null,
          school: profile?.school || null,
          connectedAuthorIds,
          joinedCommunityIds,
          preferredSchoolTags,
          preferredAuthors,
        };
      })
    );
  },

  /**
   * Multi-signal balanced ranking across Location, Views, Engagement, Trending Velocity,
   * Freshness, and Personalization. Ensures no single metric monopolizes the feed.
   */
  rankAndFilterPosts(
    rows: any[],
    options: {
      category: FeedCategory;
      locationFilter: LocationFilterKey;
      viewerContext: ViewerRankingContext;
      velocityMap: Map<string, PostVelocityStats>;
    }
  ): Array<{
    row: any;
    score: number;
    inferredLoc: ReturnType<typeof inferPostLocation>;
    viewsCount: number;
    sharesCount: number;
    isTrending: boolean;
    isNearby: boolean;
    rankingReason?: string;
  }> {
    const nowMs = Date.now();
    const { category, locationFilter, viewerContext, velocityMap } = options;

    // Compute live feed-wide temporal & engagement context to adapt freshness decay & velocity weights
    const agesHours: number[] = [];
    let freshCount = 0;
    let activeBurstCount = 0;
    for (const r of rows) {
      const ageH = Math.max(0, (nowMs - parseSqlTimestampMs(r.created_at)) / (1000 * 60 * 60));
      agesHours.push(ageH);
      if (ageH <= 6) freshCount += 1;
      const v = velocityMap.get(r.id);
      if (v && (v.likes6h + v.comments6hUnique + v.reposts6h + v.shares6h > 0 || v.views6h >= 3)) {
        activeBurstCount += 1;
      }
    }
    const sortedAges = [...agesHours].sort((a, b) => a - b);
    const medianAgeHours =
      sortedAges.length > 0 ? sortedAges[Math.floor(sortedAges.length / 2)] : 12;
    const totalCandidates = Math.max(1, rows.length);
    const freshRatio = freshCount / totalCandidates;
    const activeBurstRatio = activeBurstCount / totalCandidates;
    // Adaptive freshness half-life: faster turnover (16h) during high-activity periods, wider (up to 26h) in quiet periods
    const adaptiveHalfLifeHours = Math.max(16, Math.min(26, 24 - freshRatio * 8));
    const feedContext: FeedActivityContext = {
      freshRatio,
      activeBurstRatio,
      medianAgeHours,
      adaptiveHalfLifeHours,
    };

    const maxTagWeight = Math.max(1, ...Array.from(viewerContext.preferredSchoolTags.values()));
    const maxAuthorWeight = Math.max(1, ...Array.from(viewerContext.preferredAuthors.values()));

    const evaluated = rows.map((row, idx) => {
      const inferredLoc = inferPostLocation({
        areaKey: row.area_key,
        locationJson: row.location_json,
        hostelTag: row.hostel_tag,
        schoolTag: row.school_tag,
        communityLocation: row.community_location,
      });

      const vel = velocityMap.get(row.id) || EMPTY_VELOCITY;
      const ageHours = agesHours[idx] ?? Math.max(0, (nowMs - parseSqlTimestampMs(row.created_at)) / (1000 * 60 * 60));

      const likesCount = Math.max(0, Number(row.likes_count || 0));
      const commentsCount = Math.max(0, Number(row.comments_count || 0));
      const repostsCount = Math.max(0, Number(row.reposts_count || 0));
      const sharesCount = Math.max(0, Number(row.shares_count || 0));
      const viewsCount = Math.max(
        0,
        Number(row.views_count || 0),
        vel.authViewsTotal + vel.guestViewsTotal
      );

      // 1. Adaptive Freshness Score [0, 1] using dynamic campus half-life + discovery boost for brand-new posts (< 3h)
      const baseDecay = Math.exp(-ageHours / feedContext.adaptiveHalfLifeHours);
      const coldStartBoost = ageHours < 3.0 ? 0.14 * (1 - ageHours / 3.0) : 0;
      const freshnessScore = Math.min(1, baseDecay + coldStartBoost);

      // 2. Meaningful Engagement Score [0, 1]
      // Distinct commenters carry highest discussion weight; extra comments from same author are capped
      const uniqueCommenters = Math.max(
        commentsCount > 0 ? 1 : 0,
        vel.commentsTotalUnique
      );
      const extraRepliesCapped = Math.min(uniqueCommenters * 2, Math.max(0, commentsCount - uniqueCommenters));
      const weightedEngagement =
        uniqueCommenters * 4.0 +
        extraRepliesCapped * 0.75 +
        sharesCount * 3.5 +
        repostsCount * 3.0 +
        likesCount * 1.5 +
        vel.pollVotersTotal * 1.2;
      const engagementScore = Math.min(1, Math.log1p(weightedEngagement) / Math.log1p(90));

      // 3. Genuine Views Score [0, 1] with anti-view-manipulation anomaly dampener
      const trustedViews =
        vel.authViewsTotal + vel.guestViewsTotal > 0
          ? vel.authViewsTotal + vel.guestViewsTotal * 0.45
          : viewsCount * 0.75;
      const totalInteractions = likesCount + commentsCount + repostsCount + sharesCount + vel.pollVotersTotal;
      const viewAnomalyFactor = trustedViews >= 25 && totalInteractions === 0 ? 0.35 : 1.0;
      const viewScore = Math.min(1, (Math.log1p(trustedViews) / Math.log1p(220)) * viewAnomalyFactor);

      // 4. Engagement Velocity & Acceleration Score [0, 1]
      // Captures 2h surge, 6h active burst, and 24h baseline while damping dormant older posts & view bots
      const genuineInteractions2h =
        vel.likes2h + vel.comments2hUnique + vel.reposts2h + vel.shares2h;
      const genuineInteractions6h =
        vel.likes6h + vel.comments6hUnique + vel.reposts6h + vel.shares6h;

      const velocity2h =
        vel.views2h * 0.8 * viewAnomalyFactor +
        vel.likes2h * 2.4 +
        vel.comments2hUnique * 5.2 +
        vel.reposts2h * 4.2 +
        vel.shares2h * 4.8;
      const velocity6h =
        vel.views6h * 0.65 * viewAnomalyFactor +
        vel.likes6h * 1.8 +
        vel.comments6hUnique * 4.5 +
        vel.reposts6h * 3.5 +
        vel.shares6h * 4.0;
      const velocity24h =
        vel.views24h * 0.35 * viewAnomalyFactor +
        vel.likes24h * 1.2 +
        vel.comments24hUnique * 3.0 +
        vel.reposts24h * 2.4 +
        vel.shares24h * 2.8;

      // Measure genuine short-term engagement acceleration (rate2h/rate6h vs prior baseline)
      const hourlyRate2h = velocity2h / 2.0;
      const prior18hRate = Math.max(0.25, (velocity24h - velocity6h) / 18.0);
      const rawAccelRatio =
        viewAnomalyFactor >= 0.99 && genuineInteractions6h > 0
          ? Math.max(0, (hourlyRate2h - prior18hRate) / (prior18hRate + 1.5))
          : 0;
      const accelerationFactor =
        viewAnomalyFactor >= 0.99 && (genuineInteractions2h > 0 || genuineInteractions6h >= 2)
          ? Math.min(1, Math.log1p(rawAccelRatio * 1.6 + genuineInteractions2h * 0.45) / Math.log1p(8))
          : 0;

      // Fallback when historical seed rows have counts but fewer recent event rows in the last 6h
      const fallbackBurst =
        velocity6h === 0 && velocity24h === 0
          ? (weightedEngagement * 0.45 + trustedViews * 0.15) * Math.exp(-ageHours / 18)
          : 0;

      const rawVelocity =
        (velocity2h * 0.85 + velocity6h * 1.2 + velocity24h * 0.4 + fallbackBurst * 0.38) /
        Math.pow(ageHours + 1.4, 1.12);
      const trendingFreshnessGuard = Math.exp(-ageHours / 16);
      const dormancyPenalty = ageHours > 12 && velocity6h === 0 && velocity2h === 0 ? 0.65 : 1.0;
      const trendingVelocity = Math.min(
        1,
        (Math.log1p(rawVelocity * 4.5) / Math.log1p(48)) *
          (0.32 + 0.68 * trendingFreshnessGuard) *
          (1 + 0.18 * accelerationFactor) *
          dormancyPenalty
      );

      // 5. Location Relevance Score [0, 1]
      const locationScore = computeLocationRelevanceScore(
        inferredLoc,
        locationFilter,
        viewerContext.consentedArea
      );

      // 6. Personalization Score [0, 1]
      let pScore = 0;
      if (viewerContext.userId) {
        if (!row.is_anonymous && viewerContext.connectedAuthorIds.has(row.author_id)) {
          pScore += 0.35;
        }
        if (row.community_id && viewerContext.joinedCommunityIds.has(row.community_id)) {
          pScore += 0.28;
        }
        if (
          viewerContext.department &&
          row.author_department &&
          String(row.author_department).toLowerCase() === viewerContext.department.toLowerCase()
        ) {
          pScore += 0.16;
        }
        if (row.school_tag && viewerContext.preferredSchoolTags.has(row.school_tag)) {
          pScore += 0.22 * (viewerContext.preferredSchoolTags.get(row.school_tag)! / maxTagWeight);
        }
        if (!row.is_anonymous && viewerContext.preferredAuthors.has(row.author_id)) {
          pScore += 0.18 * (viewerContext.preferredAuthors.get(row.author_id)! / maxAuthorWeight);
        }
      }
      const personalizationScore = Math.min(1, pScore);

      // Structured lift for pinned, featured, and official Admin announcements so critical notices reach campus feeds without permanently eclipsing organic activity
      const isFeaturedOrGlobal = Boolean(row.is_featured) || row.distribution_scope === 'global';
      const isPinnedOrAnn = Boolean(row.is_announcement) || Boolean(row.is_pinned) || Boolean(row.is_admin_post);
      const pinBonus =
        isFeaturedOrGlobal
          ? ageHours <= 48
            ? 0.24 * (0.45 + 0.55 * freshnessScore)
            : 0.06
          : isPinnedOrAnn
          ? ageHours <= 24
            ? 0.14 * (0.4 + 0.6 * freshnessScore)
            : 0.03
          : 0;

      let compositeScore = 0;
      if (category === 'latest') {
        compositeScore =
          ((Boolean(row.is_announcement) || Boolean(row.is_featured)) && ageHours <= 24 ? 1e15 : 0) +
          parseSqlTimestampMs(row.created_at);
      } else if (category === 'trending') {
        // Trending: Rapid burst + meaningful engagement + freshness + unique views + slight local relevance
        compositeScore =
          trendingVelocity * 0.34 +
          engagementScore * 0.26 +
          freshnessScore * 0.16 +
          viewScore * 0.14 +
          locationScore * 0.1 +
          pinBonus * 0.5;
      } else if (category === 'nearby') {
        // Nearby: Prioritise location proximity while still blending freshness, engagement, views & velocity
        compositeScore =
          locationScore * 0.36 +
          freshnessScore * 0.26 +
          engagementScore * 0.18 +
          trendingVelocity * 0.1 +
          viewScore * 0.1 +
          pinBonus * 0.4;
      } else {
        // For You: Dynamically weights Freshness & Engagement Velocity based on lifecycle, acceleration, and feed activity
        const dyn = computeDynamicForYouWeights({
          ageHours,
          trendingVelocity,
          accelerationFactor,
          viewAnomalyFactor,
          feedContext,
        });
        compositeScore =
          freshnessScore * dyn.freshness +
          trendingVelocity * dyn.velocity +
          engagementScore * dyn.engagement +
          locationScore * dyn.location +
          viewScore * dyn.views +
          personalizationScore * dyn.personalization +
          pinBonus;
      }

      const isTrending =
        trendingVelocity >= 0.42 ||
        vel.likes6h + vel.comments6hUnique * 2 + vel.shares6h * 2 + vel.reposts6h * 2 >= 4;
      const isNearby =
        Boolean(inferredLoc.areaKey) &&
        locationScore >= 0.55 &&
        (locationFilter !== 'all' || viewerContext.consentedArea !== null);

      let rankingReason: string | undefined;
      if (Boolean(row.is_admin_post) && (Boolean(row.is_featured) || Boolean(row.is_announcement))) {
        rankingReason = 'Official Admin Notice';
      } else if (Boolean(row.is_featured)) {
        rankingReason = 'Featured on Campus';
      } else if (category === 'nearby' && isNearby && inferredLoc.areaLabel) {
        rankingReason = locationScore >= 0.95 ? `In ${inferredLoc.areaLabel}` : `Near ${inferredLoc.areaLabel}`;
      } else if (category === 'for_you' && accelerationFactor >= 0.45 && trendingVelocity >= 0.38) {
        rankingReason = isNearby && inferredLoc.areaLabel ? `Rising in ${inferredLoc.areaLabel}` : 'Rising fast';
      } else if ((category === 'trending' || isTrending) && trendingVelocity >= 0.45) {
        rankingReason = isNearby && inferredLoc.areaLabel ? `Trending in ${inferredLoc.areaLabel}` : 'Trending now';
      } else if (category === 'for_you' && ageHours < 2.0 && genuineInteractions2h >= 1) {
        rankingReason = 'Fresh on campus';
      } else if (isNearby && inferredLoc.areaLabel) {
        rankingReason = `Near ${inferredLoc.areaLabel}`;
      } else if (personalizationScore >= 0.35 && category === 'for_you') {
        rankingReason = 'Matches your interests';
      }

      return {
        row,
        score: compositeScore,
        locationScore,
        inferredLoc,
        viewsCount,
        sharesCount,
        isTrending,
        isNearby,
        rankingReason,
      };
    });

    // Apply explicit location filter when user explicitly selected a specific campus/surrounding area or On/Off Campus
    let filtered = evaluated;
    if (locationFilter !== 'all' && locationFilter !== 'my_area') {
      if (locationFilter === 'on_campus' || locationFilter === 'off_campus') {
        filtered = evaluated.filter((item) => item.locationScore >= 0.4);
      } else {
        // Keep exact + adjacent nearby area posts (or fallback if none strictly match)
        const strictOrNearby = evaluated.filter((item) => item.locationScore >= 0.52);
        filtered = strictOrNearby.length > 0 ? strictOrNearby : evaluated.filter((item) => item.locationScore >= 0.3);
      }
    } else if (category === 'nearby' && viewerContext.consentedArea) {
      // In Nearby with consented area, show exact & nearby surrounding posts first, then remaining located posts
      filtered = evaluated;
    }

    const isExplicitAreaFilter =
      locationFilter !== 'all' &&
      locationFilter !== 'my_area' &&
      locationFilter !== 'on_campus' &&
      locationFilter !== 'off_campus';

    filtered.sort((a, b) => {
      if (isExplicitAreaFilter) {
        const aExact = a.locationScore >= 0.95 ? 1 : 0;
        const bExact = b.locationScore >= 0.95 ? 1 : 0;
        if (bExact !== aExact) return bExact - aExact;
      }
      if (b.score !== a.score) return b.score - a.score;
      return parseSqlTimestampMs(b.row.created_at) - parseSqlTimestampMs(a.row.created_at);
    });

    return filtered;
  },
};

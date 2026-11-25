import { db, runInTransaction, withReadConnection } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { landmarkService } from './landmarkService.js';
import { fileService } from './fileService.js';
import { deletionService } from './deletionService.js';
import { mentionService } from './mentionService.js';
import { validateLocationInput } from '../utils/security.js';
import {
  FeedCategory,
  feedRankingService,
  normalizeFeedCategory,
} from './feedRankingService.js';
import {
  LocationFilterKey,
  inferPostLocation,
  isValidLocationFilter,
} from './locationTaxonomy.js';

export const POST_EPHEMERAL_TTL_MS = 72 * 60 * 60 * 1000;

export function computePostExpiresAtMs(createdAt: string | null | undefined): number {
  if (!createdAt) return 0;
  const raw = String(createdAt).trim();
  if (!raw) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms + POST_EPHEMERAL_TTL_MS : 0;
}

export interface StoredPollDefinition {
  question?: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
}

export interface HydratedPoll {
  question?: string;
  options: Array<{ id: string; label: string; votes: number }>;
  allowMultiple: boolean;
  totalVotes: number;
  userVotedOptionIds: string[];
}

export function sanitizePollInput(rawPoll: unknown): StoredPollDefinition | null {
  if (rawPoll === undefined || rawPoll === null) return null;
  if (typeof rawPoll !== 'object' || Array.isArray(rawPoll)) {
    throw new Error('Invalid poll format.');
  }
  const obj = rawPoll as Record<string, unknown>;
  const rawOptions = Array.isArray(obj.options) ? obj.options : [];
  const seen = new Set<string>();
  const cleanedOptions: Array<{ id: string; label: string }> = [];

  for (const item of rawOptions) {
    const rawLabel =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && typeof (item as any).label === 'string'
        ? (item as any).label
        : '';
    const label = rawLabel.trim().slice(0, 80);
    if (!label) continue;
    const dedupeKey = label.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    cleanedOptions.push({
      id: `opt-${cleanedOptions.length + 1}`,
      label,
    });
  }

  if (cleanedOptions.length < 2 || cleanedOptions.length > 6) {
    throw new Error('Polls require between 2 and 6 distinct options.');
  }

  const question =
    typeof obj.question === 'string' && obj.question.trim()
      ? obj.question.trim().slice(0, 160)
      : undefined;

  return {
    ...(question ? { question } : {}),
    options: cleanedOptions,
    allowMultiple: Boolean(obj.allowMultiple),
  };
}

export function hydratePollsForRows(
  rows: Array<{ id: string; poll_json?: string | null }>,
  viewerId = ''
): Map<string, HydratedPoll> {
  const result = new Map<string, HydratedPoll>();
  const parsedDefs = new Map<string, StoredPollDefinition>();

  for (const r of rows) {
    if (!r.poll_json) continue;
    try {
      const def = JSON.parse(r.poll_json) as StoredPollDefinition;
      if (def && Array.isArray(def.options) && def.options.length >= 2) {
        parsedDefs.set(r.id, def);
      }
    } catch {
      // ignore malformed historical poll json
    }
  }

  if (parsedDefs.size === 0) return result;

  const pollPostIds = Array.from(parsedDefs.keys());
  const placeholders = pollPostIds.map(() => '?').join(',');
  const countsByPost = new Map<string, Map<string, number>>();
  const userVotesByPost = new Map<string, string[]>();

  withReadConnection((conn) => {
    const countRows = conn
      .prepare(
        `
        SELECT post_id, option_id, COUNT(*) as vote_count
        FROM poll_votes
        WHERE post_id IN (${placeholders})
        GROUP BY post_id, option_id
      `
      )
      .all(...pollPostIds) as Array<{ post_id: string; option_id: string; vote_count: number }>;

    for (const cr of countRows) {
      if (!countsByPost.has(cr.post_id)) countsByPost.set(cr.post_id, new Map());
      countsByPost.get(cr.post_id)!.set(cr.option_id, Number(cr.vote_count || 0));
    }

    if (viewerId) {
      const myRows = conn
        .prepare(
          `
          SELECT post_id, option_id
          FROM poll_votes
          WHERE user_id = ? AND post_id IN (${placeholders})
        `
        )
        .all(viewerId, ...pollPostIds) as Array<{ post_id: string; option_id: string }>;

      for (const mr of myRows) {
        if (!userVotesByPost.has(mr.post_id)) userVotesByPost.set(mr.post_id, []);
        userVotesByPost.get(mr.post_id)!.push(mr.option_id);
      }
    }
  });

  for (const [postId, def] of parsedDefs.entries()) {
    const optCounts = countsByPost.get(postId) || new Map<string, number>();
    const options = def.options.map((opt) => ({
      id: opt.id,
      label: opt.label,
      votes: optCounts.get(opt.id) || 0,
    }));
    const totalVotes = options.reduce((acc, o) => acc + o.votes, 0);
    result.set(postId, {
      ...(def.question ? { question: def.question } : {}),
      options,
      allowMultiple: Boolean(def.allowMultiple),
      totalVotes,
      userVotedOptionIds: userVotesByPost.get(postId) || [],
    });
  }

  return result;
}

export interface CreatePostInput {
  content: string;
  school_tag?: string;
  hostel_tag?: string;
  community_id?: string;
  is_announcement?: boolean;
  announcement_urgency?: 'normal' | 'high';
  location?: any;
  images?: string[];
  poll?: any;
  is_anonymous?: boolean;
  areaKey?: string;
  area_key?: string;
}

export type FeedFilter =
  | 'all'
  | 'general'
  | 'entertainment'
  | 'discussions'
  | 'soc'
  | 'seet'
  | 'hostel';

export type { FeedCategory, LocationFilterKey };

export interface PaginatedFeedResult {
  posts: any[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  activeCategory: FeedCategory;
  activeLocation: LocationFilterKey;
  locationSharingEnabled: boolean;
  preferredLocationArea: string | null;
  rankingStrategy?: string;
}

function buildFilterWhereClause(filter: FeedFilter): string {
  switch (filter) {
    case 'general':
      return `AND (p.school_tag IS NULL OR p.school_tag IN ('General', 'Campus Life', 'Photos'))`;
    case 'entertainment':
      return `AND (p.school_tag IN ('Memes & Fun', 'Entertainment', 'Humor') OR LOWER(p.content) LIKE '%meme%' OR LOWER(p.content) LIKE '%funny%' OR LOWER(p.content) LIKE '%vibes%')`;
    case 'discussions':
      return `AND (p.school_tag IN ('Discussions', 'Opinions'))`;
    case 'soc':
      return `AND (p.school_tag = 'SOC' OR pr.department LIKE '%Computer%')`;
    case 'seet':
      return `AND (p.school_tag = 'SEET' OR pr.department LIKE '%Eng%')`;
    case 'hostel':
      return `AND (p.hostel_tag IS NOT NULL OR p.school_tag = 'Hostels' OR LOWER(p.content) LIKE '%hostel%')`;
    default:
      return '';
  }
}

export const postService = {
  invalidateFeedCache() {
    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('admin:dashboard');
  },

  _loadRankedFeedInternal(
    currentUserId = 'u-ayodele',
    limit = 50,
    offset = 0,
    viewerRole = 'student',
    filter: FeedFilter = 'all',
    category: FeedCategory = 'for_you',
    locationFilter: LocationFilterKey = 'all'
  ): PaginatedFeedResult {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const safeCategory = normalizeFeedCategory(category);
    const safeLocation: LocationFilterKey = isValidLocationFilter(locationFilter) ? locationFilter : 'all';
    const filterSql = buildFilterWhereClause(filter);

    const candidateRows = cache.getOrCompute<any[]>(
      `posts:candidates:${filter}`,
      6000,
      () =>
        withReadConnection((conn) => {
          const rows = conn
            .prepare(
              `
              SELECT 
                p.id,
                p.content,
                p.school_tag,
                p.hostel_tag,
                p.community_id,
                p.is_announcement,
                p.announcement_urgency,
                p.location_json,
                p.images_json,
                p.poll_json,
                p.likes_count,
                p.comments_count,
                p.reposts_count,
                COALESCE(p.views_count, 0) as views_count,
                COALESCE(p.shares_count, 0) as shares_count,
                p.area_key,
                p.is_pinned,
                COALESCE(p.is_featured, 0) as is_featured,
                COALESCE(p.is_admin_post, 0) as is_admin_post,
                COALESCE(p.distribution_scope, 'standard') as distribution_scope,
                p.is_anonymous,
                p.created_at,
                p.edited_at,
                u.id as author_id,
                pr.name as author_name,
                pr.handle as author_handle,
                pr.department as author_department,
                pr.level as author_level,
                pr.avatar_initials,
                pr.avatar_bg,
                pr.avatar_url,
                pr.avatar_thumb_url,
                pr.verified as author_verified,
                pr.is_private as author_is_private,
                cm.location as community_location
              FROM posts p
              JOIN users u ON u.id = p.author_id
              JOIN user_profiles pr ON pr.user_id = u.id
              LEFT JOIN communities cm ON cm.id = p.community_id
              WHERE COALESCE(p.is_hidden, 0) = 0
                AND p.created_at >= datetime('now', '-72 hours')
                ${filterSql}
              ORDER BY p.created_at DESC
              LIMIT 400
            `
            )
            .all() as any[];

          for (const r of rows) {
            r.expiresAtMs = computePostExpiresAtMs(r.created_at);
          }
          return rows;
        })
    );

    const nowMs = Date.now();
    const activeRows = candidateRows.filter(
      (r) => (r.expiresAtMs ?? computePostExpiresAtMs(r.created_at)) > nowMs
    );
    if (activeRows.length !== candidateRows.length) {
      cache.invalidatePrefix('posts:');
    }

    // Filter out non-anonymous posts by mutually blocked users or private profiles unless connected
    let visibleRows = activeRows;
    const viewerContext = feedRankingService.getViewerContext(currentUserId);
    const isAdmin = viewerRole === 'admin';

    if (visibleRows.length > 0) {
      let blockedIds = new Set<string>();
      if (currentUserId) {
        blockedIds = withReadConnection((conn) => {
          const bRows = conn
            .prepare(
              `SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?`
            )
            .all(currentUserId, currentUserId) as Array<{ blocker_id: string; blocked_id: string }>;
          const set = new Set<string>();
          for (const b of bRows) {
            set.add(b.blocker_id === currentUserId ? b.blocked_id : b.blocker_id);
          }
          return set;
        });
      }

      visibleRows = visibleRows.filter((r) => {
        if (Boolean(r.is_anonymous)) return true;
        if (currentUserId && blockedIds.has(r.author_id)) return false;
        if (
          Boolean(r.author_is_private) &&
          !isAdmin &&
          r.author_id !== currentUserId &&
          !viewerContext.connectedAuthorIds.has(r.author_id)
        ) {
          return false;
        }
        return true;
      });
    }

    const velocityMap = feedRankingService.getVelocitySnapshot();
    const rankedItems = feedRankingService.rankAndFilterPosts(visibleRows, {
      category: safeCategory,
      locationFilter: safeLocation,
      viewerContext,
      velocityMap,
    });

    const total = rankedItems.length;
    const pagedItems = rankedItems.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + pagedItems.length;

    if (pagedItems.length === 0) {
      return {
        posts: [],
        total,
        hasMore: false,
        nextOffset,
        activeCategory: safeCategory,
        activeLocation: safeLocation,
        locationSharingEnabled: viewerContext.locationSharingEnabled,
        preferredLocationArea: viewerContext.consentedArea,
        rankingStrategy: 'dynamic_velocity_freshness_v2',
      };
    }

    const pageRows = pagedItems.map((item) => item.row);
    const postIds = pageRows.map((r) => r.id);
    const placeholders = postIds.map(() => '?').join(',');

    const commentsByPost = new Map<string, any[]>();
    const likedPostIds = new Set<string>();
    const repostedPostIds = new Set<string>();

    withReadConnection((conn) => {
      const allComments = conn
        .prepare(
          `
          SELECT 
            c.id,
            c.post_id,
            c.parent_comment_id,
            c.content,
            c.images_json,
            c.created_at,
            c.edited_at,
            c.author_id,
            pr.name as author_name,
            pr.handle as author_handle,
            pr.department as author_department,
            pr.level as author_level,
            pr.avatar_initials as author_avatar_initials,
            pr.avatar_bg as author_avatar_bg,
            pr.avatar_url as author_avatar_url,
            pr.avatar_thumb_url as author_avatar_thumb_url,
            pr.verified as author_verified
          FROM comments c
          JOIN user_profiles pr ON pr.user_id = c.author_id
          WHERE c.post_id IN (${placeholders})
          ORDER BY c.created_at ASC
        `
        )
        .all(...postIds) as any[];

      for (const c of allComments) {
        if (!commentsByPost.has(c.post_id)) {
          commentsByPost.set(c.post_id, []);
        }
        let parsedCommentImages: string[] | undefined = undefined;
        if (c.images_json) {
          try {
            const imgs = JSON.parse(c.images_json);
            if (Array.isArray(imgs) && imgs.length > 0) parsedCommentImages = imgs;
          } catch {
            // ignore
          }
        }
        commentsByPost.get(c.post_id)!.push({
          id: c.id,
          parentCommentId: c.parent_comment_id || undefined,
          authorId: c.author_id,
          authorName: c.author_name,
          authorHandle: c.author_handle,
          department: c.author_department,
          level: c.author_level,
          avatarInitials: c.author_avatar_initials,
          avatarBg: c.author_avatar_bg,
          avatarUrl: c.author_avatar_url || undefined,
          avatarThumbUrl: c.author_avatar_thumb_url || c.author_avatar_url || undefined,
          verified: Boolean(c.author_verified),
          content: c.content,
          images: parsedCommentImages,
          isEdited: Boolean(c.edited_at),
          timestamp: c.created_at,
        });
      }

      if (currentUserId) {
        const likeRows = conn
          .prepare(`SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`)
          .all(currentUserId, ...postIds) as Array<{ post_id: string }>;
        for (const lr of likeRows) likedPostIds.add(lr.post_id);

        const repostRows = conn
          .prepare(`SELECT post_id FROM post_reposts WHERE user_id = ? AND post_id IN (${placeholders})`)
          .all(currentUserId, ...postIds) as Array<{ post_id: string }>;
        for (const rr of repostRows) repostedPostIds.add(rr.post_id);
      }
    });

    const pollsByPost = hydratePollsForRows(pageRows, currentUserId);
    const allTexts: string[] = [];
    for (const post of pageRows) {
      if (post.content) allTexts.push(post.content);
      for (const c of commentsByPost.get(post.id) || []) {
        if (c.content) allTexts.push(c.content);
      }
    }
    const resolvedMentionMap = mentionService.resolveHandlesBatch(allTexts, {
      viewerId: currentUserId,
    });
    const isPrivilegedOperator = viewerRole === 'admin';

    const hydratedPosts = pagedItems.map((ranked) => {
      const post = ranked.row;
      const comments = (commentsByPost.get(post.id) || []).map((c) => ({
        ...c,
        mentions: mentionService.pickMentionsForText(c.content, resolvedMentionMap),
      }));
      const isAnon = Boolean(post.is_anonymous);
      const isAuthor = currentUserId === post.author_id;
      const maskAuthor = isAnon && !isAuthor && !isPrivilegedOperator;

      let authorName = post.author_name;
      let authorHandle = post.author_handle;
      let avatarBg = post.avatar_bg;
      let avatarInitials = post.avatar_initials;
      let avatarUrl: string | undefined = post.avatar_url || undefined;
      let avatarThumbUrl: string | undefined = post.avatar_thumb_url || post.avatar_url || undefined;
      let verified = Boolean(post.author_verified);

      if (maskAuthor) {
        authorName = 'Anonymous Member';
        authorHandle = '@anonymous';
        avatarBg = 'bg-stone-700 text-stone-100';
        avatarInitials = 'AN';
        avatarUrl = undefined;
        avatarThumbUrl = undefined;
        verified = false;
      }

      return {
        id: post.id,
        authorId: maskAuthor ? undefined : post.author_id,
        authorName,
        authorHandle,
        department: maskAuthor ? 'Anonymous' : post.author_department,
        level: maskAuthor ? 'Hidden' : post.author_level,
        avatarBg,
        avatarInitials,
        avatarUrl,
        avatarThumbUrl,
        verified,
        content: post.content,
        mentions: mentionService.pickMentionsForText(post.content, resolvedMentionMap),
        isEdited: Boolean(post.edited_at),
        timestamp: post.created_at,
        likes: post.likes_count,
        commentsCount: post.comments_count,
        reposts: post.reposts_count,
        viewsCount: ranked.viewsCount,
        sharesCount: ranked.sharesCount,
        areaKey: ranked.inferredLoc.areaKey || undefined,
        areaLabel: ranked.inferredLoc.areaLabel || undefined,
        isTrending: ranked.isTrending,
        isNearby: ranked.isNearby,
        rankingReason: ranked.rankingReason,
        isLiked: likedPostIds.has(post.id),
        isReposted: repostedPostIds.has(post.id),
        isSaved: false,
        isAnonymous: isAnon,
        operatorNote:
          isAnon && (isAuthor || isPrivilegedOperator)
            ? 'Identity masked from peers. Traceable by authorized platform admins.'
            : undefined,
        schoolTag: post.school_tag || undefined,
        hostelTag: post.hostel_tag || undefined,
        communityId: post.community_id || undefined,
        isAnnouncement: Boolean(post.is_announcement),
        announcementUrgency: post.announcement_urgency || 'normal',
        isPinned: Boolean(post.is_pinned),
        isFeatured: Boolean(post.is_featured),
        isAdminPost: Boolean(post.is_admin_post),
        distributionScope: post.distribution_scope || 'standard',
        location: post.location_json ? JSON.parse(post.location_json) : undefined,
        images: post.images_json ? JSON.parse(post.images_json) : undefined,
        poll: pollsByPost.get(post.id),
        comments,
      };
    });

    return {
      posts: hydratedPosts,
      total,
      hasMore: nextOffset < total && hydratedPosts.length > 0,
      nextOffset,
      activeCategory: safeCategory,
      activeLocation: safeLocation,
      locationSharingEnabled: viewerContext.locationSharingEnabled,
      preferredLocationArea: viewerContext.consentedArea,
      rankingStrategy: 'dynamic_velocity_freshness_v2',
    };
  },

  getFeedPosts(
    currentUserId = 'u-ayodele',
    limit = 50,
    offset = 0,
    viewerRole = 'student',
    filter: FeedFilter = 'all',
    category: FeedCategory = 'for_you',
    location: LocationFilterKey = 'all'
  ) {
    return this._loadRankedFeedInternal(
      currentUserId,
      limit,
      offset,
      viewerRole,
      filter,
      category,
      location
    ).posts;
  },

  getFeedPostsPaginated(
    currentUserId = 'u-ayodele',
    options: {
      limit?: number;
      offset?: number;
      filter?: FeedFilter;
      category?: FeedCategory;
      location?: LocationFilterKey;
    } = {},
    viewerRole = 'student'
  ): PaginatedFeedResult {
    const limit = Math.min(50, Math.max(1, options.limit ?? 15));
    const offset = Math.max(0, options.offset ?? 0);
    const filter: FeedFilter = options.filter || 'all';
    const category: FeedCategory = options.category || 'for_you';
    const location: LocationFilterKey = options.location || 'all';

    return this._loadRankedFeedInternal(
      currentUserId,
      limit,
      offset,
      viewerRole,
      filter,
      category,
      location
    );
  },

  getPostById(postId: string, currentUserId = 'u-ayodele', viewerRole = 'student') {
    const result = withReadConnection((conn) => {
      const post = conn.prepare(`
        SELECT 
          p.*,
          pr.name as author_name,
          pr.handle as author_handle,
          pr.department as author_department,
          pr.level as author_level,
          pr.avatar_initials,
          pr.avatar_bg,
          pr.avatar_url,
          pr.avatar_thumb_url,
          pr.verified as author_verified,
          pr.is_private as author_is_private,
          CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END as is_liked,
          CASE WHEN rp.id IS NOT NULL THEN 1 ELSE 0 END as is_reposted
        FROM posts p
        JOIN users u ON u.id = p.author_id
        JOIN user_profiles pr ON pr.user_id = u.id
        LEFT JOIN likes l ON l.post_id = p.id AND l.user_id = ?
        LEFT JOIN post_reposts rp ON rp.post_id = p.id AND rp.user_id = ?
        WHERE p.id = ?
          AND COALESCE(p.is_hidden, 0) = 0
          AND p.created_at >= datetime('now', '-72 hours')
      `).get(currentUserId, currentUserId, postId) as any;

      if (!post || computePostExpiresAtMs(post.created_at) <= Date.now()) return null;

      const isAdmin = viewerRole === 'admin';
      const isAuthorViewing = Boolean(currentUserId && currentUserId === post.author_id);

      // Enforce mutual block restriction on non-anonymous posts
      if (currentUserId && !isAuthorViewing && !isAdmin && !post.is_anonymous) {
        const block = conn
          .prepare(`
            SELECT 1 FROM user_blocks
            WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
          `)
          .get(currentUserId, post.author_id, post.author_id, currentUserId);
        if (block) return null;
      }

      // Enforce private profile access control on non-anonymous posts
      if (Boolean(post.author_is_private) && !post.is_anonymous && !isAuthorViewing && !isAdmin) {
        const connected = currentUserId
          ? conn
              .prepare('SELECT 1 FROM user_connections WHERE follower_id = ? AND following_id = ?')
              .get(currentUserId, post.author_id)
          : undefined;
        if (!connected) return null;
      }

      const comments = conn.prepare(`
        SELECT 
          c.id, c.parent_comment_id, c.author_id, c.content, c.images_json, c.created_at, c.edited_at,
          pr.name as author_name, pr.handle as author_handle, pr.department, pr.level,
          pr.avatar_initials as author_avatar_initials, pr.avatar_bg as author_avatar_bg,
          pr.avatar_url as author_avatar_url, pr.avatar_thumb_url as author_avatar_thumb_url,
          pr.verified as author_verified
        FROM comments c
        JOIN user_profiles pr ON pr.user_id = c.author_id
        WHERE c.post_id = ?
        ORDER BY c.created_at ASC
      `).all(postId) as any[];

      return { post, comments };
    });

    if (!result) return null;
    const { post, comments } = result;

    const isPrivilegedOperator = viewerRole === 'admin';
    const isAnon = Boolean(post.is_anonymous);
    const isAuthor = currentUserId === post.author_id;
    const maskAuthor = isAnon && !isAuthor && !isPrivilegedOperator;

    const pollsByPost = hydratePollsForRows([post], currentUserId);
    const resolvedMentionMap = mentionService.resolveHandlesBatch(
      [post.content, ...comments.map((c) => c.content)],
      { viewerId: currentUserId, communityId: post.community_id || undefined }
    );

    return {
      id: post.id,
      authorId: maskAuthor ? undefined : post.author_id,
      authorName: maskAuthor ? 'Anonymous Member' : post.author_name,
      authorHandle: maskAuthor ? '@anonymous' : post.author_handle,
      department: maskAuthor ? 'Anonymous' : post.author_department,
      level: maskAuthor ? 'Hidden' : post.author_level,
      avatarBg: maskAuthor ? 'bg-stone-700 text-stone-100' : post.avatar_bg,
      avatarInitials: maskAuthor ? 'AN' : post.avatar_initials,
      avatarUrl: maskAuthor ? undefined : post.avatar_url || undefined,
      avatarThumbUrl: maskAuthor ? undefined : post.avatar_thumb_url || post.avatar_url || undefined,
      verified: maskAuthor ? false : Boolean(post.author_verified),
      content: post.content,
      mentions: mentionService.pickMentionsForText(post.content, resolvedMentionMap),
      isEdited: Boolean(post.edited_at),
      timestamp: post.created_at,
      likes: post.likes_count,
      commentsCount: post.comments_count,
      reposts: post.reposts_count,
      viewsCount: Number(post.views_count || 0),
      sharesCount: Number(post.shares_count || 0),
      areaKey:
        inferPostLocation({
          areaKey: post.area_key,
          locationJson: post.location_json,
          hostelTag: post.hostel_tag,
          schoolTag: post.school_tag,
        }).areaKey || undefined,
      areaLabel:
        inferPostLocation({
          areaKey: post.area_key,
          locationJson: post.location_json,
          hostelTag: post.hostel_tag,
          schoolTag: post.school_tag,
        }).areaLabel || undefined,
      isLiked: Boolean(post.is_liked),
      isReposted: Boolean(post.is_reposted),
      isSaved: false,
      isAnonymous: isAnon,
      operatorNote:
        isAnon && (isAuthor || isPrivilegedOperator)
          ? 'Identity masked from peers. Traceable by authorized platform admins.'
          : undefined,
      schoolTag: post.school_tag || undefined,
      hostelTag: post.hostel_tag || undefined,
      communityId: post.community_id || undefined,
      isAnnouncement: Boolean(post.is_announcement),
      announcementUrgency: post.announcement_urgency || 'normal',
      isPinned: Boolean(post.is_pinned),
      isFeatured: Boolean(post.is_featured),
      isAdminPost: Boolean(post.is_admin_post),
      distributionScope: post.distribution_scope || 'standard',
      location: post.location_json ? JSON.parse(post.location_json) : undefined,
      images: post.images_json ? JSON.parse(post.images_json) : undefined,
      poll: pollsByPost.get(post.id),
      comments: comments.map((c) => {
        let parsedImages: string[] | undefined = undefined;
        if (c.images_json) {
          try {
            const imgs = JSON.parse(c.images_json);
            if (Array.isArray(imgs) && imgs.length > 0) parsedImages = imgs;
          } catch {
            // ignore
          }
        }
        return {
          id: c.id,
          parentCommentId: c.parent_comment_id || undefined,
          authorId: c.author_id,
          authorName: c.author_name,
          authorHandle: c.author_handle,
          department: c.department,
          level: c.level,
          avatarInitials: c.author_avatar_initials,
          avatarBg: c.author_avatar_bg,
          avatarUrl: c.author_avatar_url || undefined,
          avatarThumbUrl: c.author_avatar_thumb_url || c.author_avatar_url || undefined,
          verified: Boolean(c.author_verified),
          content: c.content,
          images: parsedImages,
          mentions: mentionService.pickMentionsForText(c.content, resolvedMentionMap),
          isEdited: Boolean(c.edited_at),
          timestamp: c.created_at,
        };
      }),
    };
  },

  getUserPublicPosts(targetUserId: string, viewerId = '', viewerRole = 'student', limit = 20) {
    const safeLimit = Math.min(50, Math.max(1, limit));

    return withReadConnection((conn) => {
      if (viewerId && viewerId !== targetUserId) {
        const block = conn
          .prepare(`
            SELECT 1 FROM user_blocks
            WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
          `)
          .get(viewerId, targetUserId, targetUserId, viewerId);
        if (block) return [];
      }

      const targetProfile = conn
        .prepare('SELECT is_private FROM user_profiles WHERE user_id = ?')
        .get(targetUserId) as { is_private: number } | undefined;
      if (!targetProfile) return [];

      const isOwner = viewerId === targetUserId;
      const isAdmin = viewerRole === 'admin';
      if (Boolean(targetProfile.is_private) && !isOwner && !isAdmin) {
        const connected = viewerId
          ? conn
              .prepare('SELECT 1 FROM user_connections WHERE follower_id = ? AND following_id = ?')
              .get(viewerId, targetUserId)
          : undefined;
        if (!connected) return [];
      }

      const rows = conn.prepare(`
        SELECT 
          p.*,
          pr.name as author_name,
          pr.handle as author_handle,
          pr.department as author_department,
          pr.level as author_level,
          pr.avatar_initials,
          pr.avatar_bg,
          pr.avatar_url,
          pr.avatar_thumb_url,
          pr.verified as author_verified
        FROM posts p
        JOIN user_profiles pr ON pr.user_id = p.author_id
        WHERE p.author_id = ?
          AND COALESCE(p.is_hidden, 0) = 0
          AND COALESCE(p.is_anonymous, 0) = 0
          AND p.created_at >= datetime('now', '-72 hours')
        ORDER BY p.created_at DESC
        LIMIT ?
      `).all(targetUserId, safeLimit) as any[];

      const nowMs = Date.now();
      const activeRows = rows.filter((r) => computePostExpiresAtMs(r.created_at) > nowMs);
      if (activeRows.length === 0) return [];

      const postIds = activeRows.map((r) => r.id);
      const placeholders = postIds.map(() => '?').join(',');

      const commentsByPost = new Map<string, any[]>();
      const allComments = conn.prepare(`
        SELECT 
          c.id, c.post_id, c.parent_comment_id, c.author_id, c.content, c.images_json, c.created_at, c.edited_at,
          pr.name as author_name, pr.handle as author_handle, pr.department as author_department, pr.level as author_level,
          pr.avatar_initials as author_avatar_initials, pr.avatar_bg as author_avatar_bg,
          pr.avatar_url as author_avatar_url, pr.avatar_thumb_url as author_avatar_thumb_url,
          pr.verified as author_verified
        FROM comments c
        JOIN user_profiles pr ON pr.user_id = c.author_id
        WHERE c.post_id IN (${placeholders})
        ORDER BY c.created_at ASC
      `).all(...postIds) as any[];

      const allTexts: string[] = activeRows.map((p) => p.content).filter(Boolean);
      for (const c of allComments) {
        if (c.content) allTexts.push(c.content);
        if (!commentsByPost.has(c.post_id)) commentsByPost.set(c.post_id, []);
        let parsedCommentImages: string[] | undefined = undefined;
        if (c.images_json) {
          try {
            const imgs = JSON.parse(c.images_json);
            if (Array.isArray(imgs) && imgs.length > 0) parsedCommentImages = imgs;
          } catch {
            // ignore
          }
        }
        commentsByPost.get(c.post_id)!.push({
          id: c.id,
          parentCommentId: c.parent_comment_id || undefined,
          authorId: c.author_id,
          authorName: c.author_name,
          authorHandle: c.author_handle,
          department: c.author_department,
          level: c.author_level,
          avatarInitials: c.author_avatar_initials,
          avatarBg: c.author_avatar_bg,
          avatarUrl: c.author_avatar_url || undefined,
          avatarThumbUrl: c.author_avatar_thumb_url || c.author_avatar_url || undefined,
          verified: Boolean(c.author_verified),
          content: c.content,
          images: parsedCommentImages,
          isEdited: Boolean(c.edited_at),
          timestamp: c.created_at,
        });
      }

      const likedIds = new Set<string>();
      const repostedIds = new Set<string>();
      if (viewerId) {
        const likes = conn
          .prepare(`SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`)
          .all(viewerId, ...postIds) as Array<{ post_id: string }>;
        likes.forEach((l) => likedIds.add(l.post_id));

        const reposts = conn
          .prepare(`SELECT post_id FROM post_reposts WHERE user_id = ? AND post_id IN (${placeholders})`)
          .all(viewerId, ...postIds) as Array<{ post_id: string }>;
        reposts.forEach((rp) => repostedIds.add(rp.post_id));
      }

      const pollsByPost = hydratePollsForRows(activeRows, viewerId);
      const resolvedMentionMap = mentionService.resolveHandlesBatch(allTexts, { viewerId });

      return activeRows.map((post) => ({
        id: post.id,
        authorId: post.author_id,
        authorName: post.author_name,
        authorHandle: post.author_handle,
        department: post.author_department,
        level: post.author_level,
        avatarBg: post.avatar_bg,
        avatarInitials: post.avatar_initials,
        avatarUrl: post.avatar_url || undefined,
        avatarThumbUrl: post.avatar_thumb_url || post.avatar_url || undefined,
        verified: Boolean(post.author_verified),
        content: post.content,
        mentions: mentionService.pickMentionsForText(post.content, resolvedMentionMap),
        isEdited: Boolean(post.edited_at),
        timestamp: post.created_at,
        likes: post.likes_count,
        commentsCount: post.comments_count,
        reposts: post.reposts_count,
        viewsCount: Number(post.views_count || 0),
        sharesCount: Number(post.shares_count || 0),
        areaKey:
          inferPostLocation({
            areaKey: post.area_key,
            locationJson: post.location_json,
            hostelTag: post.hostel_tag,
            schoolTag: post.school_tag,
          }).areaKey || undefined,
        areaLabel:
          inferPostLocation({
            areaKey: post.area_key,
            locationJson: post.location_json,
            hostelTag: post.hostel_tag,
            schoolTag: post.school_tag,
          }).areaLabel || undefined,
        isLiked: likedIds.has(post.id),
        isReposted: repostedIds.has(post.id),
        isSaved: false,
        isAnonymous: false,
        schoolTag: post.school_tag || undefined,
        hostelTag: post.hostel_tag || undefined,
        communityId: post.community_id || undefined,
        isAnnouncement: Boolean(post.is_announcement),
        announcementUrgency: post.announcement_urgency || 'normal',
        isPinned: Boolean(post.is_pinned),
        isFeatured: Boolean(post.is_featured),
        isAdminPost: Boolean(post.is_admin_post),
        distributionScope: post.distribution_scope || 'standard',
        location: post.location_json ? JSON.parse(post.location_json) : undefined,
        images: post.images_json ? JSON.parse(post.images_json) : undefined,
        poll: pollsByPost.get(post.id),
        comments: (commentsByPost.get(post.id) || []).map((c) => ({
          ...c,
          mentions: mentionService.pickMentionsForText(c.content, resolvedMentionMap),
        })),
      }));
    });
  },

  createPost(authorId: string, input: CreatePostInput, authorRole = 'student') {
    const sanitizedPoll = sanitizePollInput(input.poll);
    const trimmedContent = typeof input.content === 'string' ? input.content.trim() : '';
    const hasImages = Array.isArray(input.images) && input.images.length > 0;
    const effectiveContent = trimmedContent || sanitizedPoll?.question || '';
    if (!effectiveContent && !hasImages) {
      throw new Error('Post content cannot be empty.');
    }

    if (input.is_announcement && authorRole !== 'admin' && authorRole !== 'staff') {
      throw new Error('Only administrators or authorized staff can publish pinned announcements.');
    }

    const sanitizedLocation = input.location ? validateLocationInput(input.location) : null;
    const postId = `post-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const locationJson = sanitizedLocation ? JSON.stringify(sanitizedLocation) : null;
    const externalImages = fileService.externalizeImages(input.images, authorId);
    const imagesJson = externalImages && externalImages.length > 0 ? JSON.stringify(externalImages) : null;
    const pollJson = sanitizedPoll ? JSON.stringify(sanitizedPoll) : null;
    const isAnonymous = input.is_anonymous ? 1 : 0;
    const isAnnouncement = input.is_announcement ? 1 : 0;
    const urgency = input.announcement_urgency === 'high' ? 'high' : 'normal';

    const schoolTag =
      typeof input.school_tag === 'string' ? input.school_tag.trim().slice(0, 60) || null : null;
    const hostelTag =
      typeof input.hostel_tag === 'string' ? input.hostel_tag.trim().slice(0, 60) || null : null;
    const communityId =
      typeof input.community_id === 'string' ? input.community_id.trim().slice(0, 64) || null : null;
    const inferredArea = inferPostLocation({
      areaKey: typeof (input.areaKey || input.area_key) === 'string' ? input.areaKey || input.area_key : null,
      locationObj: sanitizedLocation,
      hostelTag,
      schoolTag,
    });

    db.prepare(`
      INSERT INTO posts (
        id, author_id, content, school_tag, hostel_tag, community_id, is_announcement, announcement_urgency,
        location_json, images_json, poll_json, likes_count, comments_count, reposts_count, views_count, shares_count,
        area_key, is_pinned, is_featured, is_admin_post, distribution_scope, is_anonymous
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      postId,
      authorId,
      effectiveContent,
      schoolTag,
      hostelTag,
      communityId,
      isAnnouncement,
      urgency,
      locationJson,
      imagesJson,
      pollJson,
      inferredArea.areaKey,
      isAnnouncement ? 1 : 0,
      0,
      authorRole === 'admin' && isAnnouncement ? 1 : 0,
      'standard',
      isAnonymous
    );

    if (sanitizedLocation?.id) {
      try {
        landmarkService.incrementPinCount(sanitizedLocation.id);
      } catch {
        // ignore
      }
    }

    this.invalidateFeedCache();
    return this.getPostById(postId, authorId, authorRole);
  },

  voteOnPoll(postId: string, userId: string, optionId: string) {
    const cleanOptionId = String(optionId || '').trim();
    if (!cleanOptionId) {
      throw new Error('Poll option ID is required.');
    }

    const updatedPoll = runInTransaction(() => {
      const post = db
        .prepare(
          `
          SELECT id, author_id, is_anonymous, poll_json, created_at
          FROM posts
          WHERE id = ?
            AND COALESCE(is_hidden, 0) = 0
            AND created_at >= datetime('now', '-72 hours')
        `
        )
        .get(postId) as
        | { id: string; author_id: string; is_anonymous: number; poll_json: string | null; created_at: string }
        | undefined;

      if (!post || computePostExpiresAtMs(post.created_at) <= Date.now()) {
        throw new Error('Dispatch not found or has expired after 72 hours.');
      }

      if (!post.is_anonymous && post.author_id !== userId) {
        const block = db
          .prepare(
            `SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
          )
          .get(userId, post.author_id, post.author_id, userId);
        if (block) {
          throw new Error('Interaction unavailable due to privacy or block settings.');
        }
      }

      if (!post.poll_json) {
        throw new Error('This post does not contain an active poll.');
      }

      let def: StoredPollDefinition;
      try {
        def = JSON.parse(post.poll_json) as StoredPollDefinition;
      } catch {
        throw new Error('Poll configuration is unavailable.');
      }

      if (!def.options?.some((opt) => opt.id === cleanOptionId)) {
        throw new Error('Selected poll option is invalid.');
      }

      if (def.allowMultiple) {
        const existing = db
          .prepare('SELECT id FROM poll_votes WHERE post_id = ? AND user_id = ? AND option_id = ?')
          .get(postId, userId, cleanOptionId) as { id: string } | undefined;

        if (existing) {
          db.prepare('DELETE FROM poll_votes WHERE id = ?').run(existing.id);
        } else {
          const voteId = `pv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          db.prepare('INSERT INTO poll_votes (id, post_id, user_id, option_id) VALUES (?, ?, ?, ?)').run(
            voteId,
            postId,
            userId,
            cleanOptionId
          );
        }
      } else {
        db.prepare('DELETE FROM poll_votes WHERE post_id = ? AND user_id = ?').run(postId, userId);
        const voteId = `pv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        db.prepare('INSERT INTO poll_votes (id, post_id, user_id, option_id) VALUES (?, ?, ?, ?)').run(
          voteId,
          postId,
          userId,
          cleanOptionId
        );
      }

      const countRows = db
        .prepare(
          `
          SELECT option_id, COUNT(*) as vote_count
          FROM poll_votes
          WHERE post_id = ?
          GROUP BY option_id
        `
        )
        .all(postId) as Array<{ option_id: string; vote_count: number }>;
      const countMap = new Map<string, number>();
      for (const cr of countRows) {
        countMap.set(cr.option_id, Number(cr.vote_count || 0));
      }

      const myRows = db
        .prepare('SELECT option_id FROM poll_votes WHERE post_id = ? AND user_id = ?')
        .all(postId, userId) as Array<{ option_id: string }>;

      const options = def.options.map((opt) => ({
        id: opt.id,
        label: opt.label,
        votes: countMap.get(opt.id) || 0,
      }));
      const totalVotes = options.reduce((acc, o) => acc + o.votes, 0);

      return {
        ...(def.question ? { question: def.question } : {}),
        options,
        allowMultiple: Boolean(def.allowMultiple),
        totalVotes,
        userVotedOptionIds: myRows.map((r) => r.option_id),
      } satisfies HydratedPoll;
    });

    this.invalidateFeedCache();
    return { postId, poll: updatedPoll };
  },

  editPost(postId: string, userId: string, userRole: string, input: { content: string }) {
    const cleanContent = typeof input?.content === 'string' ? input.content.trim() : '';
    if (!cleanContent) {
      throw new Error('Post content cannot be empty.');
    }

    runInTransaction(() => {
      const post = db
        .prepare(
          `SELECT id, author_id, is_anonymous, community_id, created_at FROM posts WHERE id = ? AND COALESCE(is_hidden, 0) = 0 AND created_at >= datetime('now', '-72 hours')`
        )
        .get(postId) as
        | {
            id: string;
            author_id: string;
            is_anonymous: number;
            community_id: string | null;
            created_at: string;
          }
        | undefined;

      if (!post || computePostExpiresAtMs(post.created_at) <= Date.now()) {
        throw new Error('Post not found or has expired after 72 hours.');
      }

      if (post.author_id !== userId) {
        throw new Error('Only the author can edit this post.');
      }

      db.prepare(`
        UPDATE posts
        SET content = ?, edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cleanContent, postId);

      mentionService.syncMentionsOnContent({
        text: cleanContent,
        sourceType: 'post',
        sourceId: postId,
        actorId: userId,
        targetLink: post.community_id
          ? `/communities?id=${post.community_id}&post=${postId}`
          : `/home?post=${postId}`,
        contextTitle: post.community_id ? 'Community post' : 'Campus Commons dispatch',
        isAnonymous: Boolean(post.is_anonymous),
        communityId: post.community_id || undefined,
      });
    });

    this.invalidateFeedCache();
    return this.getPostById(postId, userId, userRole);
  },

  deletePost(postId: string, userId: string, userRole: string) {
    const post = db.prepare('SELECT author_id, images_json FROM posts WHERE id = ?').get(postId) as
      | { author_id: string; images_json: string | null }
      | undefined;
    if (!post) {
      throw new Error('Post not found.');
    }

    if (post.author_id !== userId && userRole !== 'admin') {
      throw new Error('Unauthorized to delete this post.');
    }

    const childComments = db
      .prepare('SELECT id, images_json FROM comments WHERE post_id = ?')
      .all(postId) as Array<{ id: string; images_json: string | null }>;

    db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
    mentionService.deleteNotificationsBySource('post', postId);
    for (const c of childComments) {
      mentionService.deleteNotificationsBySource('comment', c.id);
      db.prepare('DELETE FROM notifications WHERE source_ref LIKE ?').run(`comment_reply:${c.id}:%`);
    }
    deletionService.cleanupAfterPostDeletion(
      postId,
      post.images_json,
      childComments.map((c) => c.images_json).filter((v): v is string => Boolean(v))
    );
    this.invalidateFeedCache();
    return { success: true, deletedPostId: postId };
  },
};

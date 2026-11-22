import fs from 'node:fs';
import { db, DB_FILE, withReadConnection } from '../db/database';
import { cache } from '../utils/cache';
import { escapeCsvCell } from '../utils/security';
import { presenceService } from './presenceService';
import { getUploadsDir } from './fileService';

export type AnalyticsRange = '24h' | '7d' | '30d' | 'all';

function getWindowModifier(range: AnalyticsRange): string | null {
  switch (range) {
    case '24h':
      return '-1 day';
    case '7d':
      return '-7 days';
    case '30d':
      return '-30 days';
    case 'all':
    default:
      return null;
  }
}

function directoryBytesSafe(dirPath: string): number {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = `${dirPath}/${entry.name}`;
      if (entry.isFile()) {
        total += fs.statSync(full).size;
      } else if (entry.isDirectory()) {
        total += directoryBytesSafe(full);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export const adminAnalyticsService = {
  /**
   * Computes 100% real SQLite platform analytics filtered by date range (24h, 7d, 30d, all).
   */
  getComprehensiveAnalytics(range: AnalyticsRange = '7d') {
    const safeRange: AnalyticsRange = ['24h', '7d', '30d', 'all'].includes(range) ? range : '7d';
    const mod = getWindowModifier(safeRange);
    const cacheKey = `admin:analytics:v1:${safeRange}`;

    return cache.getOrCompute(cacheKey, 15000, () => {
      const dbStartNs = process.hrtime.bigint();
      const presenceSnapshot = presenceService.getAdminBreakdown();

      const analytics = withReadConnection((conn) => {
        const whereCreated = (col = 'created_at') => (mod ? `${col} >= datetime('now', ?)` : '1=1');
        const modArgs = mod ? [mod] : [];

        // 1. User KPIs & Registrations
        const totalUsers = Number((conn.prepare('SELECT COUNT(*) as c FROM users').get() as any)?.c || 0);
        const activeUsers = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").get() as any)?.c || 0
        );
        const suspendedUsers = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'suspended'").get() as any)?.c || 0
        );
        const restrictedUsers = Number(
          (conn.prepare('SELECT COUNT(*) as c FROM users WHERE account_restricted_until > CURRENT_TIMESTAMP').get() as any)?.c || 0
        );
        const moderatorsCount = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'moderator'").get() as any)?.c || 0
        );

        const regDaily = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now', '-1 day')").get() as any)?.c || 0
        );
        const regWeekly = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now', '-7 days')").get() as any)?.c || 0
        );
        const regMonthly = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now', '-30 days')").get() as any)?.c || 0
        );
        const regInRange = Number(
          (conn.prepare(`SELECT COUNT(*) as c FROM users WHERE ${whereCreated('created_at')}`).get(...modArgs) as any)?.c || 0
        );

        const dau = Number(
          (
            conn.prepare(`
              SELECT COUNT(DISTINCT id) as c FROM users
              WHERE COALESCE(last_active_at, created_at) >= datetime('now', '-1 day')
                 OR id IN (SELECT user_id FROM user_presence WHERE last_seen_at >= datetime('now', '-1 day'))
            `).get() as any
          )?.c || 0
        );
        const wau = Number(
          (
            conn.prepare(`
              SELECT COUNT(DISTINCT id) as c FROM users
              WHERE COALESCE(last_active_at, created_at) >= datetime('now', '-7 days')
                 OR id IN (SELECT user_id FROM user_presence WHERE last_seen_at >= datetime('now', '-7 days'))
            `).get() as any
          )?.c || 0
        );
        const mau = Number(
          (
            conn.prepare(`
              SELECT COUNT(DISTINCT id) as c FROM users
              WHERE COALESCE(last_active_at, created_at) >= datetime('now', '-30 days')
                 OR id IN (SELECT user_id FROM user_presence WHERE last_seen_at >= datetime('now', '-30 days'))
            `).get() as any
          )?.c || 0
        );

        // User Retention: accounts older than 7 days that were active in the last 7 days
        const cohort7dPlusTotal = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM users WHERE created_at <= datetime('now', '-7 days')").get() as any)?.c || 0
        );
        const cohort7dPlusRetained = Number(
          (
            conn.prepare(`
              SELECT COUNT(*) as c FROM users
              WHERE created_at <= datetime('now', '-7 days')
                AND (last_active_at >= datetime('now', '-7 days')
                     OR id IN (SELECT user_id FROM user_presence WHERE last_seen_at >= datetime('now', '-7 days')))
            `).get() as any
          )?.c || 0
        );
        const retention7dRate =
          cohort7dPlusTotal > 0 ? Number(((cohort7dPlusRetained / cohort7dPlusTotal) * 100).toFixed(1)) : 0;

        // 2. Content & Engagement Totals (Lifetime + Range Scoped)
        const totalPosts = Number((conn.prepare('SELECT COUNT(*) as c FROM posts').get() as any)?.c || 0);
        const totalComments = Number(
          (conn.prepare('SELECT COUNT(*) as c FROM comments WHERE parent_comment_id IS NULL').get() as any)?.c || 0
        );
        const totalReplies = Number(
          (conn.prepare('SELECT COUNT(*) as c FROM comments WHERE parent_comment_id IS NOT NULL').get() as any)?.c || 0
        );
        const totalMessages = Number((conn.prepare('SELECT COUNT(*) as c FROM messages').get() as any)?.c || 0);
        const totalLikes = Number((conn.prepare('SELECT COUNT(*) as c FROM likes').get() as any)?.c || 0);
        const totalReposts = Number((conn.prepare('SELECT COUNT(*) as c FROM post_reposts').get() as any)?.c || 0);
        const totalViews = Number(
          (conn.prepare('SELECT COALESCE(SUM(views_count), 0) as c FROM posts').get() as any)?.c || 0
        );
        const totalShares = Number(
          (conn.prepare('SELECT COALESCE(SUM(shares_count), 0) as c FROM posts').get() as any)?.c || 0
        );

        const postsInRange = Number(
          (conn.prepare(`SELECT COUNT(*) as c FROM posts WHERE ${whereCreated('created_at')}`).get(...modArgs) as any)?.c || 0
        );
        const commentsInRange = Number(
          (
            conn.prepare(
              `SELECT COUNT(*) as c FROM comments WHERE parent_comment_id IS NULL AND ${whereCreated('created_at')}`
            ).get(...modArgs) as any
          )?.c || 0
        );
        const repliesInRange = Number(
          (
            conn.prepare(
              `SELECT COUNT(*) as c FROM comments WHERE parent_comment_id IS NOT NULL AND ${whereCreated('created_at')}`
            ).get(...modArgs) as any
          )?.c || 0
        );
        const messagesInRange = Number(
          (conn.prepare(`SELECT COUNT(*) as c FROM messages WHERE ${whereCreated('created_at')}`).get(...modArgs) as any)?.c || 0
        );

        // 3. Time-Series for Charts (grouped by calendar day)
        const seriesWindow = safeRange === '24h' ? '-2 days' : safeRange === '7d' ? '-7 days' : safeRange === '30d' ? '-30 days' : '-90 days';
        const regSeriesRows = conn.prepare(`
          SELECT strftime('%Y-%m-%d', created_at) as day, COUNT(*) as count
          FROM users
          WHERE created_at >= datetime('now', ?)
          GROUP BY day
          ORDER BY day ASC
        `).all(seriesWindow) as Array<{ day: string; count: number }>;

        const postSeriesRows = conn.prepare(`
          SELECT strftime('%Y-%m-%d', created_at) as day, COUNT(*) as count
          FROM posts
          WHERE created_at >= datetime('now', ?)
          GROUP BY day
          ORDER BY day ASC
        `).all(seriesWindow) as Array<{ day: string; count: number }>;

        const commentSeriesRows = conn.prepare(`
          SELECT strftime('%Y-%m-%d', created_at) as day, COUNT(*) as count
          FROM comments
          WHERE created_at >= datetime('now', ?)
          GROUP BY day
          ORDER BY day ASC
        `).all(seriesWindow) as Array<{ day: string; count: number }>;

        const messageSeriesRows = conn.prepare(`
          SELECT strftime('%Y-%m-%d', created_at) as day, COUNT(*) as count
          FROM messages
          WHERE created_at >= datetime('now', ?)
          GROUP BY day
          ORDER BY day ASC
        `).all(seriesWindow) as Array<{ day: string; count: number }>;

        const dayMap = new Map<string, { day: string; registrations: number; posts: number; comments: number; messages: number }>();
        const ensureDay = (d: string) => {
          if (!dayMap.has(d)) dayMap.set(d, { day: d, registrations: 0, posts: 0, comments: 0, messages: 0 });
          return dayMap.get(d)!;
        };
        regSeriesRows.forEach((r) => {
          if (r.day) ensureDay(r.day).registrations = Number(r.count || 0);
        });
        postSeriesRows.forEach((r) => {
          if (r.day) ensureDay(r.day).posts = Number(r.count || 0);
        });
        commentSeriesRows.forEach((r) => {
          if (r.day) ensureDay(r.day).comments = Number(r.count || 0);
        });
        messageSeriesRows.forEach((r) => {
          if (r.day) ensureDay(r.day).messages = Number(r.count || 0);
        });
        const activityTimeSeries = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));

        // 4. Top Viewed & Trending Posts
        const topPosts = conn.prepare(`
          SELECT p.id, p.content, p.area_key, p.views_count, p.likes_count, p.comments_count,
                 p.reposts_count, p.shares_count, p.is_pinned, COALESCE(p.is_featured, 0) as is_featured,
                 COALESCE(p.is_admin_post, 0) as is_admin_post, p.created_at,
                 pr.name as author_name, pr.handle as author_handle
          FROM posts p
          JOIN user_profiles pr ON pr.user_id = p.author_id
          WHERE COALESCE(p.is_hidden, 0) = 0
            AND ${whereCreated('p.created_at')}
          ORDER BY (COALESCE(p.views_count, 0) + p.likes_count * 3 + p.comments_count * 4 + p.reposts_count * 4 + COALESCE(p.shares_count, 0) * 5) DESC,
                   p.created_at DESC
          LIMIT 10
        `).all(...modArgs) as any[];

        // 5. Location-based Feed Activity
        const locationActivity = conn.prepare(`
          SELECT COALESCE(NULLIF(TRIM(area_key), ''), 'unspecified') as area_key,
                 COUNT(*) as posts_count,
                 COALESCE(SUM(views_count), 0) as total_views,
                 COALESCE(SUM(likes_count + comments_count + reposts_count + COALESCE(shares_count, 0)), 0) as total_interactions
          FROM posts
          WHERE COALESCE(is_hidden, 0) = 0
            AND ${whereCreated('created_at')}
          GROUP BY area_key
          ORDER BY posts_count DESC, total_interactions DESC
        `).all(...modArgs) as any[];

        // 6. Popular Communities & Groups
        const popularCommunities = conn.prepare(`
          SELECT c.id, c.name, c.acronym, c.category, c.member_count,
                 (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id) as posts_count
          FROM communities c
          ORDER BY c.member_count DESC, posts_count DESC
          LIMIT 8
        `).all() as any[];

        const popularGroups = conn.prepare(`
          SELECT ch.id, ch.title, ch.handle,
                 (SELECT COUNT(*) FROM chat_participants cp WHERE cp.chat_id = ch.id) as members_count,
                 (SELECT COUNT(*) FROM messages m WHERE m.chat_id = ch.id) as messages_count
          FROM chats ch
          WHERE ch.type = 'group'
          ORDER BY messages_count DESC, members_count DESC
          LIMIT 8
        `).all() as any[];

        // 7. Moderation, Reports, Blocked Accounts & Appeals Statistics
        const reportsPending = Number((conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'pending'").get() as any)?.c || 0);
        const reportsReviewed = Number((conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'reviewed'").get() as any)?.c || 0);
        const reportsResolved = Number((conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'resolved'").get() as any)?.c || 0);
        const reportsDismissed = Number((conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'dismissed'").get() as any)?.c || 0);
        const reportsEscalated = Number((conn.prepare('SELECT COUNT(*) as c FROM reports WHERE COALESCE(escalated_to_admin, 0) = 1').get() as any)?.c || 0);
        const userBlocksCount = Number((conn.prepare('SELECT COUNT(*) as c FROM user_blocks').get() as any)?.c || 0);
        const blockedAccountsCount = Number(
          (
            conn.prepare(
              "SELECT COUNT(*) as c FROM users WHERE status = 'suspended' OR account_restricted_until > CURRENT_TIMESTAMP"
            ).get() as any
          )?.c || 0
        );
        const warningsTotal = Number((conn.prepare('SELECT COUNT(*) as c FROM user_warnings').get() as any)?.c || 0);
        const appealsPending = Number(
          (conn.prepare("SELECT COUNT(*) as c FROM appeals WHERE status IN ('pending', 'under_review')").get() as any)?.c || 0
        );

        // 8. Advertisement & Payment Records Statistics (100% real SQLite tables)
        const adTotals = conn.prepare(`
          SELECT COUNT(*) as total_campaigns,
                 SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_campaigns,
                 COALESCE(SUM(impressions_count), 0) as total_impressions,
                 COALESCE(SUM(clicks_count), 0) as total_clicks,
                 COALESCE(SUM(budget_kobo), 0) as total_budget_kobo
          FROM advertisements
        `).get() as any;

        const paymentStats = conn.prepare(`
          SELECT COUNT(*) as total_records,
                 SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_count,
                 SUM(CASE WHEN status IN ('pending', 'awaiting_verification') THEN 1 ELSE 0 END) as pending_count,
                 SUM(CASE WHEN status IN ('reversed', 'refunded') THEN 1 ELSE 0 END) as reversed_count,
                 COALESCE(SUM(CASE WHEN status = 'confirmed' THEN amount_kobo ELSE 0 END), 0) as confirmed_kobo,
                 COALESCE(SUM(CASE WHEN status IN ('pending', 'awaiting_verification') THEN amount_kobo ELSE 0 END), 0) as pending_kobo
          FROM payments
        `).get() as any;

        const retainedAccountingCount = Number(
          (conn.prepare('SELECT COUNT(*) as c FROM retained_accounting_records').get() as any)?.c || 0
        );

        return {
          users: {
            totalUsers,
            activeUsers,
            suspendedUsers,
            restrictedUsers,
            moderatorsCount,
            onlineNow: presenceSnapshot.totalAuthenticatedOnlineCount,
            dau,
            wau,
            mau,
            registrations: {
              daily: regDaily,
              weekly: regWeekly,
              monthly: regMonthly,
              inRange: regInRange,
            },
            retention7dRate,
            cohort7dPlusTotal,
            cohort7dPlusRetained,
          },
          engagement: {
            totalPosts,
            totalComments,
            totalReplies,
            totalMessages,
            totalLikes,
            totalReposts,
            totalViews,
            totalShares,
            inRange: {
              posts: postsInRange,
              comments: commentsInRange,
              replies: repliesInRange,
              messages: messagesInRange,
            },
          },
          activityTimeSeries,
          topPosts: topPosts.map((p) => ({
            id: p.id,
            content: String(p.content || '').slice(0, 140),
            authorName: p.author_name,
            authorHandle: p.author_handle,
            areaKey: p.area_key || 'unspecified',
            views: Number(p.views_count || 0),
            likes: Number(p.likes_count || 0),
            comments: Number(p.comments_count || 0),
            reposts: Number(p.reposts_count || 0),
            shares: Number(p.shares_count || 0),
            isPinned: Boolean(p.is_pinned),
            isFeatured: Boolean(p.is_featured),
            isAdminPost: Boolean(p.is_admin_post),
            createdAt: p.created_at,
          })),
          locationActivity: locationActivity.map((l) => ({
            areaKey: l.area_key,
            postsCount: Number(l.posts_count || 0),
            totalViews: Number(l.total_views || 0),
            totalInteractions: Number(l.total_interactions || 0),
          })),
          popularCommunities: popularCommunities.map((c) => ({
            id: c.id,
            name: c.name,
            acronym: c.acronym,
            category: c.category,
            memberCount: Number(c.member_count || 0),
            postsCount: Number(c.posts_count || 0),
          })),
          popularGroups: popularGroups.map((g) => ({
            id: g.id,
            title: g.title,
            handle: g.handle,
            membersCount: Number(g.members_count || 0),
            messagesCount: Number(g.messages_count || 0),
          })),
          moderation: {
            reportsTotal: reportsPending + reportsReviewed + reportsResolved + reportsDismissed,
            reportsPending,
            reportsReviewed,
            reportsResolved,
            reportsDismissed,
            reportsEscalated,
            userBlocksCount,
            blockedAccountsCount,
            warningsTotal,
            appealsPending,
          },
          advertisements: {
            totalCampaigns: Number(adTotals?.total_campaigns || 0),
            activeCampaigns: Number(adTotals?.active_campaigns || 0),
            totalImpressions: Number(adTotals?.total_impressions || 0),
            totalClicks: Number(adTotals?.total_clicks || 0),
            ctrPercent:
              Number(adTotals?.total_impressions || 0) > 0
                ? Number(((Number(adTotals?.total_clicks || 0) / Number(adTotals.total_impressions)) * 100).toFixed(2))
                : 0,
            totalBudgetNaira: Number(adTotals?.total_budget_kobo || 0) / 100,
          },
          payments: {
            totalRecords: Number(paymentStats?.total_records || 0),
            confirmedCount: Number(paymentStats?.confirmed_count || 0),
            pendingCount: Number(paymentStats?.pending_count || 0),
            reversedCount: Number(paymentStats?.reversed_count || 0),
            confirmedVolumeNaira: Number(paymentStats?.confirmed_kobo || 0) / 100,
            pendingVolumeNaira: Number(paymentStats?.pending_kobo || 0) / 100,
            retainedAccountingCount,
          },
        };
      });

      const dbLatencyMs = Number((Number(process.hrtime.bigint() - dbStartNs) / 1e6).toFixed(2));
      let dbBytes = 0;
      try {
        if (fs.existsSync(DB_FILE)) dbBytes += fs.statSync(DB_FILE).size;
        if (fs.existsSync(`${DB_FILE}-wal`)) dbBytes += fs.statSync(`${DB_FILE}-wal`).size;
      } catch {
        // ignore
      }
      const mediaBytes = directoryBytesSafe(getUploadsDir());
      const mem = process.memoryUsage();
      const cacheStats = cache.getStats();

      return {
        range: safeRange,
        generatedAt: new Date().toISOString(),
        ...analytics,
        system: {
          databaseBytes: dbBytes,
          mediaBytes,
          dbLatencyMs,
          memoryRssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
          heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
          cacheHitRatePercent: cacheStats.hitRatePercent,
          cacheEntries: cacheStats.entries,
          uptimeSeconds: Math.round(process.uptime()),
        },
      };
    });
  },

  /**
   * Builds a safe formula-injection-neutralized CSV report of analytics for download
   */
  exportAnalyticsCsv(range: AnalyticsRange = '7d'): string {
    const data = this.getComprehensiveAnalytics(range);
    const lines: string[] = [];

    lines.push(['Section', 'Metric', 'Value', 'Notes'].map(escapeCsvCell).join(','));
    lines.push(['Overview', 'Range', data.range, `Generated ${data.generatedAt}`].map(escapeCsvCell).join(','));
    lines.push(['Users', 'Total Registered Users', data.users.totalUsers, 'All accounts'].map(escapeCsvCell).join(','));
    lines.push(['Users', 'Active Users', data.users.activeUsers, 'Non-suspended'].map(escapeCsvCell).join(','));
    lines.push(['Users', 'Online Now', data.users.onlineNow, 'Active SSE/presence'].map(escapeCsvCell).join(','));
    lines.push(['Users', 'Daily Registrations (24h)', data.users.registrations.daily, 'New accounts'].map(escapeCsvCell).join(','));
    lines.push(['Users', 'Weekly Registrations (7d)', data.users.registrations.weekly, 'New accounts'].map(escapeCsvCell).join(','));
    lines.push(['Users', 'Monthly Registrations (30d)', data.users.registrations.monthly, 'New accounts'].map(escapeCsvCell).join(','));
    lines.push(['Users', 'DAU / WAU / MAU', `${data.users.dau} / ${data.users.wau} / ${data.users.mau}`, 'Active cohorts'].map(escapeCsvCell).join(','));
    lines.push(['Users', '7-Day Retention Rate (%)', `${data.users.retention7dRate}%`, `${data.users.cohort7dPlusRetained}/${data.users.cohort7dPlusTotal} returning`].map(escapeCsvCell).join(','));
    lines.push(['Engagement', 'Total Posts', data.engagement.totalPosts, `${data.engagement.inRange.posts} in range`].map(escapeCsvCell).join(','));
    lines.push(['Engagement', 'Total Comments', data.engagement.totalComments, `${data.engagement.inRange.comments} in range`].map(escapeCsvCell).join(','));
    lines.push(['Engagement', 'Total Replies', data.engagement.totalReplies, `${data.engagement.inRange.replies} in range`].map(escapeCsvCell).join(','));
    lines.push(['Engagement', 'Total Messages', data.engagement.totalMessages, `${data.engagement.inRange.messages} in range`].map(escapeCsvCell).join(','));
    lines.push(['Engagement', 'Total Post Views', data.engagement.totalViews, 'Cumulative'].map(escapeCsvCell).join(','));
    lines.push(['Moderation', 'Total Reports', data.moderation.reportsTotal, `${data.moderation.reportsPending} pending`].map(escapeCsvCell).join(','));
    lines.push(['Moderation', 'Escalated Reports', data.moderation.reportsEscalated, 'Awaiting/Handled by Admin'].map(escapeCsvCell).join(','));
    lines.push(['Moderation', 'Blocked/Suspended/Restricted Accounts', data.moderation.blockedAccountsCount, `${data.moderation.userBlocksCount} peer blocks`].map(escapeCsvCell).join(','));
    lines.push(['Advertisements', 'Active Campaigns', `${data.advertisements.activeCampaigns}/${data.advertisements.totalCampaigns}`, `CTR ${data.advertisements.ctrPercent}%`].map(escapeCsvCell).join(','));
    lines.push(['Payments', 'Total Records', data.payments.totalRecords, `Confirmed NGN ${data.payments.confirmedVolumeNaira}`].map(escapeCsvCell).join(','));
    lines.push(['System', 'Database Bytes', data.system.databaseBytes, `Latency ${data.system.dbLatencyMs}ms`].map(escapeCsvCell).join(','));
    lines.push(['System', 'Media Storage Bytes', data.system.mediaBytes, `RSS ${data.system.memoryRssMb}MB`].map(escapeCsvCell).join(','));

    lines.push('');
    lines.push(['Day', 'Registrations', 'Posts', 'Comments', 'Messages'].map(escapeCsvCell).join(','));
    for (const row of data.activityTimeSeries) {
      lines.push([row.day, row.registrations, row.posts, row.comments, row.messages].map(escapeCsvCell).join(','));
    }

    lines.push('');
    lines.push(['Location Area', 'Posts', 'Views', 'Interactions'].map(escapeCsvCell).join(','));
    for (const loc of data.locationActivity) {
      lines.push([loc.areaKey, loc.postsCount, loc.totalViews, loc.totalInteractions].map(escapeCsvCell).join(','));
    }

    return lines.join('\r\n');
  },
};

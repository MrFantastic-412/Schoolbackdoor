export type NavigationTab = 'home' | 'updates' | 'chats' | 'communities' | 'profile' | 'settings' | 'admin' | 'mod' | 'policies';

export type FeedFilter =
  | 'all'
  | 'general'
  | 'entertainment'
  | 'discussions'
  | 'soc'
  | 'seet'
  | 'hostel';

export type FeedCategory = 'for_you' | 'nearby' | 'latest' | 'trending';

export type CampusAreaKey =
  | 'obanla'
  | 'south_gate'
  | 'stateline'
  | 'north_gate'
  | 'ipinsa'
  | 'road_block'
  | 'obakekere';

export type LocationFilterKey =
  | 'all'
  | 'my_area'
  | 'on_campus'
  | 'off_campus'
  | CampusAreaKey;

export interface ResolvedMention {
  userId: string;
  handle: string;
  name: string;
}

export interface MentionCandidate {
  userId: string;
  name: string;
  handle: string;
  department: string;
  level: string;
  avatarInitials: string;
  avatarBg: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  verified: boolean;
  isConnected?: boolean;
}

export interface PostComment {
  id: string;
  parentCommentId?: string;
  authorId?: string;
  authorName: string;
  authorHandle: string;
  department: string;
  level: string;
  avatarInitials?: string;
  avatarBg?: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  verified?: boolean;
  content: string;
  images?: string[];
  mentions?: ResolvedMention[];
  isEdited?: boolean;
  timestamp: string;
}

export interface CampusLocation {
  id: string;
  name: string;
  category: 'academic' | 'hostel' | 'gate' | 'landmark' | 'sports' | 'off_campus' | 'custom';
  coordinates: [number, number]; // [lat, lng]
  description?: string;
  address?: string;
  isOffCampus?: boolean;
}

export interface RouteInfo {
  distanceMeters: number;
  durationSeconds: number;
  coordinates: [number, number][]; // [lat, lng]
  summary?: string;
  profile: 'foot' | 'driving';
}

export interface PollOption {
  id: string;
  label: string;
  votes: number;
}

export interface PostPoll {
  question?: string;
  options: PollOption[];
  allowMultiple?: boolean;
  totalVotes: number;
  userVotedOptionIds: string[];
}

export interface Post {
  id: string;
  authorId?: string;
  authorName: string;
  authorHandle: string;
  department: string;
  level: string;
  avatarBg: string;
  avatarInitials: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  verified: boolean;
  content: string;
  mentions?: ResolvedMention[];
  isEdited?: boolean;
  timestamp: string;
  likes: number;
  commentsCount: number;
  reposts: number;
  viewsCount?: number;
  sharesCount?: number;
  areaKey?: CampusAreaKey | string;
  areaLabel?: string;
  isTrending?: boolean;
  isNearby?: boolean;
  rankingReason?: string;
  isLiked?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
  isAnonymous?: boolean;
  operatorNote?: string;
  schoolTag?: string;
  hostelTag?: string;
  communityId?: string;
  isAnnouncement?: boolean;
  announcementUrgency?: 'normal' | 'high';
  isPinned?: boolean;
  isFeatured?: boolean;
  isAdminPost?: boolean;
  distributionScope?: 'feed' | 'nearby' | 'all' | string;
  location?: CampusLocation;
  images?: string[];
  poll?: PostPoll;
  comments: PostComment[];
}

export interface PaginatedPostsResponse {
  posts: Post[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  activeCategory?: FeedCategory;
  activeLocation?: LocationFilterKey;
  locationSharingEnabled?: boolean;
  preferredLocationArea?: string | null;
  rankingStrategy?: string;
}

export interface PresenceSummary {
  onlineCount: number;
  message: string;
  updatedAt: string;
}

export interface Notice {
  id: string;
  title: string;
  source: string;
  category: 'academic' | 'hostel' | 'administrative' | 'lifestyle' | 'emergency';
  date: string;
  summary: string;
  fullBody: string;
  verified: boolean;
  urgency: 'normal' | 'high';
  readTime: string;
}

export interface CommunitySettings {
  isPrivate?: boolean;
  allowMemberDiscussions?: boolean;
  requireApproval?: boolean;
}

export interface Community {
  id: string;
  name: string;
  acronym: string;
  category: 'school' | 'hostel' | 'tech' | 'social' | 'academic';
  memberCount: number;
  description: string;
  location: string;
  isJoined: boolean;
  leaders?: string;
  creatorId?: string;
  chatId?: string;
  rules?: string;
  settings?: CommunitySettings;
  userRole?: 'lead' | 'moderator' | 'member' | null;
}

export interface CommunityMember {
  membershipId: string;
  userId: string;
  name: string;
  handle: string;
  department: string;
  level: string;
  avatarInitials: string;
  avatarBg: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  verified: boolean;
  communityRole: 'lead' | 'moderator' | 'member';
  systemRole?: string;
  joinedAt: string;
}

export interface CampusLandmark {
  id: string;
  name: string;
  category: 'academic' | 'hostel' | 'gate' | 'landmark' | 'sports' | 'off_campus';
  campusZone: string;
  coordinates: [number, number];
  description?: string;
  isOffCampus: boolean;
  pinnedCount: number;
  createdAt?: string;
}

export interface Message {
  id: string;
  clientId?: string;
  senderId?: string;
  senderName: string;
  senderAvatarInitials?: string;
  senderAvatarBg?: string;
  senderAvatarUrl?: string;
  senderAvatarThumbUrl?: string;
  text: string;
  mentions?: ResolvedMention[];
  isEdited?: boolean;
  timestamp: string;
  isMe: boolean;
  status?: 'sending' | 'sent' | 'read' | 'failed';
  readAt?: string;
  location?: CampusLocation;
  images?: string[];
}

export interface Conversation {
  id: string;
  type?: 'direct' | 'group';
  title: string;
  handle: string;
  subtitle: string;
  avatarInitials: string;
  avatarBg: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  lastMessage: string;
  timestamp: string;
  unreadCount: number;
  isOnline: boolean;
  messages: Message[];
}

export interface AppNotification {
  id: string;
  userId: string;
  type: 'like' | 'comment' | 'reply' | 'mention' | 'group' | 'announcement' | 'account' | 'message' | 'system';
  title: string;
  body: string;
  link?: string;
  isRead: boolean;
  timestamp: string;
}

export interface EligibleChatPartner {
  userId: string;
  name: string;
  handle: string;
  department: string;
  level: string;
  avatarInitials: string;
  avatarBg: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  verified: boolean;
}

export interface StudentProfile {
  id?: string;
  userId?: string;
  name: string;
  handle: string;
  matricNumber: string;
  school: string;
  department: string;
  level: string;
  hallOfResidence: string;
  campus: string;
  bio: string;
  joinedDate?: string;
  accountCreatedAt?: string;
  postsCount?: number;
  dispatchesCount?: number;
  commentsCount?: number;
  guildsCount?: number;
  followersCount?: number;
  followingCount?: number;
  isConnected?: boolean;
  isBlocked?: boolean;
  isBlockedEitherWay?: boolean;
  badges: string[];
  verified?: boolean;
  avatarInitials?: string;
  avatarBg?: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  isPrivate?: boolean;
  allowAnonymousPosts?: boolean;
  showOnlineStatus?: boolean;
  notifyMentions?: boolean;
  notifyReplies?: boolean;
  notifyMessages?: boolean;
  notifyCommunityAlerts?: boolean;
  notifyHostelAlerts?: boolean;
  locationSharingEnabled?: boolean;
  preferredLocationArea?: string | null;
  email?: string;
  role?: 'admin' | 'moderator' | 'staff' | 'student' | string;
  acceptedTermsVersion?: string | null;
  restrictedUntil?: string | null;
  restrictionReason?: string | null;
  warningsCount?: number;
}

export interface UserSearchResult {
  userId: string;
  name: string;
  handle: string;
  department: string;
  level: string;
  bio?: string;
  avatarInitials: string;
  avatarBg: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  verified: boolean;
  isPrivate?: boolean;
  followersCount?: number;
  isConnected?: boolean;
}

export interface BlockedUser {
  blockId: string;
  userId: string;
  name: string;
  handle: string;
  department: string;
  avatarInitials: string;
  avatarBg: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  blockedAt: string;
}

export interface AuthUser {
  id: string;
  matric_number: string;
  email?: string | null;
  phone_number?: string;
  username: string;
  role: string;
  status: string;
  is_verified: boolean;
  recoveryCodesRemaining?: number;
  restricted_until?: string | null;
  restriction_reason?: string | null;
}

export interface RecoveryCodeStatus {
  remainingCount: number;
  totalCount: number;
  generatedAt: string | null;
}

export interface PasskeySummary {
  id: string;
  label: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface BackgroundJobRecord {
  id: string;
  jobName: string;
  status: 'running' | 'completed' | 'failed';
  recordsAffected: number;
  durationMs: number;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AdminDashboardStats {
  users: {
    total: number;
    activeStudents: number;
    suspended: number;
    staff: number;
    onlineVisible?: number;
    onlineTotal?: number;
    activeClientSessions?: number;
    dau?: number;
    wau?: number;
    mau?: number;
    newRegistrations24h?: number;
    newRegistrations7d?: number;
    newRegistrations30d?: number;
  };
  content: {
    posts: number;
    comments: number;
    communities: number;
    groups: number;
    messages: number;
    posts24h?: number;
    comments24h?: number;
    messages24h?: number;
  };
  moderation: {
    reportsTotal: number;
    reportsPending: number;
    reportsUnderReview: number;
    reportsResolved: number;
    reportsDismissed: number;
    warningsIssued: number;
    appealsTotal: number;
    appealsPending: number;
  };
  storage: {
    databaseBytes: number;
    databaseFormatted: string;
    walBytes?: number;
    walFormatted?: string;
    backupsBytes?: number;
    backupsFormatted?: string;
    estimatedMediaBytes: number;
    estimatedMediaFormatted: string;
    totalBytes: number;
    totalFormatted: string;
  };
  deletionJobs: {
    accountDeletionsProcessed: number;
    pendingExpiredMessages?: number;
    pendingExpiredPosts?: number;
    pendingUserDeletions?: number;
    totalPendingDeletions?: number;
    lastPurgeAt: string;
    retentionPolicy: string;
  };
  jobs?: {
    failedJobsCount: number;
    failedJobs24h: number;
    recentJobs: BackgroundJobRecord[];
  };
  system: {
    status: string;
    nodeVersion: string;
    uptimeSeconds: number;
    databaseEngine: string;
    dbLatencyMs?: number;
    memoryRssMb?: number;
    heapUsedMb?: number;
    activeSseConnections?: number;
    activeSseUniqueUsers?: number;
    cacheHitRatePercent?: number;
    cacheEntries?: number;
  };
}

export interface AdminReport {
  id: string;
  reporter_id: string;
  reporter_name?: string;
  reporter_handle?: string;
  target_type: 'post' | 'comment' | 'user' | 'chat';
  target_id: string;
  reason: string;
  details?: string;
  status: 'pending' | 'reviewed' | 'resolved' | 'dismissed';
  resolution_notes?: string;
  action_taken?: string;
  reviewed_by?: string;
  reviewed_by_handle?: string;
  assigned_to?: string;
  escalated_to_admin?: boolean;
  escalation_reason?: string;
  escalated_by?: string;
  escalated_by_handle?: string;
  escalated_at?: string;
  priority?: string;
  created_at: string;
  updated_at: string;
}

export interface StaffMember {
  id: string;
  name: string;
  handle: string;
  email?: string | null;
  matricNumber: string;
  department: string;
  role: 'admin' | 'moderator' | 'staff' | 'student';
  status: string;
  permissions: string[];
  createdAt: string;
}

export interface AppealRecord {
  id: string;
  userId: string;
  studentName: string;
  studentHandle: string;
  studentEmail?: string;
  type: 'suspension' | 'warning' | 'content_removal';
  targetId?: string;
  statement: string;
  status: 'pending' | 'under_review' | 'accepted' | 'rejected';
  reviewNotes?: string;
  reviewedBy?: string;
  createdAt: string;
}

export interface BackupSnapshot {
  id: string;
  filename: string;
  sizeBytes: number;
  sizeFormatted: string;
  checksum: string;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  metadata?: any;
}

export interface AdminAuditLog {
  id: string;
  adminId: string;
  adminName: string;
  adminHandle: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: any;
  createdAt: string;
}

export interface PlatformFeature {
  key: string;
  name: string;
  description: string;
  category: 'core' | 'social' | 'discovery' | 'governance';
  enabled: boolean;
  visibleInNav: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  limits: Record<string, any>;
  settings: Record<string, any>;
  navTab: string | null;
  isBuiltin: boolean;
  updatedAt?: string;
}

export interface PlatformConfig {
  settings: Record<string, string>;
  features: PlatformFeature[];
}

export interface AdminUserRecord {
  id: string;
  matricNumber: string;
  email?: string | null;
  phoneNumber: string;
  role: 'admin' | 'moderator' | 'staff' | 'student';
  status: 'active' | 'suspended';
  isVerified: boolean;
  mfaEnabled: boolean;
  name: string;
  handle: string;
  department: string;
  school: string;
  level: string;
  hallOfResidence: string;
  campus: string;
  bio: string;
  postsCount: number;
  createdAt: string;
  lastActiveAt: string;
  suspensionReason?: string;
  restrictedUntil?: string | null;
  restrictionReason?: string | null;
  warningsCount?: number;
}

export interface AdminContentPost {
  id: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  content: string;
  schoolTag?: string;
  hostelTag?: string;
  areaKey?: string;
  likesCount: number;
  commentsCount: number;
  viewsCount?: number;
  repostsCount?: number;
  isPinned: boolean;
  isFeatured?: boolean;
  isAdminPost?: boolean;
  distributionScope?: 'feed' | 'nearby' | 'all' | string;
  isAnnouncement: boolean;
  isAnonymous: boolean;
  isHidden: boolean;
  createdAt: string;
}

export interface AdminContentComment {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  content: string;
  createdAt: string;
}

export interface AdminChatOverview {
  id: string;
  type: 'direct' | 'group';
  title: string;
  handle: string;
  participantCount: number;
  activeMessagesCount: number;
  pendingReportsCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface AdminNotificationRecord {
  id: string;
  userId: string;
  recipientName: string;
  recipientHandle: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

export interface AdminCommunityRecord {
  id: string;
  name: string;
  acronym: string;
  category: string;
  description: string;
  location: string;
  leaders: string;
  isVerified: boolean;
  memberCount: number;
  postsCount: number;
  chatId: string | null;
  createdAt: string;
}

export interface AdminStorageOverview {
  quotaBytes: number;
  quotaGb: number;
  totalUsedBytes: number;
  availableBytes: number;
  usagePercent: number;
  alertLevel?: 'ok' | 'warning_70' | 'critical_85' | 'protection_95';
  storageProtectionMode?: boolean;
  protectionActions?: string[];
  breakdown: {
    databaseBytes: number;
    walBytes: number;
    backupsBytes: number;
    uploadsDiskBytes: number;
    mediaBytes: number;
    imagesBytes?: number;
    thumbnailsBytes?: number;
    videoBytes?: number;
    tempBytes?: number;
    cacheBytes?: number;
    logsBytes?: number;
    otherGeneratedBytes?: number;
  };
  growth?: {
    dailyBytes: number;
    weeklyBytes: number;
    monthlyBytes: number;
    sampleCount: number;
  };
  largestFiles?: Array<{
    name: string;
    category: string;
    bytes: number;
  }>;
  orphans: {
    count: number;
    totalBytes: number;
    filenames: string[];
  };
  expiredContent: {
    pendingExpiredMessages: number;
    pendingExpiredPosts: number;
    pendingUserDeletions: number;
  };
  failedJobs: Array<{
    id: string;
    jobName: string;
    durationMs: number;
    errorMessage?: string;
    startedAt: string;
  }>;
  infrastructureNote?: string;
}

export interface DeviceSession {
  id: string;
  userId?: string;
  handle?: string;
  name?: string;
  role?: string;
  deviceName: string;
  deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown' | string;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  refreshExpiresAt?: string | null;
  maxExpiresAt?: string | null;
  isCurrent: boolean;
  isSuspicious: boolean;
}

export interface SecurityEventRecord {
  id: string;
  eventType: string;
  severity: 'info' | 'warning' | 'critical' | string;
  userId?: string | null;
  handle?: string | null;
  identifier?: string | null;
  ipAddress?: string | null;
  deviceName?: string | null;
  details: Record<string, any>;
  createdAt: string;
}

export interface AdminSecurityOverview {
  mfaEnabled: boolean;
  failedLoginAttempts24h: number;
  activeSessionsCount: number;
  usersWithMultipleDevices?: number;
  suspiciousEvents24h?: number;
  authErrors24h?: number;
  sessionTtlDays: number;
  accessTtlMinutes?: number;
  sessionMaxLifetimeDays?: number;
  maxActiveDevices?: number;
  rateLimitRule: string;
  passwordHashing: string;
  recentFailedLogins: Array<{
    identifier: string;
    ipAddress: string;
    attemptedAt: string;
  }>;
  activeSessions?: DeviceSession[];
  securityEvents?: SecurityEventRecord[];
}

export type AnalyticsRange = '24h' | '7d' | '30d' | 'all';

export interface ModeratorPermissions {
  userId: string;
  assignedBy: string;
  canReviewReports: boolean;
  canHideContent: boolean;
  canWarnUsers: boolean;
  canRestrictUsers: boolean;
  maxRestrictionHours: number;
  canReviewCommunities: boolean;
  canEscalate: boolean;
  assignedAreas: string[];
  notes: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModeratorAccount {
  id: string;
  name: string;
  handle: string;
  email?: string | null;
  matricNumber: string;
  department: string;
  campus: string;
  status: string;
  lastActiveAt: string;
  createdAt: string;
  actionsCount: number;
  handledReportsCount: number;
  permissions: ModeratorPermissions;
}

export interface ModeratorReportItem extends AdminReport {
  targetPreview?: {
    exists: boolean;
    targetUserId?: string;
    authorName?: string;
    authorHandle?: string;
    authorRole?: string;
    snippet?: string;
    isHidden?: boolean;
    communityId?: string;
    restrictedUntil?: string;
    warningsCount?: number;
  } | null;
}

export interface ModeratorDashboardData {
  permissions: ModeratorPermissions;
  stats: {
    pendingReports: number;
    escalatedReports: number;
    myHandledReports: number;
    hiddenPostsCount: number;
    activeRestrictedUsers: number;
    myActionsCount: number;
  };
}

export interface ModeratorCommunityReviewData {
  flaggedPosts: Array<{
    postId: string;
    communityId: string;
    communityName: string;
    communityAcronym: string;
    authorHandle: string;
    content: string;
    isHidden: boolean;
    reportsCount: number;
    createdAt: string;
  }>;
  communities: Array<{
    id: string;
    name: string;
    acronym: string;
    category: string;
    memberCount: number;
    location: string;
    activePostsCount: number;
    pendingReportsCount: number;
  }>;
}

export interface ModerationHistoryEntry {
  id: string;
  actorId: string;
  actorName: string;
  actorHandle: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: any;
  createdAt: string;
}

export interface AdminAnalyticsReport {
  range: AnalyticsRange;
  generatedAt: string;
  users: {
    totalUsers: number;
    activeUsers: number;
    suspendedUsers: number;
    restrictedUsers: number;
    moderatorsCount: number;
    onlineNow: number;
    dau: number;
    wau: number;
    mau: number;
    registrations: {
      daily: number;
      weekly: number;
      monthly: number;
      inRange: number;
    };
    retention7dRate: number;
    cohort7dPlusTotal: number;
    cohort7dPlusRetained: number;
  };
  engagement: {
    totalPosts: number;
    totalComments: number;
    totalReplies: number;
    totalMessages: number;
    totalLikes: number;
    totalReposts: number;
    totalViews: number;
    totalShares: number;
    inRange: {
      posts: number;
      comments: number;
      replies: number;
      messages: number;
    };
  };
  activityTimeSeries: Array<{
    day: string;
    registrations: number;
    posts: number;
    comments: number;
    messages: number;
  }>;
  topPosts: Array<{
    id: string;
    content: string;
    authorName: string;
    authorHandle: string;
    areaKey: string;
    views: number;
    likes: number;
    comments: number;
    reposts: number;
    shares: number;
    isPinned: boolean;
    isFeatured: boolean;
    isAdminPost: boolean;
    createdAt: string;
  }>;
  locationActivity: Array<{
    areaKey: string;
    postsCount: number;
    totalViews: number;
    totalInteractions: number;
  }>;
  popularCommunities: Array<{
    id: string;
    name: string;
    acronym: string;
    category: string;
    memberCount: number;
    postsCount: number;
  }>;
  popularGroups: Array<{
    id: string;
    title: string;
    handle: string;
    membersCount: number;
    messagesCount: number;
  }>;
  moderation: {
    reportsTotal: number;
    reportsPending: number;
    reportsReviewed: number;
    reportsResolved: number;
    reportsDismissed: number;
    reportsEscalated: number;
    userBlocksCount: number;
    blockedAccountsCount: number;
    warningsTotal: number;
    appealsPending: number;
  };
  advertisements: {
    totalCampaigns: number;
    activeCampaigns: number;
    totalImpressions: number;
    totalClicks: number;
    ctrPercent: number;
    totalBudgetNaira: number;
  };
  payments: {
    totalRecords: number;
    confirmedCount: number;
    pendingCount: number;
    reversedCount: number;
    confirmedVolumeNaira: number;
    pendingVolumeNaira: number;
    retainedAccountingCount: number;
  };
  system: {
    databaseBytes: number;
    mediaBytes: number;
    dbLatencyMs: number;
    memoryRssMb: number;
    heapUsedMb: number;
    cacheHitRatePercent: number;
    cacheEntries: number;
    uptimeSeconds: number;
  };
}

export interface AdvertisementRecord {
  id: string;
  title: string;
  sponsorName: string;
  body: string;
  targetUrl?: string;
  imageUrl?: string;
  placement: 'feed' | 'communities' | 'updates' | 'sidebar';
  targetArea: string;
  status: 'draft' | 'active' | 'paused' | 'ended';
  budgetNaira: number;
  impressionsCount: number;
  clicksCount: number;
  ctrPercent: number;
  startsAt?: string;
  endsAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRecordItem {
  id: string;
  userId: string;
  userName: string;
  userHandle: string;
  reference: string;
  amountNaira: number;
  currency: string;
  purpose: string;
  status: 'pending' | 'awaiting_verification' | 'confirmed' | 'failed' | 'reversed' | 'refunded';
  channel: string;
  payerBankName?: string;
  payerAccountName?: string;
  proofNote?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  paidAt?: string;
  createdAt: string;
}

export interface RetainedPaymentArchiveItem {
  id: string;
  paymentId: string;
  reference: string;
  amountNaira: number;
  currency: string;
  channel: string;
  purpose: string;
  status: string;
  paidAt?: string;
  retentionUntil: string;
  retainedAt: string;
}

export interface PaymentRecordsResponse {
  records: PaymentRecordItem[];
  retainedArchives: RetainedPaymentArchiveItem[];
  summary: {
    totalRecords: number;
    confirmedNaira: number;
    pendingNaira: number;
    retainedCount: number;
  };
}

export type UpdatesView = 'notifications' | 'bulletins' | 'landmarks' | 'saved';

export type SavedLocationSource = 'search' | 'map' | 'landmark' | 'post' | 'chat' | 'manual';

export interface SavedLocation {
  id: string;
  userId: string;
  landmarkId?: string;
  name: string;
  customLabel?: string;
  displayName: string;
  category: CampusLocation['category'];
  areaKey?: CampusAreaKey;
  areaLabel?: string;
  campusZone?: string;
  description?: string;
  address?: string;
  notes?: string;
  coordinates: [number, number];
  isOffCampus: boolean;
  isPinned: boolean;
  source: SavedLocationSource;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
  pendingSync?: boolean;
}

export interface LocationSearchHistoryItem {
  id: string;
  userId: string;
  queryText: string;
  selectedName?: string;
  selectedDescription?: string;
  selectedAddress?: string;
  selectedCategory?: string;
  areaKey?: CampusAreaKey;
  areaLabel?: string;
  coordinates?: [number, number];
  isOffCampus: boolean;
  landmarkId?: string;
  searchCount: number;
  searchedAt: string;
  pendingSync?: boolean;
}

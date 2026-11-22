-- ============================================================
-- SCHOOLBACKDOOR DATABASE SCHEMA
-- Relational SQLite schema with Foreign Keys and Indexes
-- ============================================================

PRAGMA foreign_keys = ON;

-- 1. Users table (Core Identity & Credentials)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  matric_number TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student', 'staff', 'admin', 'moderator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'pending_verification')),
  account_restricted_until DATETIME,
  restriction_reason TEXT,
  restricted_by TEXT,
  warnings_count INTEGER NOT NULL DEFAULT 0,
  accepted_terms_at DATETIME,
  accepted_terms_version TEXT,
  last_reauthenticated_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_matric ON users(matric_number);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 2. User Profiles table
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  department TEXT NOT NULL,
  school TEXT NOT NULL,
  level TEXT NOT NULL,
  hall_of_residence TEXT NOT NULL,
  campus TEXT NOT NULL DEFAULT 'Obanla',
  bio TEXT,
  avatar_initials TEXT NOT NULL,
  avatar_bg TEXT NOT NULL,
  avatar_url TEXT,
  avatar_thumb_url TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  allow_anonymous_posts INTEGER NOT NULL DEFAULT 1,
  show_online_status INTEGER NOT NULL DEFAULT 1,
  notify_mentions INTEGER NOT NULL DEFAULT 1,
  notify_replies INTEGER NOT NULL DEFAULT 1,
  notify_messages INTEGER NOT NULL DEFAULT 1,
  notify_community_alerts INTEGER NOT NULL DEFAULT 1,
  notify_hostel_alerts INTEGER NOT NULL DEFAULT 1,
  location_sharing_enabled INTEGER NOT NULL DEFAULT 0,
  preferred_location_area TEXT,
  badges_json TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profiles_handle ON user_profiles(handle);
CREATE INDEX IF NOT EXISTS idx_profiles_dept ON user_profiles(department);

-- 3. Communities & Groups
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  acronym TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('school', 'hostel', 'tech', 'academic', 'social')),
  member_count INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  location TEXT NOT NULL,
  leaders TEXT,
  creator_id TEXT,
  chat_id TEXT,
  settings_json TEXT,
  rules TEXT,
  is_verified INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_communities_cat ON communities(category);

-- 4. Community Memberships
CREATE TABLE IF NOT EXISTS community_memberships (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member', 'moderator', 'lead')),
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(community_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_comm_members_user ON community_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_comm_members_comm ON community_memberships(community_id);

-- 5. Posts (Dispatches & Community Discussions/Announcements)
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  school_tag TEXT,
  hostel_tag TEXT,
  community_id TEXT,
  is_announcement INTEGER NOT NULL DEFAULT 0,
  announcement_urgency TEXT DEFAULT 'normal' CHECK(announcement_urgency IN ('normal', 'high')),
  location_json TEXT, -- CampusLocation JSON
  images_json TEXT,   -- Array of image URLs / base64 JSON
  poll_json TEXT,     -- Multi-choice survey definition JSON
  likes_count INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  reposts_count INTEGER NOT NULL DEFAULT 0,
  views_count INTEGER NOT NULL DEFAULT 0,
  shares_count INTEGER NOT NULL DEFAULT 0,
  area_key TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_admin_post INTEGER NOT NULL DEFAULT 0,
  distribution_scope TEXT NOT NULL DEFAULT 'standard' CHECK(distribution_scope IN ('standard', 'featured', 'global')),
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id);
CREATE INDEX IF NOT EXISTS idx_posts_announcement ON posts(is_announcement);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- 6. Comments
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  images_json TEXT,
  parent_comment_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id);

-- 7. Likes
CREATE TABLE IF NOT EXISTS likes (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);

-- 7b. Post Reposts
CREATE TABLE IF NOT EXISTS post_reposts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reposts_post ON post_reposts(post_id);
CREATE INDEX IF NOT EXISTS idx_reposts_user ON post_reposts(user_id);

-- 7b-i. Unique Post Views (Anti-bot / Deduplicated by viewer_key)
CREATE TABLE IF NOT EXISTS post_views (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  user_id TEXT,
  is_authenticated INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'feed',
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  UNIQUE(post_id, viewer_key)
);

CREATE INDEX IF NOT EXISTS idx_post_views_post_created ON post_views(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_views_viewer ON post_views(viewer_key, created_at DESC);

-- 7b-ib. Unique Post Shares (Deduplicated by sharer_key)
CREATE TABLE IF NOT EXISTS post_shares (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  sharer_key TEXT NOT NULL,
  user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  UNIQUE(post_id, sharer_key)
);

CREATE INDEX IF NOT EXISTS idx_post_shares_post_created ON post_shares(post_id, created_at DESC);

-- 7b-ii. Post Poll Votes
CREATE TABLE IF NOT EXISTS poll_votes (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(post_id, user_id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON poll_votes(post_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes(user_id, post_id);

-- 7c. User Connections (Friends / Followers)
CREATE TABLE IF NOT EXISTS user_connections (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL,
  following_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_connections_follower ON user_connections(follower_id);
CREATE INDEX IF NOT EXISTS idx_connections_following ON user_connections(following_id);

-- 8. Chats (Direct & Group Messenger Threads)
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'group' CHECK(type IN ('direct', 'group')),
  title TEXT NOT NULL,
  handle TEXT NOT NULL,
  subtitle TEXT,
  avatar_initials TEXT NOT NULL,
  avatar_bg TEXT NOT NULL,
  last_message TEXT,
  last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9. Chat Participants
CREATE TABLE IF NOT EXISTS chat_participants (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member', 'admin')),
  last_read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_part_user ON chat_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_part_chat ON chat_participants(chat_id);

-- 10. Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT,
  location_json TEXT,
  images_json TEXT,
  client_id TEXT,
  edited_at DATETIME,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC);

-- 11. Announcements (Official Campus Bulletins & Senate Notices)
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('academic', 'hostel', 'administrative', 'sports')),
  date_str TEXT NOT NULL,
  summary TEXT NOT NULL,
  full_body TEXT NOT NULL,
  is_verified INTEGER NOT NULL DEFAULT 1,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('normal', 'high')),
  read_time TEXT NOT NULL DEFAULT '2 min read',
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_announcements_urgency ON announcements(urgency);

-- 12. Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('like', 'comment', 'reply', 'mention', 'group', 'announcement', 'account', 'message', 'system')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  source_ref TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- 13. Subscriptions (Student Guild Pro & Campus Business Tiers)
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free', 'student_pro', 'campus_business')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'trialing', 'canceled', 'expired')),
  start_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  end_date DATETIME,
  price_naira INTEGER NOT NULL DEFAULT 0,
  free_access_start DATETIME,
  free_access_end DATETIME,
  payment_reference TEXT,
  renewal_status TEXT DEFAULT 'manual',
  channel TEXT NOT NULL DEFAULT 'moniepoint',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);

-- 14. Payments (Student Service Fees & Listings - Preserving Historical Records)
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subscription_id TEXT,
  reference TEXT UNIQUE NOT NULL,
  amount_kobo INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  purpose TEXT NOT NULL CHECK(purpose IN ('subscription', 'campus_trade_listing', 'ticket')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'awaiting_verification', 'confirmed', 'failed', 'expired', 'reversed', 'refunded')),
  channel TEXT NOT NULL DEFAULT 'moniepoint',
  provider_ref TEXT,
  submitted_reference TEXT,
  payer_bank_name TEXT,
  payer_account_name TEXT,
  proof_note TEXT,
  proof_attachment_url TEXT,
  submitted_at DATETIME,
  verified_by TEXT,
  verified_at DATETIME,
  verification_method TEXT,
  failure_reason TEXT,
  expires_at DATETIME,
  metadata_json TEXT,
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_provider_ref
  ON payments(provider_ref)
  WHERE provider_ref IS NOT NULL AND status IN ('confirmed', 'reversed', 'refunded');

-- 14b. Immutable Payment Audit Trail
CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT NOT NULL DEFAULT 'system',
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  provider_ref TEXT,
  notes TEXT,
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_audit_payment ON payment_audit_logs(payment_id, created_at DESC);

-- 15. Reports (Community Integrity & Moderation)
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment', 'user', 'chat')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reviewed', 'dismissed', 'resolved')),
  resolution_notes TEXT,
  reviewed_by TEXT,
  assigned_to TEXT,
  escalated_to_admin INTEGER NOT NULL DEFAULT 0,
  escalation_reason TEXT,
  escalated_by TEXT,
  escalated_at DATETIME,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal', 'high', 'urgent')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- 16. Admin Audit Logs
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit_logs(admin_id);

-- 17. User Sessions (Multi-device tokens, refresh rotation & session lifecycle)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  id TEXT UNIQUE,
  user_id TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  device_name TEXT,
  device_type TEXT NOT NULL DEFAULT 'desktop',
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  refresh_token_hash TEXT UNIQUE,
  refresh_expires_at DATETIME,
  max_expires_at DATETIME,
  revoked_at DATETIME,
  revoked_reason TEXT,
  is_suspicious INTEGER NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_id ON sessions(id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_active_lookup ON sessions(user_id, revoked_at, expires_at);

-- 18. User Blocks (Restricted direct communications)
CREATE TABLE IF NOT EXISTS user_blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON user_blocks(blocked_id);

-- 19. Login Attempts (Rate Limiting)
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  ip_address TEXT,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  success INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(identifier, attempted_at);

-- 20. Password Reset Tokens
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reset_code TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  is_used INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_resets_code ON password_resets(reset_code, is_used);

-- 21. Campus & Off-Campus Landmarks (Free OpenStreetMap / Leaflet compatible)
CREATE TABLE IF NOT EXISTS landmarks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('academic', 'hostel', 'gate', 'landmark', 'sports', 'off_campus')),
  campus_zone TEXT NOT NULL,
  coordinates_lat REAL NOT NULL,
  coordinates_lng REAL NOT NULL,
  description TEXT,
  is_off_campus INTEGER NOT NULL DEFAULT 0,
  pinned_count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_landmarks_cat ON landmarks(category);
CREATE INDEX IF NOT EXISTS idx_landmarks_zone ON landmarks(campus_zone);
CREATE INDEX IF NOT EXISTS idx_landmarks_offcampus ON landmarks(is_off_campus);

-- 22. Moderator Granular Permissions
CREATE TABLE IF NOT EXISTS moderator_permissions (
  user_id TEXT PRIMARY KEY,
  assigned_by TEXT NOT NULL,
  can_review_reports INTEGER NOT NULL DEFAULT 1,
  can_hide_content INTEGER NOT NULL DEFAULT 1,
  can_warn_users INTEGER NOT NULL DEFAULT 1,
  can_restrict_users INTEGER NOT NULL DEFAULT 1,
  max_restriction_hours INTEGER NOT NULL DEFAULT 72,
  can_review_communities INTEGER NOT NULL DEFAULT 1,
  can_escalate INTEGER NOT NULL DEFAULT 1,
  assigned_areas_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 23. Advertisements & Campus Campaigns (Admin Managed)
CREATE TABLE IF NOT EXISTS advertisements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sponsor_name TEXT NOT NULL,
  body TEXT NOT NULL,
  target_url TEXT,
  image_url TEXT,
  placement TEXT NOT NULL DEFAULT 'feed' CHECK(placement IN ('feed', 'communities', 'updates', 'sidebar')),
  target_area TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'paused', 'ended')),
  budget_kobo INTEGER NOT NULL DEFAULT 0,
  impressions_count INTEGER NOT NULL DEFAULT 0,
  clicks_count INTEGER NOT NULL DEFAULT 0,
  starts_at DATETIME,
  ends_at DATETIME,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ads_status_placement ON advertisements(status, placement);

-- 24. Security Events & Suspicious Activity Audit Trail
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'high', 'critical')),
  identifier TEXT,
  ip_address TEXT,
  user_agent TEXT,
  device_name TEXT,
  details_json TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, created_at DESC);

-- 25. User Saved & Pinned Locations (Strictly user-scoped, cross-device synced)
CREATE TABLE IF NOT EXISTS saved_locations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  landmark_id TEXT,
  name TEXT NOT NULL,
  custom_label TEXT,
  category TEXT NOT NULL DEFAULT 'custom',
  area_key TEXT,
  campus_zone TEXT,
  description TEXT,
  address TEXT,
  notes TEXT,
  coordinates_lat REAL NOT NULL,
  coordinates_lng REAL NOT NULL,
  is_off_campus INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('search', 'map', 'landmark', 'post', 'chat', 'manual')),
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_saved_locations_user_pinned ON saved_locations(user_id, is_pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_locations_user_used ON saved_locations(user_id, COALESCE(last_used_at, updated_at) DESC);

-- 26. User Location Search History (Per-user searchable history, deduplicated)
CREATE TABLE IF NOT EXISTS location_search_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  query_text TEXT NOT NULL,
  selected_name TEXT,
  selected_description TEXT,
  selected_address TEXT,
  selected_category TEXT,
  area_key TEXT,
  coordinates_lat REAL,
  coordinates_lng REAL,
  is_off_campus INTEGER NOT NULL DEFAULT 0,
  landmark_id TEXT,
  search_count INTEGER NOT NULL DEFAULT 1,
  searched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_loc_history_user_recent ON location_search_history(user_id, searched_at DESC);


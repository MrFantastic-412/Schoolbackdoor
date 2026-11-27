-- ============================================================
-- SCHOOLBACKDOOR DATABASE SCHEMA
-- Relational SQLite schema with Foreign Keys and Indexes
-- ============================================================

PRAGMA foreign_keys = ON;

-- 1. Users table (Core Identity & Credentials)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  matric_number TEXT UNIQUE NOT NULL,
  email TEXT,
  phone_number TEXT,
  username TEXT,
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
  recovery_codes_generated_at DATETIME,
  recovery_codes_remaining INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_matric ON users(matric_number);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username)) WHERE username IS NOT NULL;

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
  deleted_at DATETIME DEFAULT NULL,
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
  deleted_at DATETIME DEFAULT NULL,
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
  deleted_at DATETIME DEFAULT NULL,
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
  auth_method TEXT NOT NULL DEFAULT 'password',
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_id ON sessions(id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_active_lookup ON sessions(user_id, revoked_at, expires_at);

-- 17b. Single-Use Hashed Recovery Codes (Stage 3B)
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at DATETIME,
  invalidated_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_active ON recovery_codes(user_id, used_at, invalidated_at);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_hash ON recovery_codes(code_hash);

-- 17c. Shared Account Lockouts (Temporary cooldowns, anti-victim-DoS)
CREATE TABLE IF NOT EXISTS account_lockouts (
  account_key TEXT PRIMARY KEY,
  user_id TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at DATETIME,
  last_failed_at DATETIME,
  locked_until DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_lockouts_user ON account_lockouts(user_id);

-- 17d. Privacy-Preserving Proof-of-Work Bot Challenges (Zero personal data)
CREATE TABLE IF NOT EXISTS bot_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL DEFAULT 'register',
  nonce TEXT UNIQUE NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 14,
  ip_address TEXT,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_challenges_expires ON bot_challenges(expires_at);

-- 17e. Passkeys / WebAuthn Credentials & Challenges (Prepared for Stage 3C)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  label TEXT NOT NULL DEFAULT 'Passkey',
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_creds_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  challenge TEXT UNIQUE NOT NULL,
  ceremony_type TEXT NOT NULL CHECK(ceremony_type IN ('registration', 'authentication')),
  purpose TEXT NOT NULL DEFAULT 'login',
  rp_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_purpose ON webauthn_challenges(challenge, ceremony_type, purpose);

CREATE TABLE IF NOT EXISTS passkey_recovery_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  credential_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkey_recovery_expires ON passkey_recovery_tokens(expires_at);

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

-- 19. Login Attempts (Shared DB Rate Limiting)
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  ip_address TEXT,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  success INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(identifier, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_lookup ON login_attempts(ip_address, attempted_at);

-- 19b. Email Verification Tokens (SHA-256 hashed, single-use, expiring)
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_verif_token ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verif_code ON email_verifications(user_id, code_hash);

-- 19c. Registration Idempotency Keys (Double-submit & duplicate protection)
CREATE TABLE IF NOT EXISTS registration_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 20. Password Reset Tokens (SHA-256 hashed, single-use, expiring)
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reset_code TEXT NOT NULL,
  reset_code_hash TEXT,
  expires_at DATETIME NOT NULL,
  is_used INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_resets_code ON password_resets(reset_code, is_used);
CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets(reset_code_hash, is_used);

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

-- 27. Stage 5 Media Assets & Distributed Job Locks
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  thumb_filename TEXT,
  owner_id TEXT,
  context_type TEXT NOT NULL DEFAULT 'upload' CHECK(context_type IN ('profile', 'post', 'comment', 'chat', 'upload')),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  original_byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  exif_stripped INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS job_locks (
  job_name TEXT PRIMARY KEY,
  locked_by TEXT NOT NULL,
  locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_posts_active_feed ON posts(deleted_at, is_hidden, is_announcement DESC, is_pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_community_active ON posts(community_id, deleted_at, is_hidden, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author_active ON posts(author_id, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_deleted_at ON comments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_post_active ON comments(post_id, deleted_at, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_comments_parent_active ON comments(parent_comment_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_author_active ON comments(author_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat_active ON messages(chat_id, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_owner ON media_assets(owner_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_deleted ON media_assets(deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_context_created ON media_assets(context_type, created_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_thumb ON media_assets(thumb_filename);
CREATE INDEX IF NOT EXISTS idx_job_locks_expires ON job_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_assigned ON reports(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_communities_creator ON communities(creator_id);
CREATE INDEX IF NOT EXISTS idx_communities_chat ON communities(chat_id);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_user ON user_deletion_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_appeals_user_status ON appeals(user_id, status);


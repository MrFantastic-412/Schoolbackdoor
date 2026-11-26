import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteConnectionPool } from './pool.js';
import { hashPassword, verifyPassword } from '../utils/security.js';

const __dbFilename = fileURLToPath(import.meta.url);
const __dbDirname = path.dirname(__dbFilename);

function isDirWritable(targetDir: string): boolean {
  try {
    fs.accessSync(targetDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const isServerlessRuntime = Boolean(
  process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY
);

// Use local ./data on writable Node servers, and fall back to os.tmpdir() on read-only serverless bundles (/var/task)
const localDataDir = path.resolve(process.cwd(), 'data');
const DEFAULT_DB_DIR =
  isServerlessRuntime || (!fs.existsSync(localDataDir) && !isDirWritable(process.cwd()))
    ? path.join(os.tmpdir(), 'schoolbackdoor-data')
    : localDataDir;

export const DB_FILE = process.env.SCHOOLBACKDOOR_DB_PATH
  ? path.resolve(process.env.SCHOOLBACKDOOR_DB_PATH)
  : path.join(DEFAULT_DB_DIR, 'schoolbackdoor.db');
export const DB_DIR = path.dirname(DB_FILE);
export const BACKUP_DIR = process.env.SCHOOLBACKDOOR_BACKUP_DIR
  ? path.resolve(process.env.SCHOOLBACKDOOR_BACKUP_DIR)
  : path.join(DB_DIR, 'backups');
export const TMP_DIR = process.env.SCHOOLBACKDOOR_TMP_DIR
  ? path.resolve(process.env.SCHOOLBACKDOOR_TMP_DIR)
  : path.join(DB_DIR, 'tmp');
export const CACHE_DIR = process.env.SCHOOLBACKDOOR_CACHE_DIR
  ? path.resolve(process.env.SCHOOLBACKDOOR_CACHE_DIR)
  : path.join(DB_DIR, 'cache');
export const LOGS_DIR = process.env.SCHOOLBACKDOOR_LOGS_DIR
  ? path.resolve(process.env.SCHOOLBACKDOOR_LOGS_DIR)
  : path.join(DB_DIR, 'logs');

const SCHEMA_CANDIDATES = [
  path.resolve(__dbDirname, 'schema.sql'),
  path.resolve(process.cwd(), 'server', 'db', 'schema.sql'),
  path.resolve('/var/task', 'server', 'db', 'schema.sql'),
];
const SCHEMA_FILE = SCHEMA_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || SCHEMA_CANDIDATES[0];

// Ensure data runtime folders exist cleanly
for (const dir of [DB_DIR, BACKUP_DIR, TMP_DIR, CACHE_DIR, LOGS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Initialize SQLite database instance
export const db = new DatabaseSync(DB_FILE);

// Enable Foreign Key validation, WAL mode, and concurrency/performance tuning PRAGMAs
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA cache_size = -16000;');
db.exec('PRAGMA temp_store = MEMORY;');
db.exec('PRAGMA mmap_size = 67108864;');

// Read-only connection pool for concurrent WAL SELECTs
const readPool = new SqliteConnectionPool(
  DB_FILE,
  db,
  Number(process.env.DB_READ_POOL_SIZE) || 4
);

let activeTransactionDepth = 0;

export function withReadConnection<T>(fn: (conn: DatabaseSync) => T): T {
  if (activeTransactionDepth > 0) {
    return fn(db);
  }
  return readPool.withReadConnection(fn);
}

export function getPoolStats() {
  return readPool.getStats();
}

export function closeReadPool() {
  readPool.closeAll();
}

export function reopenReadPool() {
  readPool.reopen();
}

/**
 * Initializes tables and indexes from schema.sql + Stage 8/9/Storage migrations
 */
export function initDatabase() {
  if (fs.existsSync(SCHEMA_FILE)) {
    const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf-8');
    db.exec(schemaSql);

    // Apply safe column migrations for both pre-existing and newly created tables
    const safeAddColumn = (table: string, colDef: string) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch {
        // Ignored if column already exists
      }
    };

    safeAddColumn('users', 'phone_number TEXT');
    safeAddColumn('users', 'username TEXT');
    safeAddColumn('users', 'is_verified INTEGER DEFAULT 0');
    safeAddColumn('users', 'verification_code TEXT');
    safeAddColumn('users', 'suspension_reason TEXT');
    safeAddColumn('users', 'suspended_until DATETIME');
    safeAddColumn('users', 'suspended_by TEXT');
    safeAddColumn('users', 'last_active_at DATETIME');
    safeAddColumn('users', 'mfa_enabled INTEGER DEFAULT 0');
    safeAddColumn('users', 'mfa_secret TEXT');
    safeAddColumn('users', 'account_restricted_until DATETIME');
    safeAddColumn('users', 'restriction_reason TEXT');
    safeAddColumn('users', 'restricted_by TEXT');
    safeAddColumn('users', 'warnings_count INTEGER DEFAULT 0');

    // Non-destructive migration for pre-existing users table so 'moderator' role is permitted by CHECK constraint
    const existingUsersTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get() as { sql?: string } | undefined;

    if (existingUsersTable?.sql && !existingUsersTable.sql.includes("'moderator'")) {
      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        runInTransaction(() => {
          db.exec(`
            CREATE TABLE users_migrated (
              id TEXT PRIMARY KEY,
              matric_number TEXT UNIQUE NOT NULL,
              email TEXT UNIQUE NOT NULL,
              phone_number TEXT,
              username TEXT,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student', 'staff', 'admin', 'moderator')),
              status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'pending_verification')),
              is_verified INTEGER DEFAULT 0,
              verification_code TEXT,
              suspension_reason TEXT,
              suspended_until DATETIME,
              suspended_by TEXT,
              last_active_at DATETIME,
              mfa_enabled INTEGER DEFAULT 0,
              mfa_secret TEXT,
              account_restricted_until DATETIME,
              restriction_reason TEXT,
              restricted_by TEXT,
              warnings_count INTEGER DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
          `);

          db.exec(`
            INSERT INTO users_migrated (
              id, matric_number, email, phone_number, username, password_hash,
              role, status, is_verified, verification_code,
              suspension_reason, suspended_until, suspended_by, last_active_at,
              mfa_enabled, mfa_secret, account_restricted_until, restriction_reason,
              restricted_by, warnings_count, created_at, updated_at
            )
            SELECT
              id, matric_number, email, phone_number, username, password_hash,
              CASE WHEN role IN ('superadmin', 'support') THEN 'admin' ELSE role END,
              status, COALESCE(is_verified, 0), verification_code,
              suspension_reason, suspended_until, suspended_by, last_active_at,
              COALESCE(mfa_enabled, 0), mfa_secret, account_restricted_until, restriction_reason,
              restricted_by, COALESCE(warnings_count, 0), created_at, updated_at
            FROM users;
          `);

          db.exec('DROP TABLE users;');
          db.exec('ALTER TABLE users_migrated RENAME TO users;');
          db.exec('CREATE INDEX IF NOT EXISTS idx_users_matric ON users(matric_number);');
          db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);');
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    }

    safeAddColumn('user_profiles', 'avatar_url TEXT');
    safeAddColumn('user_profiles', 'avatar_thumb_url TEXT');
    safeAddColumn('user_profiles', 'is_private INTEGER DEFAULT 0');
    safeAddColumn('user_profiles', 'allow_anonymous_posts INTEGER DEFAULT 1');
    safeAddColumn('user_profiles', 'show_online_status INTEGER DEFAULT 1');
    safeAddColumn('user_profiles', 'notify_mentions INTEGER DEFAULT 1');
    safeAddColumn('user_profiles', 'notify_replies INTEGER DEFAULT 1');
    safeAddColumn('user_profiles', 'notify_messages INTEGER DEFAULT 1');
    safeAddColumn('user_profiles', 'notify_community_alerts INTEGER DEFAULT 1');
    safeAddColumn('user_profiles', 'notify_hostel_alerts INTEGER DEFAULT 1');
    safeAddColumn('users', 'accepted_terms_at DATETIME');
    safeAddColumn('users', 'accepted_terms_version TEXT');
    safeAddColumn('users', 'last_reauthenticated_at DATETIME');
    safeAddColumn('users', 'recovery_codes_generated_at DATETIME');
    safeAddColumn('users', 'recovery_codes_remaining INTEGER DEFAULT 0');

    // Stage 3B non-destructive migration: make legacy users.email nullable while preserving all existing rows & hashes
    try {
      const userCols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string; notnull: number }>;
      const emailCol = userCols.find((c) => c.name === 'email');
      if (emailCol && emailCol.notnull === 1) {
        db.exec('PRAGMA foreign_keys = OFF;');
        try {
          runInTransaction(() => {
            db.exec(`
              CREATE TABLE users_stage3b_migrated (
                id TEXT PRIMARY KEY,
                matric_number TEXT UNIQUE NOT NULL,
                email TEXT,
                phone_number TEXT,
                username TEXT,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student', 'staff', 'admin', 'moderator')),
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'pending_verification')),
                is_verified INTEGER DEFAULT 0,
                verification_code TEXT,
                suspension_reason TEXT,
                suspended_until DATETIME,
                suspended_by TEXT,
                last_active_at DATETIME,
                mfa_enabled INTEGER DEFAULT 0,
                mfa_secret TEXT,
                account_restricted_until DATETIME,
                restriction_reason TEXT,
                restricted_by TEXT,
                warnings_count INTEGER DEFAULT 0,
                accepted_terms_at DATETIME,
                accepted_terms_version TEXT,
                last_reauthenticated_at DATETIME,
                recovery_codes_generated_at DATETIME,
                recovery_codes_remaining INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
            `);
            db.exec(`
              INSERT INTO users_stage3b_migrated (
                id, matric_number, email, phone_number, username, password_hash,
                role, status, is_verified, verification_code,
                suspension_reason, suspended_until, suspended_by, last_active_at,
                mfa_enabled, mfa_secret, account_restricted_until, restriction_reason,
                restricted_by, warnings_count, accepted_terms_at, accepted_terms_version,
                last_reauthenticated_at, recovery_codes_generated_at, recovery_codes_remaining,
                created_at, updated_at
              )
              SELECT
                id, matric_number, email, phone_number, username, password_hash,
                role, status, COALESCE(is_verified, 0), verification_code,
                suspension_reason, suspended_until, suspended_by, last_active_at,
                COALESCE(mfa_enabled, 0), mfa_secret, account_restricted_until, restriction_reason,
                restricted_by, COALESCE(warnings_count, 0), accepted_terms_at, accepted_terms_version,
                last_reauthenticated_at, recovery_codes_generated_at, COALESCE(recovery_codes_remaining, 0),
                created_at, updated_at
              FROM users;
            `);
            db.exec('DROP TABLE users;');
            db.exec('ALTER TABLE users_stage3b_migrated RENAME TO users;');
            db.exec('CREATE INDEX IF NOT EXISTS idx_users_matric ON users(matric_number);');
            db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);');
          });
        } finally {
          db.exec('PRAGMA foreign_keys = ON;');
        }
      }
    } catch {
      // Non-fatal if already migrated
    }

    safeAddColumn('sessions', 'id TEXT');
    safeAddColumn('sessions', 'device_name TEXT');
    safeAddColumn('sessions', "device_type TEXT DEFAULT 'desktop'");
    safeAddColumn('sessions', 'last_active_at DATETIME');
    safeAddColumn('sessions', 'refresh_token_hash TEXT');
    safeAddColumn('sessions', 'refresh_expires_at DATETIME');
    safeAddColumn('sessions', 'max_expires_at DATETIME');
    safeAddColumn('sessions', 'revoked_at DATETIME');
    safeAddColumn('sessions', 'revoked_reason TEXT');
    safeAddColumn('sessions', 'is_suspicious INTEGER DEFAULT 0');
    safeAddColumn('sessions', "auth_method TEXT DEFAULT 'password'");
    safeAddColumn('user_profiles', 'location_sharing_enabled INTEGER DEFAULT 0');
    safeAddColumn('user_profiles', 'preferred_location_area TEXT');

    safeAddColumn('posts', 'is_anonymous INTEGER DEFAULT 0');
    safeAddColumn('posts', 'community_id TEXT');
    safeAddColumn('posts', 'is_announcement INTEGER DEFAULT 0');
    safeAddColumn('posts', 'announcement_urgency TEXT DEFAULT "normal"');
    safeAddColumn('posts', 'is_hidden INTEGER DEFAULT 0');
    safeAddColumn('posts', 'edited_at DATETIME');
    safeAddColumn('posts', 'views_count INTEGER DEFAULT 0');
    safeAddColumn('posts', 'shares_count INTEGER DEFAULT 0');
    safeAddColumn('posts', 'area_key TEXT');
    safeAddColumn('posts', 'is_featured INTEGER DEFAULT 0');
    safeAddColumn('posts', 'is_admin_post INTEGER DEFAULT 0');
    safeAddColumn('posts', "distribution_scope TEXT DEFAULT 'standard'");

    safeAddColumn('comments', 'parent_comment_id TEXT');
    safeAddColumn('comments', 'images_json TEXT');
    safeAddColumn('comments', 'updated_at DATETIME');
    safeAddColumn('comments', 'edited_at DATETIME');

    safeAddColumn('messages', 'edited_at DATETIME');
    safeAddColumn('messages', 'read_at DATETIME');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_chat_read ON messages(chat_id, sender_id, read_at);');

    safeAddColumn('communities', 'creator_id TEXT');
    safeAddColumn('communities', 'chat_id TEXT');
    safeAddColumn('communities', 'settings_json TEXT');
    safeAddColumn('communities', 'rules TEXT');

    safeAddColumn('subscriptions', 'free_access_start DATETIME');
    safeAddColumn('subscriptions', 'free_access_end DATETIME');
    safeAddColumn('subscriptions', 'payment_reference TEXT');
    safeAddColumn('subscriptions', "renewal_status TEXT DEFAULT 'manual'");
    safeAddColumn('subscriptions', "channel TEXT DEFAULT 'moniepoint'");

    safeAddColumn('password_resets', 'failed_attempts INTEGER DEFAULT 0');
    safeAddColumn('password_resets', 'reset_code_hash TEXT');
    safeAddColumn('reports', 'assigned_to TEXT');
    safeAddColumn('reports', 'escalated_to_admin INTEGER DEFAULT 0');
    safeAddColumn('reports', 'escalation_reason TEXT');
    safeAddColumn('reports', 'escalated_by TEXT');
    safeAddColumn('reports', 'escalated_at DATETIME');
    safeAddColumn('reports', "priority TEXT DEFAULT 'normal'");
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_escalated ON reports(escalated_to_admin, status, created_at DESC);');
    } catch {
      // ignore if column or index already handled
    }

    // Non-destructive migration for pre-existing payments table:
    // Preserves 100% of historical PalmPay / FCMB records while upgrading status CHECK constraints and verification columns.
    const existingPaymentsTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'")
      .get() as { sql?: string } | undefined;

    if (existingPaymentsTable?.sql && !existingPaymentsTable.sql.includes('awaiting_verification')) {
      safeAddColumn('payments', "channel TEXT DEFAULT 'moniepoint'");
      safeAddColumn('payments', 'provider_ref TEXT');
      safeAddColumn('payments', 'metadata_json TEXT');

      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        runInTransaction(() => {
          db.exec(`
            CREATE TABLE payments_migrated (
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
              sending_bank_code TEXT,
              payer_account_name TEXT,
              transfer_amount_kobo INTEGER,
              transfer_date TEXT,
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
          `);

          db.exec(`
            INSERT INTO payments_migrated (
              id, user_id, subscription_id, reference, amount_kobo, currency, purpose,
              status, channel, provider_ref, metadata_json, paid_at, created_at
            )
            SELECT
              id,
              user_id,
              subscription_id,
              reference,
              amount_kobo,
              COALESCE(currency, 'NGN'),
              purpose,
              CASE status
                WHEN 'successful' THEN 'confirmed'
                WHEN 'pending' THEN 'pending'
                WHEN 'failed' THEN 'failed'
                WHEN 'reversed' THEN 'reversed'
                ELSE 'pending'
              END,
              COALESCE(channel, 'palmpay'),
              provider_ref,
              metadata_json,
              paid_at,
              created_at
            FROM payments;
          `);

          db.exec('DROP TABLE payments;');
          db.exec('ALTER TABLE payments_migrated RENAME TO payments;');
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    } else {
      safeAddColumn('payments', "channel TEXT DEFAULT 'moniepoint'");
      safeAddColumn('payments', 'provider_ref TEXT');
      safeAddColumn('payments', 'submitted_reference TEXT');
      safeAddColumn('payments', 'payer_bank_name TEXT');
      safeAddColumn('payments', 'sending_bank_code TEXT');
      safeAddColumn('payments', 'payer_account_name TEXT');
      safeAddColumn('payments', 'transfer_amount_kobo INTEGER');
      safeAddColumn('payments', 'transfer_date TEXT');
      safeAddColumn('payments', 'proof_note TEXT');
      safeAddColumn('payments', 'proof_attachment_url TEXT');
      safeAddColumn('payments', 'submitted_at DATETIME');
      safeAddColumn('payments', 'verified_by TEXT');
      safeAddColumn('payments', 'verified_at DATETIME');
      safeAddColumn('payments', 'verification_method TEXT');
      safeAddColumn('payments', 'failure_reason TEXT');
      safeAddColumn('payments', 'expires_at DATETIME');
      safeAddColumn('payments', 'metadata_json TEXT');
    }

    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(reference);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_payments_bank_date ON payments(payer_bank_name, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_provider_ref
        ON payments(provider_ref)
        WHERE provider_ref IS NOT NULL AND status IN ('confirmed', 'reversed', 'refunded');
      CREATE INDEX IF NOT EXISTS idx_payment_audit_payment ON payment_audit_logs(payment_id, created_at DESC);
    `);

    safeAddColumn('messages', 'client_id TEXT');
    safeAddColumn('messages', 'updated_at DATETIME');

    safeAddColumn('reports', 'action_taken TEXT');
    safeAddColumn('reports', 'assigned_to TEXT');
    safeAddColumn('reports', 'escalated_to_admin INTEGER DEFAULT 0');
    safeAddColumn('reports', 'escalation_reason TEXT');
    safeAddColumn('reports', 'escalated_by TEXT');
    safeAddColumn('reports', 'escalated_at DATETIME');
    safeAddColumn('reports', "priority TEXT DEFAULT 'normal'");

    safeAddColumn('posts', 'poll_json TEXT');

    // Non-destructive migration for pre-existing notifications table:
    // Enables native 'mention', 'reply', 'group', 'account' types plus source_ref tracking.
    const existingNotificationsTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'")
      .get() as { sql?: string } | undefined;

    if (existingNotificationsTable?.sql && !existingNotificationsTable.sql.includes("'mention'")) {
      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        runInTransaction(() => {
          db.exec(`
            CREATE TABLE notifications_migrated (
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
          `);

          db.exec(`
            INSERT INTO notifications_migrated (
              id, user_id, type, title, body, link, is_read, created_at
            )
            SELECT id, user_id, type, title, body, link, is_read, created_at
            FROM notifications;
          `);

          db.exec('DROP TABLE notifications;');
          db.exec('ALTER TABLE notifications_migrated RENAME TO notifications;');
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    } else {
      safeAddColumn('notifications', 'source_ref TEXT');
    }

    // Create Stage 8 Security, Moderation, and Deletion Tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_warnings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        admin_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'standard' CHECK(severity IN ('minor', 'standard', 'severe')),
        details TEXT,
        is_acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS appeals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('suspension', 'warning', 'content_removal')),
        target_id TEXT,
        statement TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'under_review', 'accepted', 'rejected')),
        review_notes TEXT,
        reviewed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS deletion_tombstones (
        id TEXT PRIMARY KEY,
        user_id_hash TEXT UNIQUE NOT NULL,
        deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reason TEXT,
        records_purged INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS retained_accounting_records (
        id TEXT PRIMARY KEY,
        payment_id TEXT UNIQUE NOT NULL,
        user_id_hash TEXT NOT NULL,
        reference TEXT NOT NULL,
        amount_kobo INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'NGN',
        channel TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL,
        paid_at DATETIME,
        retention_until DATETIME NOT NULL,
        retained_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS backup_snapshots (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        created_by TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_warnings_user ON user_warnings(user_id);
      CREATE INDEX IF NOT EXISTS idx_appeals_user ON appeals(user_id);
      CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);
      CREATE INDEX IF NOT EXISTS idx_tombstones_hash ON deletion_tombstones(user_id_hash);
      CREATE INDEX IF NOT EXISTS idx_accounting_retention ON retained_accounting_records(retention_until);
    `);

    // Create Stage 9/10 Shared Presence, Job Telemetry, Storage Snapshots, and Deletion Queue Tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_presence (
        user_id TEXT PRIMARY KEY,
        last_seen_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        show_online_status INTEGER NOT NULL DEFAULT 1,
        active_tabs INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_presence_clients (
        client_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        last_heartbeat_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS background_jobs_log (
        id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        records_affected INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS user_deletion_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS storage_snapshots (
        id TEXT PRIMARY KEY,
        total_bytes INTEGER NOT NULL,
        database_bytes INTEGER NOT NULL,
        media_bytes INTEGER NOT NULL,
        cache_bytes INTEGER NOT NULL,
        temp_bytes INTEGER NOT NULL,
        logs_bytes INTEGER NOT NULL,
        backups_bytes INTEGER NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS platform_features (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'core' CHECK(category IN ('core', 'social', 'discovery', 'governance')),
        enabled INTEGER NOT NULL DEFAULT 1,
        visible_in_nav INTEGER NOT NULL DEFAULT 1,
        maintenance_mode INTEGER NOT NULL DEFAULT 0,
        maintenance_message TEXT,
        limits_json TEXT NOT NULL DEFAULT '{}',
        settings_json TEXT NOT NULL DEFAULT '{}',
        nav_tab TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT
      );

      CREATE TABLE IF NOT EXISTS website_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure moderator permissions & advertisements tables exist on pre-existing databases
    db.exec(`
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
    `);

    // Migrate any pre-existing legacy superadmin/support rows to single 'admin' role (preserve 'moderator')
    // and ensure chat features no longer enforce paid subscriptions on pre-existing databases.
    try {
      db.exec("UPDATE users SET role = 'admin' WHERE role IN ('superadmin', 'support')");
      db.exec("UPDATE user_profiles SET badges_json = REPLACE(badges_json, 'Super Admin', 'Admin') WHERE badges_json LIKE '%Super Admin%'");
      db.exec("UPDATE platform_features SET settings_json = '{}' WHERE key = 'chats' AND settings_json LIKE '%enforceSubscriptionAfterTrial%'");
    } catch {
      // ignore on fresh schema
    }

    // Ensure social interaction tables exist on pre-existing databases
    db.exec(`
      CREATE TABLE IF NOT EXISTS post_reposts (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(post_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS user_connections (
        id TEXT PRIMARY KEY,
        follower_id TEXT NOT NULL,
        following_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(follower_id, following_id)
      );

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

      CREATE TABLE IF NOT EXISTS post_shares (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        sharer_key TEXT NOT NULL,
        user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        UNIQUE(post_id, sharer_key)
      );

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

      CREATE TABLE IF NOT EXISTS registration_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

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
    `);

    safeAddColumn('webauthn_challenges', "purpose TEXT NOT NULL DEFAULT 'login'");

    // Performance Indexes for Feed, Messaging, Expiry Sweeps, Activity Analytics & Presence
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_messages_client_id ON messages(chat_id, client_id);',
      'CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_messages_expiry ON messages(created_at);',
      'CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id);',
      'CREATE INDEX IF NOT EXISTS idx_posts_announcement ON posts(is_announcement);',
      'CREATE INDEX IF NOT EXISTS idx_posts_feed_order ON posts(is_hidden, is_announcement DESC, is_pinned DESC, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_posts_school_created ON posts(school_tag, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_posts_community_feed ON posts(community_id, is_hidden, is_announcement DESC, is_pinned DESC, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_posts_area_created ON posts(area_key, is_hidden, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_posts_expiry ON posts(created_at);',
      'CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id, created_at ASC);',
      'CREATE INDEX IF NOT EXISTS idx_comments_post_author_created ON comments(post_id, created_at DESC, author_id);',
      'CREATE INDEX IF NOT EXISTS idx_comments_author_created ON comments(author_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id);',
      'CREATE INDEX IF NOT EXISTS idx_likes_post_created ON likes(post_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_reposts_post ON post_reposts(post_id);',
      'CREATE INDEX IF NOT EXISTS idx_reposts_post_created ON post_reposts(post_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_reposts_user ON post_reposts(user_id);',
      'CREATE INDEX IF NOT EXISTS idx_post_views_post_created ON post_views(post_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_post_views_viewer ON post_views(viewer_key, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_post_shares_post_created ON post_shares(post_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON poll_votes(post_id);',
      'CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes(user_id, post_id);',
      'CREATE INDEX IF NOT EXISTS idx_connections_follower ON user_connections(follower_id);',
      'CREATE INDEX IF NOT EXISTS idx_connections_following ON user_connections(following_id);',
      'CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);',
      'CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created ON notifications(user_id, is_read, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_notifications_source_ref ON notifications(source_ref);',
      'CREATE INDEX IF NOT EXISTS idx_chats_last_msg ON chats(last_message_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created ON subscriptions(user_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_login_attempts_attempted ON login_attempts(attempted_at);',
      'CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_presence_expires ON user_presence(expires_at, show_online_status);',
      'CREATE INDEX IF NOT EXISTS idx_presence_clients_user ON user_presence_clients(user_id, expires_at);',
      'CREATE INDEX IF NOT EXISTS idx_presence_clients_expires ON user_presence_clients(expires_at);',
      'CREATE INDEX IF NOT EXISTS idx_jobs_name_status ON background_jobs_log(job_name, status, started_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_jobs_started ON background_jobs_log(started_at);',
      'CREATE INDEX IF NOT EXISTS idx_deletion_requests_status ON user_deletion_requests(status, requested_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_storage_snapshots_recorded ON storage_snapshots(recorded_at DESC);',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id_unique ON sessions(id);',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refresh_unique ON sessions(refresh_token_hash);',
      'CREATE INDEX IF NOT EXISTS idx_sessions_active_lookup ON sessions(user_id, revoked_at, expires_at);',
      'CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_saved_locations_user_pinned ON saved_locations(user_id, is_pinned DESC, updated_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_saved_locations_user_used ON saved_locations(user_id, COALESCE(last_used_at, updated_at) DESC);',
      'CREATE INDEX IF NOT EXISTS idx_loc_history_user_recent ON location_search_history(user_id, searched_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_lookup ON login_attempts(ip_address, attempted_at);',
      'CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_email_verif_token ON email_verifications(token_hash);',
      'CREATE INDEX IF NOT EXISTS idx_email_verif_code ON email_verifications(user_id, code_hash);',
      'CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets(reset_code_hash, is_used);',
      'CREATE INDEX IF NOT EXISTS idx_recovery_codes_active ON recovery_codes(user_id, used_at, invalidated_at);',
      'CREATE INDEX IF NOT EXISTS idx_recovery_codes_hash ON recovery_codes(code_hash);',
      'CREATE INDEX IF NOT EXISTS idx_account_lockouts_user ON account_lockouts(user_id);',
      'CREATE INDEX IF NOT EXISTS idx_bot_challenges_expires ON bot_challenges(expires_at);',
      'CREATE INDEX IF NOT EXISTS idx_webauthn_creds_user ON webauthn_credentials(user_id);',
      'CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);',
      'CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_purpose ON webauthn_challenges(challenge, ceremony_type, purpose);',
      'CREATE INDEX IF NOT EXISTS idx_passkey_recovery_expires ON passkey_recovery_tokens(expires_at);',
      'DROP INDEX IF EXISTS idx_users_email_lower;',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email)) WHERE email IS NOT NULL;',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username)) WHERE username IS NOT NULL;',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_handle_lower ON user_profiles(LOWER(handle));',
    ];

    for (const sql of indexes) {
      try {
        db.exec(sql);
      } catch {
        // Ignore if index creation fails on partial schema
      }
    }

    // Backfill session IDs/last_active_at and seeded core account ToS stamps cleanly
    try {
      db.exec(`
        UPDATE sessions
        SET id = COALESCE(id, 'sess-' || substr(token, 1, 16)),
            last_active_at = COALESCE(last_active_at, created_at, CURRENT_TIMESTAMP),
            device_type = COALESCE(device_type, 'desktop')
        WHERE id IS NULL OR last_active_at IS NULL OR device_type IS NULL;

        UPDATE users
        SET accepted_terms_version = COALESCE(accepted_terms_version, '2026.11'),
            accepted_terms_at = COALESCE(accepted_terms_at, created_at, CURRENT_TIMESTAMP)
        WHERE id IN ('u-ayodele', 'u-kemi', 'u-dami', 'u-chronicle', 'u-admin', 'u-mod')
          AND accepted_terms_version IS NULL;
      `);
    } catch {
      // Non-fatal
    }

    // Refresh legacy default app copy strings on existing DBs (leaves user posts, messages & usernames untouched)
    const copyCleanups = [
      `UPDATE website_settings SET value = 'Independent Student Social Network' WHERE key = 'site_tagline' AND value LIKE '%FUTA%'`,
      `UPDATE platform_features SET description = 'Community notices, student digests, and campus spots.' WHERE key = 'updates' AND description LIKE '%FUTA%'`,
      `UPDATE announcements SET full_body = 'Disclaimer: Schoolbackdoor is an independent student social network and is not affiliated with university administration. Please verify official exam timetables directly with your department noticeboard. Students report quiet reading sessions active at ETF 3 and Ilemobade Library.' WHERE id = 'notice-1' AND full_body LIKE '%not affiliated with FUTA%'`,
      `UPDATE user_profiles SET bio = 'Platform safety oversight, moderation management, and community integrity for Schoolbackdoor (independent student platform).' WHERE id = 'p-admin' AND bio LIKE '%FUTA%'`,
      `UPDATE posts SET images_json = '["https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=800&q=80"]' WHERE id = 'post-3' AND images_json LIKE '%photo-1508098682722-e99c43a406b2%'`,
    ];
    for (const sql of copyCleanups) {
      try {
        db.exec(sql);
      } catch {
        // Ignore if table not yet populated
      }
    }

    // Ensure the single Admin account uses THEBACKDOOR identity and hashes password from server env secret when set
    syncTheBackdoorAdminIdentity();
    syncDefaultModeratorAccount();
  } else {
    throw new Error(`Schema file not found at ${SCHEMA_FILE}`);
  }
}

export const UNCLAIMED_CREDENTIAL_SENTINEL = '!UNCLAIMED_SETUP_REQUIRED';

/**
 * Keeps the single Admin account ('u-admin') synced to username THEBACKDOOR (@THEBACKDOOR)
 * and securely hashes ADMIN_PASSWORD / SCHOOLBACKDOOR_ADMIN_PASSWORD if configured on the server.
 * Never embeds fallback passwords in code; unconfigured fresh installs remain unclaimed until
 * configured via env secret, CLI provisioning script (`npm run provision:staff`), or first-run setup.
 */
export function syncTheBackdoorAdminIdentity() {
  try {
    const adminRow = db
      .prepare("SELECT id, password_hash, username FROM users WHERE id = 'u-admin' OR role = 'admin' LIMIT 1")
      .get() as { id: string; password_hash: string; username?: string } | undefined;

    if (!adminRow) return;

    const envPassword = (
      process.env.ADMIN_PASSWORD ||
      process.env.SCHOOLBACKDOOR_ADMIN_PASSWORD ||
      ''
    ).trim();

    db.prepare(`
      UPDATE users
      SET matric_number = 'ADMIN/001',
          username = '@THEBACKDOOR',
          role = 'admin',
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(adminRow.id);

    db.prepare(`
      UPDATE user_profiles
      SET name = 'THEBACKDOOR',
          handle = '@THEBACKDOOR',
          school = 'Independent Platform',
          campus = 'Main Platform Desk',
          bio = 'Official Platform Governance, Safety & Announcements for Schoolbackdoor.',
          verified = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(adminRow.id);

    if (envPassword) {
      if (
        !adminRow.password_hash ||
        adminRow.password_hash === UNCLAIMED_CREDENTIAL_SENTINEL ||
        !verifyPassword(envPassword, adminRow.password_hash)
      ) {
        db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
          hashPassword(envPassword),
          adminRow.id
        );
      }
    } else if (!adminRow.password_hash) {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        UNCLAIMED_CREDENTIAL_SENTINEL,
        adminRow.id
      );
    }
  } catch {
    // Non-fatal on partial schema before first seed
  }
}

/**
 * Ensures a dedicated default Moderator account (@campus_mod) exists with standard permissions.
 * Password is only set when MODERATOR_PASSWORD is supplied via environment or CLI provisioning.
 */
export function syncDefaultModeratorAccount() {
  try {
    const adminExists = db.prepare("SELECT id FROM users WHERE id = 'u-admin' OR role = 'admin' LIMIT 1").get();
    if (!adminExists) return; // Do not prematurely seed before seedInitialData

    const modRow = db
      .prepare("SELECT id, password_hash FROM users WHERE id = 'u-mod' OR username = '@campus_mod' LIMIT 1")
      .get() as { id: string; password_hash: string } | undefined;

    const envModPassword = (process.env.MODERATOR_PASSWORD || '').trim();

    if (!modRow) {
      const modHash = envModPassword ? hashPassword(envModPassword) : UNCLAIMED_CREDENTIAL_SENTINEL;
      const modId = 'u-mod';
      db.prepare(`
        INSERT INTO users (id, matric_number, email, username, password_hash, role, status, is_verified, accepted_terms_version, accepted_terms_at)
        VALUES (?, 'MOD/001', NULL, '@campus_mod', ?, 'moderator', 'active', 0, '2026.11', CURRENT_TIMESTAMP)
      `).run(modId, modHash);

      db.prepare(`
        INSERT INTO user_profiles (
          id, user_id, name, handle, department, school, level, hall_of_residence,
          campus, bio, avatar_initials, avatar_bg, verified, badges_json
        ) VALUES (
          'p-mod', ?, 'Campus Moderator', '@campus_mod', 'Community Safety',
          'Platform Governance', 'Moderator', 'Moderator Desk', 'Main Campus',
          'Community Moderation Desk. Enforcing campus guidelines and reviewing reports.',
          'CM', 'bg-blue-900 text-blue-100', 1, ?
        )
      `).run(modId, JSON.stringify(['Moderator']));

      db.prepare(`
        INSERT INTO moderator_permissions (
          user_id, assigned_by, can_review_reports, can_hide_content, can_warn_users,
          can_restrict_users, max_restriction_hours, can_review_communities, can_escalate,
          assigned_areas_json, notes, updated_at
        ) VALUES (
          ?, 'u-admin', 1, 1, 1, 1, 72, 1, 1, '[]', 'Default Campus Moderator', CURRENT_TIMESTAMP
        )
      `).run(modId);
    } else if (
      envModPassword &&
      (!modRow.password_hash ||
        modRow.password_hash === UNCLAIMED_CREDENTIAL_SENTINEL ||
        !verifyPassword(envModPassword, modRow.password_hash))
    ) {
      db.prepare('UPDATE users SET password_hash = ?, role = "moderator", updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        hashPassword(envModPassword),
        modRow.id
      );
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Helper to run transactional blocks
 */
export function runInTransaction<T>(fn: () => T): T {
  const isOutermost = activeTransactionDepth === 0;
  if (isOutermost) {
    db.exec('BEGIN TRANSACTION;');
  }
  activeTransactionDepth++;
  try {
    const result = fn();
    activeTransactionDepth--;
    if (isOutermost) {
      db.exec('COMMIT;');
    }
    return result;
  } catch (error) {
    activeTransactionDepth--;
    if (isOutermost) {
      db.exec('ROLLBACK;');
    }
    throw error;
  }
}

/**
 * Flush WAL cleanly on shutdown
 */
export function checkpointDatabase() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // ignore checkpoint error if closing
  }
}

/**
 * One-time / out-of-band privileged credential provisioning script.
 * Usage:
 *   ADMIN_PASSWORD="..." MODERATOR_PASSWORD="..." STAFF_PASSWORD="..." npm run provision:staff
 *   or interactively: npm run provision:staff
 *
 * Never stores plaintext passwords in code or logs.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { initDatabase, db, checkpointDatabase } from '../db/database.js';
import { seedInitialData } from '../db/seed.js';
import { hashPassword, validateStrongPassword, recordSecurityEvent } from '../utils/security.js';

type PrivilegedSpec = {
  role: 'admin' | 'moderator' | 'staff';
  userId: string;
  username: string;
  envNames: string[];
};

const PRIVILEGED_ACCOUNTS: PrivilegedSpec[] = [
  {
    role: 'admin',
    userId: 'u-admin',
    username: '@THEBACKDOOR',
    envNames: ['ADMIN_PASSWORD', 'SCHOOLBACKDOOR_ADMIN_PASSWORD'],
  },
  {
    role: 'moderator',
    userId: 'u-mod',
    username: '@campus_mod',
    envNames: ['MODERATOR_PASSWORD'],
  },
  {
    role: 'staff',
    userId: 'u-chronicle',
    username: '@futachronicle',
    envNames: ['STAFF_PASSWORD'],
  },
];

function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    process.stdout.write(promptText);
    muted = Boolean(process.stdin.isTTY);
    rl.question('', (answer) => {
      muted = false;
      if (process.stdin.isTTY) process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readEnvPassword(envNames: string[]): string {
  for (const name of envNames) {
    const val = (process.env[name] || '').trim();
    if (val) return val;
  }
  return '';
}

async function main() {
  initDatabase();
  seedInitialData();

  const argRole = process.argv.find((a) => a.startsWith('--role='))?.split('=')[1]?.toLowerCase();
  const targets = argRole
    ? PRIVILEGED_ACCOUNTS.filter((acc) => acc.role === argRole)
    : PRIVILEGED_ACCOUNTS;

  if (targets.length === 0) {
    console.error(`Unknown role "${argRole}". Valid roles: admin, moderator, staff.`);
    process.exit(1);
  }

  let provisionedCount = 0;

  for (const spec of targets) {
    const existing = db
      .prepare('SELECT id, username, role FROM users WHERE id = ? OR LOWER(username) = LOWER(?) LIMIT 1')
      .get(spec.userId, spec.username) as { id: string; username: string; role: string } | undefined;

    if (!existing) {
      console.warn(`Skipping ${spec.username} (${spec.role}): account not found.`);
      continue;
    }

    let password = readEnvPassword(spec.envNames);
    if (!password && process.stdin.isTTY) {
      const entered = await promptHidden(
        `Enter new strong password for ${existing.username} (${spec.role}) [leave blank to skip]: `
      );
      if (entered) {
        const confirmed = await promptHidden(`Confirm password for ${existing.username}: `);
        if (entered !== confirmed) {
          console.error(`Passwords did not match for ${existing.username}. Aborting.`);
          process.exit(1);
        }
        password = entered;
      }
    }

    if (!password) {
      console.log(`Skipped ${existing.username} (${spec.role}) — no ${spec.envNames.join('/')} provided.`);
      continue;
    }

    const check = validateStrongPassword(password, [existing.username]);
    if (!check.valid) {
      console.error(`Weak password rejected for ${existing.username}: ${check.error}`);
      process.exit(1);
    }

    const newHash = hashPassword(password);
    db.prepare(`
      UPDATE users
      SET password_hash = ?,
          status = 'active',
          last_reauthenticated_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newHash, existing.id);

    // Clear lockouts & revoke old sessions upon privileged credential rotation
    db.prepare('DELETE FROM login_lockouts WHERE user_id = ? OR LOWER(identifier) = LOWER(?)').run(
      existing.id,
      existing.username
    );
    db.prepare(`
      UPDATE sessions
      SET revoked_at = CURRENT_TIMESTAMP,
          revoked_reason = 'privileged_credential_provisioned'
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(existing.id);

    recordSecurityEvent({
      userId: existing.id,
      eventType: 'PRIVILEGED_CREDENTIAL_PROVISIONED',
      severity: 'warning',
      identifier: existing.username,
      details: { role: existing.role, method: readEnvPassword(spec.envNames) ? 'env' : 'interactive_cli' },
    });

    provisionedCount += 1;
    console.log(`Provisioned strong Argon2id credentials for ${existing.username} (${existing.role}).`);
  }

  checkpointDatabase();
  if (provisionedCount === 0) {
    console.log('No accounts were modified. Provide ADMIN_PASSWORD, MODERATOR_PASSWORD, or STAFF_PASSWORD.');
  }
}

main().catch((err) => {
  console.error('Privileged provisioning failed:', err?.message || err);
  process.exit(1);
});

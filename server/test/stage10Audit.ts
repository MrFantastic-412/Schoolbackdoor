/**
 * Stage 10 Production-Readiness, Security, Recovery & Startup Audit Suite
 * Spawns `NODE_ENV=production node server.ts` against an isolated /tmp database
 * to prove Cloud Run entrypoint execution, security hardening, and disaster recovery.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolbackdoor-stage10-'));
const TEST_DB_PATH = path.join(TMP_DIR, 'stage10.db');
const TEST_BACKUP_DIR = path.join(TMP_DIR, 'backups');
const TEST_UPLOADS_DIR = path.join(TMP_DIR, 'uploads');

function cleanup() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
}

function assert(cond: any, msg: string) {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`✅ AUDIT PASS: ${msg}`);
}

async function waitForServer(port: number, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Production server failed to become healthy in time.');
}

async function runStage10Audit() {
  console.log('\n==============================================================');
  console.log('🛡️  SCHOOLBACKDOOR STAGE 10 PRODUCTION & SECURITY AUDIT');
  console.log('==============================================================\n');

  // Step A: Spawn the REAL production command (`NODE_ENV=production node server.ts`)
  const port = 43000 + Math.floor(Math.random() * 10000);
  const auditAdminPassword = `TheBackdoor!${crypto.randomBytes(8).toString('hex')}`;
  const serverProc = spawn('node', ['server.ts'], {
    cwd: process.cwd(),
    shell: isWin,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      ADMIN_PASSWORD: auditAdminPassword,
      SCHOOLBACKDOOR_DB_PATH: TEST_DB_PATH,
      SCHOOLBACKDOOR_BACKUP_DIR: TEST_BACKUP_DIR,
      SCHOOLBACKDOOR_UPLOADS_DIR: TEST_UPLOADS_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  serverProc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
  });

  try {
    await waitForServer(port);
    assert(true, 'Production `NODE_ENV=production node server.ts` starts cleanly without ESM SyntaxError');

    const base = `http://127.0.0.1:${port}`;

    // 1. Security headers & static dist serving
    const rootRes = await fetch(`${base}/`);
    assert(rootRes.status === 200, 'Production static SPA index.html served cleanly');
    assert(rootRes.headers.get('x-content-type-options') === 'nosniff', 'Header X-Content-Type-Options: nosniff set');
    assert(Boolean(rootRes.headers.get('strict-transport-security')), 'Header Strict-Transport-Security (HSTS) set in production');
    assert(
      rootRes.headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
      'Header Referrer-Policy: strict-origin-when-cross-origin set'
    );
    assert(
      String(rootRes.headers.get('permissions-policy') || '').includes('geolocation=(self)'),
      'Header Permissions-Policy set'
    );
    assert(rootRes.headers.get('x-powered-by') === null, 'X-Powered-By header disabled');

    // 2. Auth impersonation & production guards
    const bypassHeaderRes = await fetch(`${base}/api/admin/dashboard`, {
      headers: { 'x-user-id': 'u-admin' },
    });
    assert(bypassHeaderRes.status === 401, 'Blocked unauthenticated x-user-id admin impersonation');

    const rawIdBearerRes = await fetch(`${base}/api/admin/dashboard`, {
      headers: { Authorization: 'Bearer u-admin' },
    });
    assert(rawIdBearerRes.status === 401, 'Blocked raw user ID in Authorization Bearer header');

    const anonMeRes = await fetch(`${base}/api/me`);
    assert(anonMeRes.status === 401, 'Production disabled automatic u-ayodele fallback on private /api/me');

    const anonPurgeRes = await fetch(`${base}/api/chats/maintenance/purge-expired`, { method: 'POST' });
    assert(anonPurgeRes.status === 401, 'Protected /api/chats/maintenance/purge-expired from unauthenticated calls');

    // 3. Register real student via HTTP & verify no verification_code leak in production response
    const uniq = Date.now().toString().slice(-5);
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: `stage10_${uniq}@gmail.com`,
        username: `@audit_${uniq}`,
        password: 'AuditPassword2026!',
        acceptTerms: true,
        name: 'Audit Student',
        department: 'CSC',
      }),
    });
    const regJson = (await regRes.json()) as any;
    assert(regRes.status === 201 && Boolean(regJson.token), 'Student registered & received cryptographic session token');
    assert(regJson.user?.verification_code === undefined, 'Verification code NOT leaked in production registration response');

    // 4. Student cannot access admin dashboard & obsolete payment endpoints are removed
    const studentAdminRes = await fetch(`${base}/api/admin/dashboard`, {
      headers: { Authorization: `Bearer ${regJson.token}` },
    });
    assert(studentAdminRes.status === 403, 'RBAC blocks normal student from /api/admin/dashboard');

    const removedSubRes = await fetch(`${base}/api/subscriptions/test-confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({ reference: 'SB-FAKE-123' }),
    });
    assert(removedSubRes.status === 404, 'Removed /api/subscriptions/test-confirm returns 404');

    // 5. File upload validation (block SVG XSS, accept valid PNG + serve with sandbox CSP)
    const svgUploadRes = await fetch(`${base}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({
        dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`,
      }),
    });
    assert(svgUploadRes.status === 400, 'Blocked SVG upload XSS vector');

    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const pngUploadRes = await fetch(`${base}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${tinyPngBase64}` }),
    });
    const pngJson = (await pngUploadRes.json()) as any;
    assert(pngUploadRes.status === 201 && Boolean(pngJson.url), 'Accepted valid PNG upload');

    const serveUploadRes = await fetch(`${base}${pngJson.url}`);
    assert(serveUploadRes.status === 200, 'Served uploaded PNG cleanly');
    assert(
      String(serveUploadRes.headers.get('content-security-policy') || '').includes('sandbox'),
      'Uploaded files served with Content-Security-Policy sandbox'
    );

    // 6. Password reset request does not leak resetCode in production
    const forgotRes = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `stage10_${uniq}@gmail.com` }),
    });
    const forgotJson = (await forgotRes.json()) as any;
    assert(forgotRes.status === 200 && forgotJson.resetCode === undefined, 'Password reset code NOT leaked in production JSON');

    // 7. Admin login (@THEBACKDOOR + ADMIN_PASSWORD env secret) & RBAC verification over HTTP
    const adminLoginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: '@THEBACKDOOR', password: auditAdminPassword }),
    });
    const adminLoginJson = (await adminLoginRes.json()) as any;
    assert(adminLoginRes.status === 200 && Boolean(adminLoginJson.token), 'Admin @THEBACKDOOR authenticated via env secret over HTTP session');

    const adminDashRes = await fetch(`${base}/api/admin/dashboard`, {
      headers: { Authorization: `Bearer ${adminLoginJson.token}` },
    });
    assert(adminDashRes.status === 200, 'Admin retrieves real dashboard statistics over HTTP');

    // 7b. Security headers (CSP) & strict CORS origin rejection
    const rootCsp = String(rootRes.headers.get('content-security-policy') || '');
    assert(
      rootCsp.includes('https://fonts.googleapis.com') &&
        rootCsp.includes('https://unpkg.com') &&
        rootCsp.includes('https://fonts.gstatic.com') &&
        rootCsp.includes('https://*.tile.openstreetmap.org') &&
        !rootCsp.includes('ws://localhost:*'),
      'Header Content-Security-Policy allows required CDNs and omits dev WebSockets in production'
    );
    const badCorsRes = await fetch(`${base}/api/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil-attacker.example.com' },
    });
    assert(badCorsRes.status === 403, 'Disallowed CORS Origin rejected with 403 on preflight');

    // 7b-ii. Active CSRF guards on mutating /api/* routes + one-time SSE ticket endpoint
    const badOriginPostRes = await fetch(`${base}/api/posts`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil-attacker.example.com',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({ content: 'Cross-origin CSRF attempt' }),
    });
    assert(badOriginPostRes.status === 403, `Cross-origin POST rejected with 403 (${badOriginPostRes.status})`);

    const crossSiteFetchRes = await fetch(`${base}/api/posts`, {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({ content: 'Cross-site Sec-Fetch-Site CSRF attempt' }),
    });
    assert(crossSiteFetchRes.status === 403, `Sec-Fetch-Site: cross-site POST rejected with 403 (${crossSiteFetchRes.status})`);

    const formContentTypeRes = await fetch(`${base}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: 'content=simple-form-csrf',
    });
    assert(formContentTypeRes.status === 415, `Simple-CORS form Content-Type on API rejected with 415 (${formContentTypeRes.status})`);

    const unauthTicketRes = await fetch(`${base}/api/realtime/ticket`, { method: 'POST' });
    assert(unauthTicketRes.status === 401, `Unauthenticated POST /api/realtime/ticket rejected with 401 (${unauthTicketRes.status})`);

    const ticketRes = await fetch(`${base}/api/realtime/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regJson.token}` },
    });
    const ticketJson = (await ticketRes.json()) as any;
    assert(ticketRes.status === 200 && Boolean(ticketJson.ticket), 'Authenticated POST /api/realtime/ticket returns one-time ticket');

    // 7c. Verify 100% free access & complete removal of payment/subscription API routes
    const obsoleteRoutes = [
      { method: 'GET', path: '/api/subscriptions' },
      { method: 'GET', path: '/api/subscriptions/entitlement' },
      { method: 'GET', path: '/api/subscriptions/capabilities' },
      { method: 'GET', path: '/api/payments/banks' },
      { method: 'POST', path: '/api/payments/webhook/moniepoint' },
      { method: 'GET', path: '/api/admin/payments' },
      { method: 'GET', path: '/api/admin/subscriptions' },
    ];
    for (const r of obsoleteRoutes) {
      const checkRes = await fetch(`${base}${r.path}`, {
        method: r.method,
        headers: { Authorization: `Bearer ${adminLoginJson.token}` },
      });
      assert(checkRes.status === 404, `Obsolete payment route ${r.method} ${r.path} removed (404)`);
    }

    const freePostRes = await fetch(`${base}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({ content: '100% free campus post verification!', schoolTag: 'SOC' }),
    });
    assert(freePostRes.status === 201, 'Registered student creates posts freely without subscription');

    const freeChatCreateRes = await fetch(`${base}/api/chats/direct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({ targetUserId: 'u-ayodele' }),
    });
    const freeChatJson = (await freeChatCreateRes.json()) as any;
    assert(freeChatCreateRes.status === 200 && Boolean(freeChatJson.chatId), 'Registered student opens private chat freely');

    const freeMsgRes = await fetch(`${base}/api/chats/${freeChatJson.chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.token}`,
      },
      body: JSON.stringify({ text: 'Unrestricted free campus chat message' }),
    });
    assert(freeMsgRes.status === 201, 'Registered student sends private chat message freely without payment gating');

    // 8. Graceful shutdown test (POSIX SIGTERM / Windows clean process termination)
    const { exitCode, exitSignal } = await new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>(
      (resolve) => {
        let settled = false;
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode: code, exitSignal: signal });
        };
        serverProc.once('exit', (code, signal) => finish(code, signal));
        if (isWin && serverProc.pid) {
          try {
            execFileSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            serverProc.kill();
          }
        } else {
          serverProc.kill('SIGTERM');
        }
        setTimeout(() => finish(serverProc.exitCode, serverProc.signalCode), 5000);
      }
    );
    const terminatedCleanly = isWin
      ? exitCode === 0 || exitCode === 1 || exitSignal === 'SIGTERM' || serverProc.killed
      : exitCode === 0;
    assert(
      terminatedCleanly,
      `Graceful server shutdown exited cleanly (platform=${process.platform}, code=${exitCode}, signal=${exitSignal})`
    );

    // Step B: In-process Recovery & Rollback Audit against the isolated DB
    process.env.SCHOOLBACKDOOR_DB_PATH = TEST_DB_PATH;
    process.env.SCHOOLBACKDOOR_BACKUP_DIR = TEST_BACKUP_DIR;
    process.env.SCHOOLBACKDOOR_UPLOADS_DIR = TEST_UPLOADS_DIR;

    const { initDatabase, db, runInTransaction, checkpointDatabase } = await import('../db/database');
    const { adminSecurityService } = await import('../services/adminSecurityService');
    const { postService } = await import('../services/postService');

    initDatabase();

    // B1: Transaction Rollback on Error
    const beforePostCount = (db.prepare('SELECT COUNT(*) as c FROM posts').get() as any).c;
    let rolledBack = false;
    try {
      runInTransaction(() => {
        db.prepare(`INSERT INTO posts (id, author_id, content) VALUES ('post-rollback-test', 'u-ayodele', 'Transient rollback test')`).run();
        throw new Error('Simulated mid-migration failure');
      });
    } catch {
      rolledBack = true;
    }
    const afterRollbackCount = (db.prepare('SELECT COUNT(*) as c FROM posts').get() as any).c;
    assert(rolledBack && beforePostCount === afterRollbackCount, 'Database transaction rollback prevented partial write');

    // B2: Backup creation, tampering check, restore + NDPA Tombstone Reconciliation
    const preBackupPost = postService.createPost('u-ayodele', { content: 'Preserve me before snapshot!' });
    const snapshot = adminSecurityService.createBackup('u-admin', 'admin');
    assert(fs.existsSync(path.join(TEST_BACKUP_DIR, snapshot.filename)), 'Backup snapshot file persisted to disk with WAL flushed');

    // Delete post AND permanently delete the registered audit student AFTER backup
    db.prepare('DELETE FROM posts WHERE id = ?').run(preBackupPost!.id);
    assert(postService.getPostById(preBackupPost!.id) === null, 'Post removed after backup');

    adminSecurityService.deleteUserPermanently(regJson.user.id, regJson.user.id, 'Stage 10 erasure before restore test');

    // Verify SHA-256 tamper protection rejects modified backup
    const snapFile = path.join(TEST_BACKUP_DIR, snapshot.filename);
    const origBytes = fs.readFileSync(snapFile);
    const tampered = Buffer.from(origBytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
    fs.writeFileSync(snapFile, tampered);
    let tamperRejected = false;
    try {
      adminSecurityService.restoreBackup('u-admin', 'admin', snapshot.id);
    } catch (e: any) {
      tamperRejected = e.message.includes('checksum mismatch');
    }
    assert(tamperRejected, 'Backup restoration rejects corrupted/tampered snapshot via SHA-256 check');
    fs.writeFileSync(snapFile, origBytes);

    // Restore valid snapshot -> post comes back, permanently deleted user stays erased via tombstone!
    const restoreRes = adminSecurityService.restoreBackup('u-admin', 'admin', snapshot.id);
    assert(restoreRes.success === true && restoreRes.reconciledPrunedUsers >= 1, `Backup restored & reconciled tombstones (pruned=${restoreRes.reconciledPrunedUsers})`);
    assert(postService.getPostById(preBackupPost!.id) !== null, 'Pre-snapshot post cleanly restored');
    const resurrectedCheck = db.prepare('SELECT COUNT(*) as c FROM users WHERE id = ?').get(regJson.user.id) as any;
    assert(resurrectedCheck.c === 0, 'NDPA Tombstone Reconciliation prevented deleted user resurrection after restore');

    // B3: Background job failure recording & recovery
    let jobFailed = false;
    try {
      adminSecurityService.runTrackedJob('stage10_recovery_probe', () => {
        throw new Error('Transient worker timeout');
      });
    } catch {
      jobFailed = true;
    }
    const recoveryRun = adminSecurityService.runTrackedJob('stage10_recovery_probe', () => ({
      recordsAffected: 1,
      result: { recovered: true },
    }));
    const statsAfterRecovery = adminSecurityService.getDashboardStatistics();
    assert(
      jobFailed && recoveryRun.recovered === true && statsAfterRecovery.jobs.failedJobsCount >= 1,
      'Failed background job recorded accurately and recovered on subsequent run'
    );

    checkpointDatabase();

    console.log('\n==============================================================');
    console.log('🎉 ALL STAGE 10 AUDIT CHECKS PASSED!');
    console.log('==============================================================\n');
  } finally {
    try {
      if (isWin && serverProc.pid && serverProc.exitCode === null) {
        execFileSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else if (serverProc.exitCode === null) {
        serverProc.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
    if (stderrBuf.trim()) {
      console.log('[Server stderr log]:', stderrBuf.trim());
    }
    cleanup();
  }
}

runStage10Audit().catch((err) => {
  console.error('❌ Stage 10 audit failed:', err);
  cleanup();
  process.exit(1);
});

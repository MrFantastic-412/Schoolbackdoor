/**
 * Isolated Stage 9 Load Test Harness for Schoolbackdoor
 * Tests 100, 500, and 1,000 concurrent virtual users against an isolated Express + temporary SQLite DB.
 * Usage: npx tsx server/test/loadTest.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// Configure completely isolated temporary database and backup paths before importing app modules
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolbackdoor-loadtest-'));
const TEST_DB_PATH = path.join(TMP_DIR, 'loadtest.db');
const TEST_BACKUP_DIR = path.join(TMP_DIR, 'backups');
process.env.SCHOOLBACKDOOR_DB_PATH = TEST_DB_PATH;
process.env.SCHOOLBACKDOOR_BACKUP_DIR = TEST_BACKUP_DIR;

interface VirtualUser {
  id: string;
  token: string;
  clientId: string;
  chatId: string;
}

interface StageResult {
  concurrency: number;
  durationMs: number;
  totalRequests: number;
  errors: number;
  errorRatePercent: number;
  rps: number;
  latencyMs: {
    min: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  sseConnected: number;
  sseFailed: number;
  sseMessagesSent: number;
  sseMessagesReceived: number;
  sseAvgDeliveryMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssMb: number;
  heapUsedMb: number;
  bytesSent: number;
  bytesReceived: number;
  reportedOnlineUsers: number;
  cacheHitRatePercent: number;
  dbLatencyMs: number;
  walSizeKb: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(2));
}

function httpRequest(
  agent: http.Agent,
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string>,
  bodyStr?: string
): Promise<{ status: number; latencyMs: number; bytesSent: number; bytesReceived: number; json?: any }> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const reqHeaders: Record<string, string | number> = {
      'Accept-Encoding': 'gzip',
      ...headers,
    };
    let bytesSent = reqPath.length + 120;
    if (bodyStr) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
      bytesSent += Buffer.byteLength(bodyStr);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        agent,
        headers: reqHeaders,
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          const raw = Buffer.concat(chunks);
          let parsed: any = undefined;
          try {
            const plain =
              res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw;
            parsed = JSON.parse(plain.toString('utf8'));
          } catch {
            // ignore non-json
          }
          resolve({
            status: res.statusCode || 500,
            latencyMs,
            bytesSent,
            bytesReceived: raw.length,
            json: parsed,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', () => {
      const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      resolve({ status: 0, latencyMs, bytesSent, bytesReceived: 0 });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function openSseStream(
  port: number,
  token: string,
  clientId: string,
  onEvent: (event: string, data: any) => void
): Promise<{ close: () => void; connected: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/realtime/stream?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        let buffer = '';
        if (!settled) {
          settled = true;
          resolve({
            connected: res.statusCode === 200,
            close: () => {
              try {
                req.destroy();
              } catch {
                // ignore
              }
            },
          });
        }

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (const frame of parts) {
            if (!frame.trim() || frame.startsWith(':')) continue;
            const lines = frame.split('\n');
            let evName = 'message';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event:')) evName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (dataStr) {
              try {
                onEvent(evName, JSON.parse(dataStr));
              } catch {
                // ignore
              }
            }
          }
        });
      }
    );

    req.on('error', () => {
      if (!settled) {
        settled = true;
        resolve({ connected: false, close: () => {} });
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          req.destroy();
        } catch {
          // ignore
        }
        resolve({ connected: false, close: () => {} });
      }
    }, 8000);
  });
}

async function runLoadTest() {
  const express = (await import('express')).default;
  const { initDatabase, db, runInTransaction, checkpointDatabase } = await import('../db/database');
  const { seedInitialData } = await import('../db/seed');
  const { apiRouter } = await import('../routes/api');
  const { adminSecurityService } = await import('../services/adminSecurityService');
  const { sseManager } = await import('../realtime/sseManager');
  const { cache } = await import('../utils/cache');

  console.log('\n==============================================================');
  console.log('🚀 SCHOOLBACKDOOR STAGE 9 ISOLATED LOAD TEST (100 / 500 / 1000)');
  console.log(`📁 Isolated Temp DB: ${TEST_DB_PATH}`);
  console.log('==============================================================\n');

  initDatabase();
  seedInitialData();

  // Seed 1,000 synthetic students + sessions + 150 posts + 300 comments + 500 direct chat pairs
  console.log('[Setup] Seeding 1,000 synthetic student sessions, posts, and chats...');
  const virtualUsers: VirtualUser[] = [];
  const adminToken = crypto.randomBytes(24).toString('hex');

  runInTransaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO sessions (token, user_id, expires_at)
      VALUES (?, 'u-admin', datetime('now', '+7 days'))
    `).run(adminToken);

    const insertUser = db.prepare(`
      INSERT INTO users (id, matric_number, email, username, password_hash, role, status, is_verified)
      VALUES (?, ?, ?, ?, 'loadtest_hash', 'student', 'active', 1)
    `);
    const insertProfile = db.prepare(`
      INSERT INTO user_profiles (
        id, user_id, name, handle, department, school, level, hall_of_residence,
        campus, bio, avatar_initials, avatar_bg, verified, show_online_status
      ) VALUES (?, ?, ?, ?, 'CSC', 'SOC', '300L', 'Abiola Hall', 'Obanla', 'Load test user', 'LT', 'bg-stone-800 text-stone-100', 1, 1)
    `);
    const insertSession = db.prepare(`
      INSERT INTO sessions (token, user_id, expires_at)
      VALUES (?, ?, datetime('now', '+7 days'))
    `);

    for (let i = 0; i < 1000; i++) {
      const uid = `u-load-${i}`;
      const handle = `@loadstudent_${i}`;
      const token = `tok-load-${i}-${crypto.randomBytes(8).toString('hex')}`;
      insertUser.run(uid, `CSC/22/${String(1000 + i)}`, `load_${i}@futa.edu.ng`, handle);
      insertProfile.run(`p-load-${i}`, uid, `Student ${i}`, handle);
      insertSession.run(token, uid);

      virtualUsers.push({
        id: uid,
        token,
        clientId: `load-cli-${i}`,
        chatId: `chat-load-${Math.floor(i / 2)}`,
      });
    }

    // Create 500 pairwise direct chats for message delivery benchmarks
    const insertChat = db.prepare(`
      INSERT INTO chats (id, type, title, handle, subtitle, avatar_initials, avatar_bg, last_message)
      VALUES (?, 'direct', 'Load Chat', '@load', 'Direct', 'LC', 'bg-stone-800 text-stone-100', 'Ready')
    `);
    const insertPart = db.prepare(`
      INSERT INTO chat_participants (id, chat_id, user_id, role) VALUES (?, ?, ?, 'member')
    `);

    for (let p = 0; p < 500; p++) {
      const chatId = `chat-load-${p}`;
      insertChat.run(chatId);
      insertPart.run(`cp-load-${p}-a`, chatId, virtualUsers[p * 2].id);
      insertPart.run(`cp-load-${p}-b`, chatId, virtualUsers[p * 2 + 1].id);
    }

    // Create 150 posts + 300 comments
    const insertPost = db.prepare(`
      INSERT INTO posts (id, author_id, content, school_tag, likes_count, comments_count, is_pinned)
      VALUES (?, ?, ?, ?, 3, 2, 0)
    `);
    const insertComment = db.prepare(`
      INSERT INTO comments (id, post_id, author_id, content) VALUES (?, ?, ?, ?)
    `);

    for (let k = 0; k < 150; k++) {
      const pid = `post-load-${k}`;
      const tag = k % 2 === 0 ? 'SOC' : 'SEET';
      insertPost.run(pid, virtualUsers[k].id, `Campus dispatch update #${k} for FUTA ${tag}.`, tag);
      insertComment.run(`c-load-${k}-1`, pid, virtualUsers[k + 1].id, `Reply 1 on dispatch ${k}`);
      insertComment.run(`c-load-${k}-2`, pid, virtualUsers[k + 2].id, `Reply 2 on dispatch ${k}`);
    }
  });

  // Start isolated Express server with gzip compression matching production server.ts
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    if (req.path.includes('/realtime/stream')) return next();
    const accept = String(req.headers['accept-encoding'] || '');
    if (!accept.includes('gzip')) return next();
    const origJson = res.json.bind(res);
    res.json = (body: any) => {
      const s = JSON.stringify(body);
      if (Buffer.byteLength(s) < 1024) return origJson(body);
      const gz = zlib.gzipSync(s, { level: zlib.constants.Z_BEST_SPEED });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', gz.length);
      return res.send(gz);
    };
    next();
  });
  app.use('/api', apiRouter);

  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  server.maxConnections = 5000;

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  console.log(`[Setup] Isolated test server listening on http://127.0.0.1:${port}\n`);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1200 });
  const results: StageResult[] = [];

  for (const concurrency of [100, 500, 1000]) {
    db.prepare('DELETE FROM user_presence_clients').run();
    db.prepare('DELETE FROM user_presence').run();
    cache.clear();

    const cohort = virtualUsers.slice(0, concurrency);
    const latencies: number[] = [];
    let errors = 0;
    let bytesSent = 0;
    let bytesReceived = 0;

    // Track real-time SSE message delivery timestamps
    const pendingDelivery = new Map<string, number>();
    const deliveryLatencies: number[] = [];
    let sseMessagesReceived = 0;

    const cpuStart = process.cpuUsage();
    const stageStart = Date.now();

    // Open concurrent SSE connections in controlled waves (avoid single-tick SYN burst dropping sockets)
    const sseHandles: Array<{ close: () => void; connected: boolean }> = [];
    const waveSize = 100;
    for (let i = 0; i < cohort.length; i += waveSize) {
      const slice = cohort.slice(i, i + waveSize);
      const handles = await Promise.all(
        slice.map((u) =>
          openSseStream(port, u.token, u.clientId, (ev, data) => {
            if (ev === 'message:new' && data?.clientId) {
              const sentAt = pendingDelivery.get(data.clientId);
              if (sentAt) {
                deliveryLatencies.push(Date.now() - sentAt);
                pendingDelivery.delete(data.clientId);
                sseMessagesReceived++;
              }
            }
          })
        )
      );
      sseHandles.push(...handles);
    }

    const sseConnected = sseHandles.filter((h) => h.connected).length;
    const sseFailed = sseHandles.length - sseConnected;

    // Run concurrent user activity wave: Heartbeat + Online Check + Paginated Feed + Landmarks + Chat Delivery
    let sseMessagesSent = 0;

    await Promise.all(
      cohort.map(async (u, idx) => {
        const authHdr = { Authorization: `Bearer ${u.token}` };

        // 1. Presence heartbeat
        const hb = await httpRequest(
          agent,
          port,
          'POST',
          '/api/presence/heartbeat',
          authHdr,
          JSON.stringify({ clientId: u.clientId })
        );
        latencies.push(hb.latencyMs);
        bytesSent += hb.bytesSent;
        bytesReceived += hb.bytesReceived;
        if (hb.status < 200 || hb.status >= 300) errors++;

        // 2. Paginated feed fetch
        const feed = await httpRequest(
          agent,
          port,
          'GET',
          `/api/posts?paginated=1&limit=15&offset=${(idx % 3) * 15}`,
          authHdr
        );
        latencies.push(feed.latencyMs);
        bytesSent += feed.bytesSent;
        bytesReceived += feed.bytesReceived;
        if (feed.status < 200 || feed.status >= 300) errors++;

        // 3. Online counter + Landmarks read
        const onl = await httpRequest(agent, port, 'GET', '/api/presence/online', authHdr);
        latencies.push(onl.latencyMs);
        bytesSent += onl.bytesSent;
        bytesReceived += onl.bytesReceived;
        if (onl.status < 200 || onl.status >= 300) errors++;

        // 4. Even-indexed users inside first 100 pairs send real chat messages to odd partners via SSE
        if (idx % 2 === 0 && idx < Math.min(concurrency, 200)) {
          const clientMsgId = `lt-msg-${concurrency}-${idx}`;
          pendingDelivery.set(clientMsgId, Date.now());
          sseMessagesSent++;
          const msgRes = await httpRequest(
            agent,
            port,
            'POST',
            `/api/chats/${u.chatId}/messages`,
            authHdr,
            JSON.stringify({ text: `Load ping ${idx}`, client_id: clientMsgId })
          );
          latencies.push(msgRes.latencyMs);
          bytesSent += msgRes.bytesSent;
          bytesReceived += msgRes.bytesReceived;
          if (msgRes.status < 200 || msgRes.status >= 300) errors++;
        }
      })
    );

    // Allow remaining SSE events briefly to flush
    await new Promise((r) => setTimeout(r, 250));

    // Fetch live online summary and admin dashboard telemetry under load
    const onlineCheck = await httpRequest(agent, port, 'GET', '/api/presence/online', {});
    const adminStats = await httpRequest(
      agent,
      port,
      'GET',
      '/api/admin/dashboard',
      { Authorization: `Bearer ${adminToken}` }
    );

    const durationMs = Date.now() - stageStart;
    const cpuDelta = process.cpuUsage(cpuStart);
    const mem = process.memoryUsage();
    latencies.sort((a, b) => a - b);

    const avgLatency =
      latencies.length > 0
        ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2))
        : 0;

    const avgSseDelivery =
      deliveryLatencies.length > 0
        ? Number((deliveryLatencies.reduce((a, b) => a + b, 0) / deliveryLatencies.length).toFixed(2))
        : 0;

    let walBytes = 0;
    try {
      walBytes = fs.statSync(`${TEST_DB_PATH}-wal`).size;
    } catch {
      walBytes = 0;
    }

    const stageSummary: StageResult = {
      concurrency,
      durationMs,
      totalRequests: latencies.length,
      errors,
      errorRatePercent: latencies.length > 0 ? Number(((errors / latencies.length) * 100).toFixed(2)) : 0,
      rps: Number(((latencies.length / Math.max(1, durationMs)) * 1000).toFixed(1)),
      latencyMs: {
        min: Number((latencies[0] || 0).toFixed(2)),
        avg: avgLatency,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: Number((latencies[latencies.length - 1] || 0).toFixed(2)),
      },
      sseConnected,
      sseFailed,
      sseMessagesSent,
      sseMessagesReceived,
      sseAvgDeliveryMs: avgSseDelivery,
      cpuUserMs: Math.round(cpuDelta.user / 1000),
      cpuSystemMs: Math.round(cpuDelta.system / 1000),
      rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
      heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
      bytesSent,
      bytesReceived,
      reportedOnlineUsers: Number(onlineCheck.json?.onlineCount || 0),
      cacheHitRatePercent: Number(adminStats.json?.system?.cacheHitRatePercent || 0),
      dbLatencyMs: Number(adminStats.json?.system?.dbLatencyMs || 0),
      walSizeKb: Number((walBytes / 1024).toFixed(1)),
    };

    results.push(stageSummary);

    console.log(`--- Concurrency Stage: ${concurrency} Concurrent Users ---`);
    console.log(
      `Requests: ${stageSummary.totalRequests} | Errors: ${stageSummary.errors} (${stageSummary.errorRatePercent}%) | Throughput: ${stageSummary.rps} req/s | Duration: ${stageSummary.durationMs}ms`
    );
    console.log(
      `Latency (ms): min=${stageSummary.latencyMs.min} avg=${stageSummary.latencyMs.avg} p50=${stageSummary.latencyMs.p50} p95=${stageSummary.latencyMs.p95} p99=${stageSummary.latencyMs.p99} max=${stageSummary.latencyMs.max}`
    );
    console.log(
      `SSE Streams: ${stageSummary.sseConnected}/${concurrency} connected | Msg Delivery: ${stageSummary.sseMessagesReceived}/${stageSummary.sseMessagesSent} (avg ${stageSummary.sseAvgDeliveryMs}ms)`
    );
    console.log(
      `Presence Online Count: ${stageSummary.reportedOnlineUsers} | Cache Hit Rate: ${stageSummary.cacheHitRatePercent}% | DB Query Latency: ${stageSummary.dbLatencyMs}ms | WAL: ${stageSummary.walSizeKb} KB`
    );
    console.log(
      `CPU (user/sys): ${stageSummary.cpuUserMs}ms / ${stageSummary.cpuSystemMs}ms | Memory (RSS/Heap): ${stageSummary.rssMb} / ${stageSummary.heapUsedMb} MB | Network TX/RX: ${(stageSummary.bytesSent / 1024).toFixed(1)} KB / ${(stageSummary.bytesReceived / 1024).toFixed(1)} KB\n`
    );

    // Tear down SSE sockets cleanly before next tier
    for (const h of sseHandles) h.close();
    await new Promise((r) => setTimeout(r, 150));
  }

  // Verify admin statistics integrity without throwing
  const finalStats = adminSecurityService.getDashboardStatistics();
  console.log('==============================================================');
  console.log('📊 LOAD TEST SUMMARY & HOSTING CAPACITY REPORT');
  console.log(`Peak Tested Concurrency: 1,000 simultaneous authenticated SSE + HTTP users`);
  console.log(`Registered Users in Isolated DB: ${finalStats.users.total}`);
  console.log('==============================================================\n');

  agent.destroy();
  sseManager.closeAllClients();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  checkpointDatabase();

  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }

  process.exit(0);
}

runLoadTest().catch((err) => {
  console.error('❌ Load test failed:', err);
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(1);
});

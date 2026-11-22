/**
 * Production Build, Bundle Chunking, HTTP Compression, Cache Isolation,
 * Latency (TTFB) & Optional Lighthouse Audit Script.
 *
 * Usage: npx tsx server/test/lighthouseAudit.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';

interface ChunkSummary {
  file: string;
  sizeBytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const npxCmd = isWin ? 'npx.cmd' : 'npx';
const locatorCmd = isWin ? 'where' : 'which';

function findChromeBinary(): string | null {
  const candidates = ['google-chrome', 'chromium', 'chromium-browser', 'chrome'];
  for (const bin of candidates) {
    try {
      const resolved = execFileSync(locatorCmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .split(/\r?\n/)[0]
        ?.trim();
      if (resolved) return resolved;
    } catch {
      // ignore missing binary
    }
  }
  return null;
}

function findLighthouseBinary(): string | null {
  const localBin = path.resolve(process.cwd(), 'node_modules/.bin', isWin ? 'lighthouse.cmd' : 'lighthouse');
  if (fs.existsSync(localBin)) return localBin;
  try {
    const resolved = execFileSync(locatorCmd, ['lighthouse'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)[0]
      ?.trim();
    if (resolved) return resolved;
  } catch {
    // ignore missing binary
  }
  return null;
}

async function rawRequest(
  port: number,
  reqPath: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  rawBytes: number;
  decodedText: string;
  ttfbMs: number;
}> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string | number> = {
      ...(opts.headers || {}),
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: opts.method || 'GET',
        headers,
        timeout: opts.timeoutMs ?? 10000,
      },
      (res) => {
        let firstByteAt: bigint | null = null;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (firstByteAt === null) firstByteAt = process.hrtime.bigint();
          chunks.push(chunk);
        });
        res.on('end', () => {
          const end = firstByteAt ?? process.hrtime.bigint();
          const ttfbMs = Number(end - start) / 1e6;
          const rawBuf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          let decodedBuf = rawBuf;
          try {
            if (enc === 'br' && rawBuf.length > 0) {
              decodedBuf = zlib.brotliDecompressSync(rawBuf);
            } else if (enc === 'gzip' && rawBuf.length > 0) {
              decodedBuf = zlib.gunzipSync(rawBuf);
            }
          } catch {
            decodedBuf = rawBuf;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            rawBytes: rawBuf.length,
            decodedText: decodedBuf.toString('utf8'),
            ttfbMs,
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout requesting ${reqPath}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not obtain ephemeral port')));
      }
    });
    srv.on('error', reject);
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(2));
}

async function main() {
  console.log('\n======================================================');
  console.log('⚡ SCHOOLBACKDOOR BUILD, COMPRESSION, CACHE & LIGHTHOUSE AUDIT');
  console.log('======================================================\n');

  // 1. Run real production Vite build
  console.log('--- 1. Running Production Build (`npm run build`) ---');
  execFileSync(npmCmd, ['run', 'build'], { stdio: 'inherit', shell: isWin });

  const distDir = path.resolve(process.cwd(), 'dist');
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error('dist/assets directory missing after npm run build');
  }

  const assetFiles = fs.readdirSync(assetsDir);
  const jsChunks: ChunkSummary[] = [];
  const cssChunks: ChunkSummary[] = [];
  const sourceMaps = assetFiles.filter((f) => f.endsWith('.map'));

  for (const file of assetFiles) {
    const fullPath = path.join(assetsDir, file);
    if (!fs.statSync(fullPath).isFile()) continue;
    const raw = fs.readFileSync(fullPath);
    const summary: ChunkSummary = {
      file,
      sizeBytes: raw.length,
      gzipBytes: zlib.gzipSync(raw).length,
      brotliBytes: zlib.brotliCompressSync(raw).length,
    };
    if (file.endsWith('.js')) jsChunks.push(summary);
    else if (file.endsWith('.css')) cssChunks.push(summary);
  }

  jsChunks.sort((a, b) => b.sizeBytes - a.sizeBytes);
  cssChunks.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const totalJsBytes = jsChunks.reduce((acc, c) => acc + c.sizeBytes, 0);
  const totalCssBytes = cssChunks.reduce((acc, c) => acc + c.sizeBytes, 0);
  const leafletChunk = assetFiles.find((f) => f.includes('vendor-leaflet'));

  console.log(`Source maps emitted: ${sourceMaps.length}`);
  console.log(`Leaflet split chunk present: ${leafletChunk || 'MISSING'}`);
  console.log(`JS Chunks (${jsChunks.length}, total ${formatKb(totalJsBytes)}):`);
  for (const c of jsChunks) {
    console.log(
      `  - ${c.file}: raw ${formatKb(c.sizeBytes)} | gzip ${formatKb(c.gzipBytes)} | br ${formatKb(c.brotliBytes)}`
    );
  }
  console.log(`CSS Chunks (${cssChunks.length}, total ${formatKb(totalCssBytes)}):`);
  for (const c of cssChunks) {
    console.log(
      `  - ${c.file}: raw ${formatKb(c.sizeBytes)} | gzip ${formatKb(c.gzipBytes)} | br ${formatKb(c.brotliBytes)}`
    );
  }

  if (sourceMaps.length !== 0) {
    throw new Error(`Expected 0 production source maps, found ${sourceMaps.length}`);
  }
  if (!leafletChunk) {
    throw new Error('Expected vendor-leaflet code-split chunk in dist/assets');
  }

  // 2. Boot production server on an ephemeral port with isolated storage
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lighthouse-audit-'));
  const port = await getFreePort();
  const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin', isWin ? 'tsx.cmd' : 'tsx');
  const child = spawn(
    fs.existsSync(tsxBin) ? tsxBin : npxCmd,
    fs.existsSync(tsxBin) ? ['server.ts'] : ['tsx', 'server.ts'],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        SCHOOLBACKDOOR_DB_PATH: path.join(tmpDir, 'audit.db'),
        SCHOOLBACKDOOR_BACKUP_DIR: path.join(tmpDir, 'backups'),
        SCHOOLBACKDOOR_UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      },
      detached: !isWin,
      shell: isWin,
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );

  const cleanup = async () => {
    try {
      if (child.pid) {
        if (isWin) {
          try {
            execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            if (!child.killed) child.kill();
          }
          await new Promise((r) => setTimeout(r, 300));
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          await new Promise((r) => setTimeout(r, 400));
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            if (!child.killed) child.kill('SIGKILL');
          }
        }
      }
    } catch {
      // ignore already-exited child
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  };

  try {
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await rawRequest(port, '/api/health', { timeoutMs: 1500 });
        if (res.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!healthy) {
      throw new Error('Production server failed to become healthy within 10s');
    }

    // 3. Measure HTTP compression, cache headers, ETags & SSE non-buffering
    console.log('\n--- 2. HTTP Compression, CDN/Cache Headers & Latency Audit ---');
    const healthRes = await rawRequest(port, '/api/health', { headers: { 'Accept-Encoding': 'br' } });
    const healthJson = JSON.parse(healthRes.decodedText);
    console.log(
      `/api/health => status=${healthRes.status}, poolMax=${healthJson?.dbPool?.maxConnections}, poolOpen=${healthJson?.dbPool?.openConnections}, scaling=${JSON.stringify(
        healthJson?.scaling
      )}`
    );

    const landmarksBr = await rawRequest(port, '/api/landmarks', {
      headers: { 'Accept-Encoding': 'br' },
    });
    const landmarksGzip = await rawRequest(port, '/api/landmarks', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const landmarksIdentity = await rawRequest(port, '/api/landmarks', {
      headers: { 'Accept-Encoding': 'identity' },
    });
    const etag = String(landmarksBr.headers.etag || '');
    const landmarks304 = await rawRequest(port, '/api/landmarks', {
      headers: { 'If-None-Match': etag },
    });

    console.log(
      `/api/landmarks => identity=${landmarksIdentity.rawBytes}B | gzip=${landmarksGzip.rawBytes}B (${landmarksGzip.headers['content-encoding']}) | br=${landmarksBr.rawBytes}B (${landmarksBr.headers['content-encoding']}) | 304=${landmarks304.status}`
    );
    console.log(
      `/api/landmarks headers => Cache-Control="${landmarksBr.headers['cache-control']}" | CDN-Cache-Control="${landmarksBr.headers['cdn-cache-control']}"`
    );

    if (landmarksBr.headers['content-encoding'] !== 'br' || landmarksGzip.headers['content-encoding'] !== 'gzip') {
      throw new Error('Expected br/gzip compression on /api/landmarks');
    }
    if (landmarks304.status !== 304) {
      throw new Error(`Expected 304 Not Modified on ETag match, got ${landmarks304.status}`);
    }

    // Register a student user to inspect authenticated private endpoint headers
    const uniq = Date.now();
    const regRes = await rawRequest(port, '/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Audit Student',
        username: `@audit_${uniq}`,
        identifier: `audit_${uniq}@gmail.com`,
        department: 'Computer Science',
        level: '300L',
        hallOfResidence: 'Abiola Hall',
        password: 'StrongAuditPassword!99',
        acceptTerms: true,
      },
    });
    if (regRes.status !== 201) {
      throw new Error(`Failed registering audit user: HTTP ${regRes.status} ${regRes.decodedText}`);
    }
    const token = JSON.parse(regRes.decodedText).token as string;

    const meRes = await rawRequest(port, '/api/me', {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'br' },
    });
    const chatsRes = await rawRequest(port, '/api/chats', {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'br' },
    });
    const notifsRes = await rawRequest(port, '/api/notifications?paginated=1&limit=10', {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(
      `/api/me Cache-Control="${meRes.headers['cache-control']}" | CDN-Cache-Control="${meRes.headers['cdn-cache-control']}"`
    );
    console.log(
      `/api/chats Cache-Control="${chatsRes.headers['cache-control']}" | CDN-Cache-Control="${chatsRes.headers['cdn-cache-control']}"`
    );
    if (!String(meRes.headers['cache-control']).includes('no-store') || meRes.headers['cdn-cache-control'] !== 'no-store') {
      throw new Error('Private /api/me must enforce private no-store cache headers');
    }
    if (!String(chatsRes.headers['cache-control']).includes('no-store') || chatsRes.headers['cdn-cache-control'] !== 'no-store') {
      throw new Error('Private /api/chats must enforce private no-store cache headers');
    }
    if (!JSON.parse(notifsRes.decodedText).notifications) {
      throw new Error('Expected paginated notifications payload');
    }

    // Static asset & index.html cache headers
    const firstJs = jsChunks[0]?.file;
    const jsAssetRes = await rawRequest(port, `/assets/${firstJs}`, {
      headers: { 'Accept-Encoding': 'br' },
    });
    const indexRes = await rawRequest(port, '/', {
      headers: { 'Accept-Encoding': 'br' },
    });
    console.log(
      `/assets/${firstJs} => status=${jsAssetRes.status} Cache-Control="${jsAssetRes.headers['cache-control']}"`
    );
    console.log(`/ => status=${indexRes.status} Cache-Control="${indexRes.headers['cache-control']}"`);

    if (!String(jsAssetRes.headers['cache-control']).includes('immutable')) {
      throw new Error('Expected immutable Cache-Control on /assets/*');
    }
    if (!String(indexRes.headers['cache-control']).includes('no-cache')) {
      throw new Error('Expected no-cache Cache-Control on index.html');
    }
    const indexCsp = String(indexRes.headers['content-security-policy'] || '');
    if (
      indexRes.headers['x-content-type-options'] !== 'nosniff' ||
      !indexRes.headers['strict-transport-security'] ||
      indexRes.headers['referrer-policy'] !== 'strict-origin-when-cross-origin' ||
      !indexRes.headers['permissions-policy'] ||
      !indexCsp.includes('https://unpkg.com') ||
      !indexCsp.includes('https://fonts.googleapis.com') ||
      !indexCsp.includes('https://fonts.gstatic.com') ||
      !indexCsp.includes('https://*.tile.openstreetmap.org') ||
      indexCsp.includes('ws://localhost:*')
    ) {
      throw new Error('Production security/CSP headers on / failed verification');
    }

    // Check SSE stream does not set Content-Encoding
    const sseHeaders = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/realtime/stream',
          headers: {
            Authorization: `Bearer ${token}`,
            'Accept-Encoding': 'br, gzip',
          },
          timeout: 3000,
        },
        (res) => {
          const hdrs = res.headers;
          res.destroy();
          req.destroy();
          resolve(hdrs);
        }
      );
      req.on('error', reject);
    });
    console.log(
      `/api/realtime/stream => Content-Type="${sseHeaders['content-type']}" | Content-Encoding="${
        sseHeaders['content-encoding'] || 'none'
      }"`
    );
    if (sseHeaders['content-encoding']) {
      throw new Error('SSE stream must never be buffered/compressed');
    }

    // 10-iteration TTFB check across core routes
    const routesToBenchmark = [
      { label: 'GET /', path: '/', auth: false },
      { label: 'GET /api/posts?paginated=1', path: '/api/posts?paginated=1&limit=15&offset=0', auth: false },
      { label: 'GET /api/landmarks', path: '/api/landmarks', auth: false },
      { label: 'GET /api/notices', path: '/api/notices', auth: false },
      { label: 'GET /api/me', path: '/api/me', auth: true },
    ];

    console.log('\n--- 3. Endpoint TTFB Benchmark (10 iterations per route) ---');
    for (const r of routesToBenchmark) {
      const samples: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await rawRequest(port, r.path, {
          headers: {
            'Accept-Encoding': 'br',
            ...(r.auth ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.status !== 200) {
          throw new Error(`Benchmark request ${r.label} returned HTTP ${res.status}`);
        }
        samples.push(res.ttfbMs);
      }
      console.log(
        `  ${r.label.padEnd(28)} p50=${percentile(samples, 50)}ms | p95=${percentile(samples, 95)}ms`
      );
    }

    // 4. Real Lighthouse CLI check (if Chrome + Lighthouse exist in container)
    console.log('\n--- 4. Lighthouse CLI Audit ---');
    const chromeBin = findChromeBinary();
    const lhBin = findLighthouseBinary();
    if (chromeBin && lhBin) {
      const reportPath = path.join(tmpDir, 'lighthouse-report.json');
      execFileSync(
        lhBin,
        [
          `http://127.0.0.1:${port}/`,
          '--output=json',
          `--output-path=${reportPath}`,
          '--only-categories=performance,accessibility,best-practices,seo',
          `--chrome-path=${chromeBin}`,
          '--chrome-flags=--headless=new --no-sandbox --disable-gpu',
        ],
        { stdio: 'inherit', shell: isWin }
      );
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const cats = report.categories || {};
      const audits = report.audits || {};
      console.log('Lighthouse Category Scores:');
      console.log(`  Performance:    ${Math.round((cats.performance?.score ?? 0) * 100)}`);
      console.log(`  Accessibility:  ${Math.round((cats.accessibility?.score ?? 0) * 100)}`);
      console.log(`  Best Practices: ${Math.round((cats['best-practices']?.score ?? 0) * 100)}`);
      console.log(`  SEO:            ${Math.round((cats.seo?.score ?? 0) * 100)}`);
      console.log(
        `Core Web Vitals: FCP=${audits['first-contentful-paint']?.displayValue}, LCP=${audits['largest-contentful-paint']?.displayValue}, CLS=${audits['cumulative-layout-shift']?.displayValue}, TBT=${audits['total-blocking-time']?.displayValue}`
      );
    } else {
      console.log(
        `Lighthouse binary/Chromium unavailable in container (chrome=${chromeBin || 'none'}, lighthouse=${
          lhBin || 'none'
        }); deterministic HTTP/Asset/Compression/Latency/Cache-Isolation audit completed.`
      );
    }

    console.log('\n✅ Production Build, Compression, Cache Isolation & Latency Audit PASSED.\n');
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('❌ Audit failed:', err);
  process.exit(1);
});

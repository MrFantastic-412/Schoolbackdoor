/**
 * Comprehensive verification suite for Schoolbackdoor Auth, Vercel Serverless Routing,
 * Cross-Origin Cookie/CORS Support, and Safe Frontend JSON Error Handling.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolbackdoor-vercel-auth-'));
const TEST_DB_PATH = path.join(TMP_DIR, 'vercel-auth.db');
const TEST_UPLOADS_DIR = path.join(TMP_DIR, 'uploads');
const TEST_BACKUP_DIR = path.join(TMP_DIR, 'backups');

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.SCHOOLBACKDOOR_DB_PATH = TEST_DB_PATH;
process.env.SCHOOLBACKDOOR_UPLOADS_DIR = TEST_UPLOADS_DIR;
process.env.SCHOOLBACKDOOR_BACKUP_DIR = TEST_BACKUP_DIR;
process.env.ALLOWED_ORIGINS = 'https://schoolbackdoor.vercel.app';
process.env.ADMIN_PASSWORD = 'AuditAdminPassword2026!';

function pass(label: string) {
  console.log(`✅ PASS: ${label}`);
}

function cleanup() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup issues
  }
}

async function runTests() {
  console.log('\n==============================================================');
  console.log('🔐  SCHOOLBACKDOOR VERCEL AUTH & JSON PARSING TEST SUITE');
  console.log('==============================================================\n');

  const { resolveApiBase, parseApiJson } = await import('../../src/api/client');
  const { default: vercelHandler } = await import('../../api/index');
  const { db } = await import('../db/database');

  // 1. Frontend URL resolution & safe JSON parser tests
  assert.equal(resolveApiBase(''), '/api', 'Empty VITE_API_URL resolves to /api');
  assert.equal(
    resolveApiBase('https://api.schoolbackdoor.example/'),
    'https://api.schoolbackdoor.example/api',
    'Origin-only VITE_API_URL appends /api'
  );
  assert.equal(
    resolveApiBase('https://api.schoolbackdoor.example/api/'),
    'https://api.schoolbackdoor.example/api',
    'VITE_API_URL ending with /api does not duplicate /api'
  );
  pass('Frontend resolveApiBase handles relative, origin-only, and /api URLs');

  const vercel404Resp = new Response('The page could not be found\n\nNOT_FOUND', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
  await assert.rejects(
    () => parseApiJson(vercel404Resp, 'Authentication failed.'),
    (err: any) =>
      err instanceof Error &&
      (err as any).code === 'NON_JSON_RESPONSE' &&
      (err as any).status === 404 &&
      err.message.includes('HTTP 404') &&
      !err.message.includes('Unexpected token'),
    'Vercel 404 plaintext produces clean diagnostic error without SyntaxError'
  );
  pass('parseApiJson catches Vercel 404 "The page could not be found" cleanly');

  const html502Resp = new Response('<!DOCTYPE html><html><body>Bad Gateway</body></html>', {
    status: 502,
    headers: { 'Content-Type': 'text/html' },
  });
  await assert.rejects(
    () => parseApiJson(html502Resp, 'Login failed.'),
    (err: any) =>
      err instanceof Error &&
      (err as any).code === 'NON_JSON_RESPONSE' &&
      (err as any).status === 502 &&
      err.message.includes('HTTP 502'),
    'HTML 502 error page produces readable server diagnostic'
  );
  pass('parseApiJson handles 502 HTML responses gracefully');

  const okJsonResp = new Response(JSON.stringify({ success: true, token: 'tok-123' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const okParsed = await parseApiJson(okJsonResp, 'Fallback');
  assert.equal(okParsed.token, 'tok-123');
  pass('parseApiJson parses valid JSON 200 responses');

  const errJsonResp = new Response(
    JSON.stringify({ success: false, error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  );
  await assert.rejects(
    () => parseApiJson(errJsonResp, 'Fallback'),
    (err: any) =>
      err instanceof Error &&
      (err as any).status === 401 &&
      (err as any).code === 'INVALID_CREDENTIALS' &&
      err.message === 'Invalid credentials.',
    'Structured JSON error preserves status, code, and message'
  );
  pass('parseApiJson preserves structured backend error code & status');

  // 2. Mount Vercel serverless handler on local HTTP server
  const server = http.createServer((req, res) => {
    return vercelHandler(req as any, res as any);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const uniq = Date.now().toString().slice(-6);
    const validEmail = `vercelfix_${uniq}@gmail.com`;
    const validUsername = `@verceluser_${uniq}`;
    const validPassword = 'ValidPassword2026!';

    // 2a. Valid signup via Vercel rewrite format (/api/index?__sb_path=/api/auth/register)
    const regRes = await fetch(`${base}/api/index?__sb_path=/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: validEmail,
        email: validEmail,
        username: validUsername,
        password: validPassword,
        acceptTerms: true,
        name: 'Vercel Test Student',
      }),
    });
    assert.equal(regRes.status, 201, 'Valid signup returns HTTP 201');
    assert.ok(
      String(regRes.headers.get('content-type') || '').includes('application/json'),
      'Signup returns application/json Content-Type'
    );
    const regJson = await parseApiJson<any>(regRes, 'Signup failed');
    assert.equal(regJson.success, true);
    assert.ok(regJson.token && regJson.profile?.userId, 'Signup returns token and profile');
    const regCookies = regRes.headers.getSetCookie?.() || [];
    assert.ok(
      regCookies.some((c) => c.startsWith('sb_session=')) &&
        regCookies.some((c) => c.startsWith('sb_refresh=')),
      'Signup sets sb_session and sb_refresh HttpOnly cookies'
    );
    const persistedUser = db
      .prepare('SELECT id, email, username FROM users WHERE LOWER(email) = LOWER(?)')
      .get(validEmail) as any;
    assert.ok(persistedUser?.id === regJson.profile.userId, 'Signup user persisted in SQLite database');
    pass('Signup valid creation + DB persistence + cookies via Vercel serverless rewrite');

    // 2b. Missing fields
    const missingRes = await fetch(`${base}/api/index?__sb_path=/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: validUsername, acceptTerms: true }),
    });
    assert.equal(missingRes.status, 400);
    await assert.rejects(
      () => parseApiJson(missingRes),
      (err: any) => err.code === 'MISSING_FIELDS' && err.status === 400
    );
    pass('Signup rejects missing required fields with 400 MISSING_FIELDS');

    // 2c. Invalid email
    const badEmailRes = await fetch(`${base}/api/index?__sb_path=/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'not-a-gmail@yahoo.com',
        username: `@other_${uniq}`,
        password: validPassword,
        acceptTerms: true,
      }),
    });
    assert.equal(badEmailRes.status, 400);
    await assert.rejects(
      () => parseApiJson(badEmailRes),
      (err: any) => err.code === 'INVALID_EMAIL' && err.status === 400
    );
    pass('Signup rejects invalid email with 400 INVALID_EMAIL');

    // 2d. Duplicate email
    const dupEmailRes = await fetch(`${base}/api/index?__sb_path=/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: validEmail,
        username: `@freshname_${uniq}`,
        password: validPassword,
        acceptTerms: true,
      }),
    });
    assert.equal(dupEmailRes.status, 409);
    await assert.rejects(
      () => parseApiJson(dupEmailRes),
      (err: any) => err.code === 'DUPLICATE_EMAIL' && err.status === 409
    );
    pass('Signup rejects duplicate email with 409 DUPLICATE_EMAIL');

    // 2e. Duplicate username
    const dupUserRes = await fetch(`${base}/api/index?__sb_path=/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `another_${uniq}@gmail.com`,
        username: validUsername,
        password: validPassword,
        acceptTerms: true,
      }),
    });
    assert.equal(dupUserRes.status, 409);
    await assert.rejects(
      () => parseApiJson(dupUserRes),
      (err: any) => err.code === 'DUPLICATE_USERNAME' && err.status === 409
    );
    pass('Signup rejects duplicate username with 409 DUPLICATE_USERNAME');

    // 2f. Weak password
    const weakPwdRes = await fetch(`${base}/api/index?__sb_path=/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `weak_${uniq}@gmail.com`,
        username: `@weak_${uniq}`,
        password: 'password123',
        acceptTerms: true,
      }),
    });
    assert.equal(weakPwdRes.status, 400);
    await assert.rejects(
      () => parseApiJson(weakPwdRes),
      (err: any) => err.code === 'WEAK_PASSWORD' && err.status === 400
    );
    pass('Signup rejects weak password with 400 WEAK_PASSWORD');

    // 3a. Valid login with @username + cross-origin CORS/cookie verification
    const loginUserRes = await fetch(`${base}/api/index?__sb_path=/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://schoolbackdoor.vercel.app',
        'Sec-Fetch-Site': 'cross-site',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ identifier: validUsername, password: validPassword }),
    });
    assert.equal(loginUserRes.status, 200);
    assert.equal(
      loginUserRes.headers.get('access-control-allow-origin'),
      'https://schoolbackdoor.vercel.app'
    );
    assert.equal(loginUserRes.headers.get('access-control-allow-credentials'), 'true');
    const crossCookies = loginUserRes.headers.getSetCookie?.() || [];
    assert.ok(
      crossCookies.some((c) => c.includes('SameSite=None') && c.includes('Secure')),
      'Cross-origin HTTPS login sets SameSite=None; Secure cookies'
    );
    const loginUserJson = await parseApiJson<any>(loginUserRes, 'Login failed');
    assert.equal(loginUserJson.success, true);
    assert.equal(loginUserJson.profile.handle, validUsername);
    pass('Valid @username login + cross-origin CORS/SameSite=None cookies');

    // 3b. Valid login with Gmail + session persistence check via cookie (/api/me)
    const loginEmailRes = await fetch(`${base}/api/index?__sb_path=/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: validEmail, password: validPassword }),
    });
    assert.equal(loginEmailRes.status, 200);
    const cookieHeader = (loginEmailRes.headers.getSetCookie?.() || [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const loginEmailJson = await parseApiJson<any>(loginEmailRes, 'Email login failed');
    assert.equal(loginEmailJson.success, true);

    const meRes = await fetch(`${base}/api/index?__sb_path=/api/me`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(meRes.status, 200);
    const meJson = await parseApiJson<any>(meRes);
    assert.equal(meJson.success, true);
    assert.equal(meJson.profile.userId, persistedUser.id);
    pass('Valid Gmail login + cookie session persists across /api/me reload check');

    // 3c. Refresh token rotation
    const refreshRes = await fetch(`${base}/api/index?__sb_path=/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
    });
    assert.equal(refreshRes.status, 200);
    const refreshJson = await parseApiJson<any>(refreshRes);
    assert.equal(refreshJson.success, true);
    assert.ok(refreshJson.token, 'Refresh returns rotated access token');
    const rotatedCookieHeader = (refreshRes.headers.getSetCookie?.() || [])
      .map((c) => c.split(';')[0])
      .join('; ');
    pass('Session refresh /api/auth/refresh rotates session cleanly');

    // 3d. Wrong password & nonexistent account
    const wrongPwdRes = await fetch(`${base}/api/index?__sb_path=/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: validEmail, password: 'WrongPassword999!' }),
    });
    assert.equal(wrongPwdRes.status, 401);
    await assert.rejects(
      () => parseApiJson(wrongPwdRes),
      (err: any) => err.code === 'INVALID_CREDENTIALS' && err.status === 401
    );
    pass('Login rejects wrong password with 401 INVALID_CREDENTIALS');

    const missingAccRes = await fetch(`${base}/api/index?__sb_path=/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `nobody_${uniq}@gmail.com`, password: validPassword }),
    });
    assert.equal(missingAccRes.status, 401);
    await assert.rejects(
      () => parseApiJson(missingAccRes),
      (err: any) => err.code === 'INVALID_CREDENTIALS' && err.status === 401
    );
    pass('Login rejects nonexistent account with 401 INVALID_CREDENTIALS');

    // 3e. Logout & revoked session check
    const logoutRes = await fetch(`${base}/api/index?__sb_path=/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: rotatedCookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(logoutRes.status, 200);
    const logoutJson = await parseApiJson<any>(logoutRes);
    assert.equal(logoutJson.success, true);

    const postLogoutMeRes = await fetch(`${base}/api/index?__sb_path=/api/me`, {
      headers: { Cookie: rotatedCookieHeader },
    });
    assert.equal(postLogoutMeRes.status, 401);
    await assert.rejects(
      () => parseApiJson(postLogoutMeRes),
      (err: any) => err.code === 'AUTH_REQUIRED' && err.status === 401
    );
    pass('Logout invalidates session; subsequent /api/me returns 401 JSON');

    // 3f. Untrusted cross-site CSRF still blocked with 403
    const untrustedCsrfRes = await fetch(`${base}/api/index?__sb_path=/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ identifier: validEmail, password: validPassword }),
    });
    assert.equal(untrustedCsrfRes.status, 403);
    pass('Untrusted cross-site POST without allowed Origin remains blocked (403 CSRF)');

    // 3g. Unmatched /api/* route returns JSON 404 instead of HTML/plaintext
    const notFoundRes = await fetch(`${base}/api/index?__sb_path=/api/does-not-exist`);
    assert.equal(notFoundRes.status, 404);
    assert.ok(
      String(notFoundRes.headers.get('content-type') || '').includes('application/json'),
      'Unmatched /api/* returns application/json 404'
    );
    await assert.rejects(
      () => parseApiJson(notFoundRes),
      (err: any) => err.code === 'NOT_FOUND' && err.status === 404
    );
    pass('Unmatched /api/* returns structured JSON 404 (not HTML/plaintext)');

    // 4. Direct invocation simulating @vercel/node pre-parsed req.body
    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const mockReq: any = {
        url: '/api/index?__sb_path=/api/health',
        method: 'GET',
        headers: { host: '127.0.0.1' },
        body: undefined,
        socket: { remoteAddress: '127.0.0.1' },
        connection: { remoteAddress: '127.0.0.1' },
      };
      const headersMap: Record<string, any> = {};
      const mockRes: any = {
        statusCode: 200,
        headersSent: false,
        setHeader(k: string, v: any) {
          headersMap[k.toLowerCase()] = v;
          return this;
        },
        getHeader(k: string) {
          return headersMap[k.toLowerCase()];
        },
        removeHeader(k: string) {
          delete headersMap[k.toLowerCase()];
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        write(chunk: any) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          return true;
        },
        end(chunk?: any) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          this.headersSent = true;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.equal(this.statusCode, 200);
            assert.equal(body.status, 'ok');
            resolve();
          } catch (e) {
            reject(e);
          }
          return this;
        },
      };
      // Use real express route via http server for full Express compatibility too,
      // and also test pre-parsed req.body directly on a POST mock:
      const postReq: any = {
        url: '/api/index?__sb_path=/api/auth/login',
        method: 'POST',
        headers: { 'content-type': 'application/json', host: '127.0.0.1' },
        body: { identifier: validUsername, password: validPassword },
        socket: { remoteAddress: '127.0.0.1' },
        connection: { remoteAddress: '127.0.0.1' },
        on() { return this; },
        once() { return this; },
        emit() { return false; },
        resume() { return this; },
        pause() { return this; },
      };
      const postChunks: Buffer[] = [];
      const postHeaders: Record<string, any> = {};
      const postRes: any = {
        statusCode: 200,
        headersSent: false,
        setHeader(k: string, v: any) {
          postHeaders[k.toLowerCase()] = v;
          return this;
        },
        getHeader(k: string) {
          return postHeaders[k.toLowerCase()];
        },
        removeHeader(k: string) {
          delete postHeaders[k.toLowerCase()];
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        write(chunk: any) {
          postChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          return true;
        },
        end(chunk?: any) {
          if (chunk) postChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          this.headersSent = true;
          try {
            const body = JSON.parse(Buffer.concat(postChunks).toString('utf8'));
            assert.equal(this.statusCode, 200);
            assert.equal(body.success, true);
            assert.ok(body.token);
            void mockReq;
            void mockRes;
            resolve();
          } catch (e) {
            reject(e);
          }
          return this;
        },
      };
      vercelHandler(postReq, postRes);
    });
    pass('@vercel/node pre-parsed req.body handling succeeds on POST /api/auth/login');

    console.log('\n🎉 ALL VERCEL AUTH, ROUTING & SAFE JSON PARSING TESTS PASSED!\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  }
}

runTests().catch((err) => {
  console.error('\n❌ VERCEL AUTH TEST FAILED:', err);
  cleanup();
  process.exit(1);
});

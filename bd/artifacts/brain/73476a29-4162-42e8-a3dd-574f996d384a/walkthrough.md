# Security Summary

Schoolbackdoor (React 19 + Vite + Express + Node 22 SQLite) was audited and upgraded for Apple App Store and Google Play Store readiness without rebuilding working core subsystems. The following security, privacy, session-lifecycle, moderation, and compliance controls are implemented and verified:

## 1. User Data Protection & Credential Storage
- **Memory-Only Bearer + HttpOnly Cookie Auth**: Purged `localStorage` and `sessionStorage` auth token persistence (`sb_auth_session_token`, `sb_auth_token`). Browser API calls rely on `HttpOnly`, `SameSite=Strict` cookies (`sb_session` and `sb_refresh`) plus an in-memory bearer token for active SSE/realtime requests.
- **Password & Token Hashing**: Account passwords use salted `crypto.scrypt` (`N=32768, r=8, p=1, keylen=32`); session access tokens and refresh tokens are generated with 32 bytes of cryptographic entropy and stored exclusively as SHA-256 hashes in SQLite (`sessions`).
- **Private Chat Media ACL**: Uploaded private chat attachments (`/api/uploads/:filename`) enforce `fileService.canUserAccessFile` requiring an explicit authenticated session (`req.sessionTokenHash`) belonging to a participant in the referencing chat or the Admin `@THEBACKDOOR`, returning `401` to anonymous callers, `403` to non-participants, and `Cache-Control: private, no-store, no-cache, must-revalidate` + `CDN-Cache-Control: no-store` on delivery.
- **Transport & Injection Protections**: All SQL queries use parameterized `node:sqlite` statements (`better-sqlite3`-style bindings); HTML/SSR compliance views escape all dynamic inputs; CORS + `Sec-Fetch-Site` + `Content-Type` CSRF checks guard state-changing API routes; production builds set `HSTS`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and strict CSP headers.

## 2. User Privacy & Crawler Controls
- **Zero PII Leaks**: Emails, phone numbers, password hashes, OTP verification codes, and password reset codes are excluded from public profiles, list responses, JSON responses, and structured logs.
- **Crawler Blocking**: `GET /robots.txt` explicitly disallows `/api/`, `/api/uploads/`, `/uploads/`, `/admin`, `/mod`, `/chats`, `/profile`, and `/settings`, while allowing public store compliance URLs (`/privacy`, `/terms`, `/support`, `/account-deletion`). All `/api/*` responses include `X-Robots-Tag: noindex, nofollow`.
- **Coarse Location Only**: Location filtering uses opt-in campus/community area taxonomies and rejects raw GPS coordinate submissions (`400`).

## 3. Dual-Token Session Lifecycle & Multi-Device Management
- **Token Lifetimes & Rotation**: Short-lived `15-minute` access tokens (`sb_session`), rotating `30-day` inactivity refresh tokens (`sb_refresh`), and a `90-day` hard session lifetime cap. Replaying an already-rotated or revoked refresh token triggers reuse detection (`REFRESH_TOKEN_REUSE`), revokes all active sessions for the user, logs a `critical` `security_events` row, and alerts the account owner.
- **Concurrent Multi-Device Cap (`MAX_ACTIVE_DEVICES = 5`)**: Users may stay logged in simultaneously on up to 5 devices (phone, tablet, laptop, desktop). A 6th sign-in deterministically evicts only the oldest active session while notifying the user of unfamiliar device logins. Users can inspect active devices and sign out individual or all other sessions in **Settings → Security & Devices**.
- **Sensitive Action Re-Authentication**: Changing password, resetting password, and permanent account deletion require password verification or a recent re-authentication (`POST /api/auth/reauthenticate`, 15-minute window, returning `403 REAUTH_REQUIRED` when stale) and immediately invalidate other/all sessions.

## 4. Brute-Force Defense & Privileged TOTP MFA
- **Escalating Temporary Cooldowns**: Login and OTP brute-force defenses trigger progressive temporary cool-offs (`15m -> 30m -> 60m -> 180m`) starting at 5 failures (`5 / 8 / 12 / 16`) with HTTP `429`, accurate `Retry-After` headers, generic credential failure messages (preventing email/handle enumeration), and `FAILED_LOGIN_BURST` logging—never permanent lockout.
- **Admin & Moderator MFA**: RFC-6238 TOTP MFA (`POST /api/auth/mfa/setup`, `/verify`, `/disable`) is restricted to `admin` and `moderator` roles (`403` for standard students) and enforced on login with `403 mfaRequired`.

## 5. Content Safety, Moderation & Account Deletion URLs
- **Mandatory Terms & Age (17+/18+) Gate**: Signup requires `acceptTerms: true` (`400 TERMS_ACCEPTANCE_REQUIRED`). Unaccepted/legacy accounts are gated on `POST /api/posts`, `POST /api/posts/:id/comments`, and `POST /api/communities/:id/posts` (`403 TERMS_ACCEPTANCE_REQUIRED`) until confirming via `POST /api/me/accept-terms`.
- **Group Chat Block Filtering**: Direct and group chat feeds filter out messages and mentions from mutually blocked users (`user_blocks`) for the blocking user while keeping conversations intact for other members.
- **Public Store Compliance URLs**: Standalone server-rendered routes `GET /privacy`, `GET /terms`, `GET /support`, `GET /account-deletion`, and `POST /account-deletion` operate without requiring an authenticated SPA session so Apple App Review, Google Play Reviewers, and users can access policies or delete accounts externally.

## 6. Store Packaging Gaps (Out-of-Scope Native Wrappers)
- **Web App Readiness**: `public/manifest.webmanifest` and mobile viewport/PWA meta tags in `index.html` are configured and built.
- **Native Binary Requirements Still Pending**: No native iOS (`ios/` Xcode project, APNs entitlements, CocoaPods/Capacitor/React Native wrapper, IPA signing) or Android (`android/` Gradle project, keystore, FCM SDK, signed AAB) projects exist inside this web repository and must be packaged prior to binary upload.

---

## PoC Verification

All automated verification suites, production build, and live SSR checks passed after the final code changes:

1. **TypeScript & Vite Compilation**:
   - `compile_applet` (`vite build`): **PASS** (1,708 modules built into `dist/` in 1.39s).
   - `lint_applet` (`tsc --noEmit`): **PASS** (0 errors).

2. **Full Backend & Database Integration Suite (`npm run test:backend`)**:
   - **PASS (Exit 0)** — Sections **1 through 32** passed 100%, including Section **32** assertions covering:
     - Signup rejection without `acceptTerms: true` (`400 TERMS_ACCEPTANCE_REQUIRED`) and dual `HttpOnly` cookie issuance without leaking `refreshToken` in JSON.
     - Refresh rotation (`POST /api/auth/refresh`) and replay reuse detection (`401 REFRESH_TOKEN_REUSE`), revoking all user sessions and recording a `critical` `security_events` alert.
     - 5 concurrent device logins + deterministic 6th-device oldest-session eviction + new device notification + remote single/all-other device sign-out.
     - Password change session invalidation and re-auth-gated self-service deletion (`403 REAUTH_REQUIRED` -> `200` after `POST /api/auth/reauthenticate`).
     - Moderator TOTP MFA setup/verification + login enforcement (`403 mfaRequired` -> `200` with valid TOTP) and `403` denial for regular students.
     - Escalating brute-force cooldown (`429`, `Retry-After: 899s`, `FAILED_LOGIN_BURST`).
     - Private chat media ACL (`401` anonymous, `403` non-participant, `200` participant/Admin with `Cache-Control: private, no-store, no-cache, must-revalidate`).
     - Group chat blocked-user filtering (`user_blocks`).
     - UGC Terms gating (`403 TERMS_ACCEPTANCE_REQUIRED`) unlocked cleanly via `POST /api/me/accept-terms` (`{ accept: true }`).
     - Admin security session & severity-filtered event APIs (`GET /api/admin/security`, `GET /api/admin/security/events?severity=critical`, `POST /api/admin/security/users/:id/revoke-sessions`) returning `200` for Admin and `403` for Moderator.

3. **Production Security & Audit Suite (`npx tsx server/test/stage10Audit.ts`)**:
   - **PASS (Exit 0)** — Verified `NODE_ENV=production` startup, HSTS/CSP/`nosniff`/CORS/`Sec-Fetch-Site`/Content-Type protections, upload magic-byte & SVG XSS blocks, backup SHA-256 tamper rejection, and NDPA deletion tombstone reconciliation.

4. **Dependency Security Audit (`bun audit`)**:
   - **PASS** — `No vulnerabilities found (checked 211 packages)`.

5. **Live Express SSR & Standalone Account Deletion Verification (`server.ts`)**:
   - Verified against live `server.ts` instance using isolated temporary SQLite storage:
     - `GET /robots.txt` -> `200` (`Disallow: /api/`, `Disallow: /uploads/`).
     - `GET /privacy`, `GET /terms`, `GET /support`, `GET /account-deletion` -> `200` standalone HTML documents.
     - `GET /manifest.webmanifest` -> `200` valid manifest JSON.
     - `GET /api/health` -> `200` with `X-Robots-Tag: noindex, nofollow`.
     - `POST /account-deletion` -> `401` on invalid password, `200` on valid password + `PERMANENTLY_DELETE`, immediately blocking subsequent login (`401`).

# Security Summary

**Reviewed Files**: 25
**Issues Resolved**: 10

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Hardcoded Privileged Credentials | `server/db/database.ts` | 1043 | Fresh databases seeded fallback default passwords for `@THEBACKDOOR` and `@campus_mod` when environment variables were unset. | High | Fixed | Removed hardcoded password fallbacks, assigned an unloginable sentinel (`!UNCLAIMED_SETUP_REQUIRED`), added `npm run provision:staff`, and added a single-use first-run Admin setup flow (`/api/auth/setup-admin`) that locks permanently after use. |
| Session Token in Query String | `server/routes/api.ts` | 1290 | `/api/realtime/stream` accepted raw bearer session tokens via `?token=` query parameters, risking exposure in server logs and browser history. | High | Fixed | Removed `?token=` authentication from `/api/realtime/stream`, enforced short-lived signed/cache-backed `?ticket=` tokens from `POST /api/realtime/ticket`, and replaced the predictable realtime secret fallback with a random per-process fallback when unset. |
| Missing Step-Up Re-Authentication | `server/routes/api.ts` | 2065 | High-risk Admin routes (role promotion, permanent user deletion, backup restore, session revocation, global settings, moderator assignment/revocation, orphan file purge) accepted stale sessions without recent credential confirmation. | High | Fixed | Added `requireRecentReauth` middleware (`server/middleware/auth.ts`) requiring verification within 15 minutes (or inline `currentPassword` / passkey re-auth), returning `403 REAUTH_REQUIRED` when stale, with an Admin UI re-auth prompt. |
| Moderator Scope & Anonymous Masking | `server/services/moderatorService.ts` | 150 | `/api/realtime/poll` pushed `adminReports` to any moderator regardless of `canReviewReports`, moderator report queues exposed `is_anonymous` author handles/IDs, and moderators could act on peer moderators' content. | High | Fixed | Gated `adminReports` in `/api/realtime/poll` on `canReviewReports`, masked anonymous post authors (`@anonymous`, `targetUserId: null`) in moderator queues, blocked cross-moderator content tampering (`403`), and strictly validated `:type` (`post` \| `comment`) on `PATCH /api/mod/content/:type/:id`. |
| Unaudited Admin Deletions & Missing Report Action | `server/routes/api.ts` | 2295 | `DELETE /api/admin/posts/:id` and `DELETE /api/admin/comments/:id` lacked `admin_audit_logs` entries, and `PATCH /api/admin/reports/:id` ignored `actionTaken`. | Medium | Fixed | Added `ADMIN_DELETE_POST` and `ADMIN_DELETE_COMMENT` audit trail entries and persisted `actionTaken` atomically inside `adminReportService.updateReportStatus`. |
| Unauthenticated Access to Hidden Post Media | `server/services/fileService.ts` | 364 | `/api/uploads/:filename` continued serving uploaded images attached to hidden (`is_hidden = 1`) posts or comments. | Medium | Fixed | Added `COALESCE(is_hidden, 0) = 0` checks in `getFileServePolicy` so media belonging to hidden posts or comments returns `404`. |
| Legacy Email & Phone Data in API Responses | `server/services/userService.ts` | 192 | Legacy `email` and `phoneNumber` fields were still returned by `/api/me`, session validation/refresh, `/api/users/:id/profile`, and Admin user/staff/moderator/appeal responses. | Medium | Fixed | Removed `email` and `phoneNumber` from authentication middleware, user profile, session responses, and Admin/Moderator/Appeals endpoints while keeping legacy columns dormant in SQLite. |
| Raw Request Body Logged on Settings Update | `server/services/adminControlService.ts` | 1272 | `PUT /api/admin/settings` logged the full unvalidated `req.body` payload into `admin_audit_logs` instead of only the allowlisted keys written to the database. | Low | Fixed | Restricted audit metadata to the allowlisted `appliedUpdates` dictionary actually persisted to `platform_settings`. |
| Unbounded Suspension Duration & Missing Target Checks | `server/services/adminSecurityService.ts` | 531 | `POST /api/admin/users/:id/suspend` accepted invalid negative or fractional `durationDays`, and warning/unsuspend/session-revoke handlers did not consistently check target existence or warn Admins. | Low | Fixed | Validated integer `durationDays` (`1..365`), added target-user existence checks (`404`), blocked self/Admin warning targets (`403`), and incremented `warnings_count` consistently. |
| Unguarded JSON Parsing in Audit & Backup Readers | `server/services/adminSecurityService.ts` | 140 | Corrupted JSON in `admin_audit_logs`, `backups`, or `security_events` metadata columns could throw uncaught exceptions when listing logs. | Low | Fixed | Added `safeJsonParse` fallbacks across audit log, backup snapshot, and security event readers. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| SQL Injection Prevention | `server/services/` | All SQLite queries across services use parameterized `.prepare(...).get/all/run(...)` bindings rather than string concatenation of user input. |
| XSS & Content Sanitization | `server/utils/security.ts`, `src/` | HTML tags and unsafe URL schemes (`javascript:`, `data:text/html`) are stripped server-side via `sanitizeInputText`/`sanitizeUrl`, and React renders user content safely without raw HTML injection. |
| Authentication & Password Hashing | `server/utils/security.ts`, `server/services/authService.ts` | Passwords use Argon2id (`m=19456, t=2, p=1`) with transparent scrypt re-hash on login, timing-safe checks, single-use recovery codes (stored salted + hashed), and WebAuthn passkey verification (`rpID`, origin, single-use challenges, signature counter checks). |
| Sessions, CSRF & Cookie Security | `server/app.ts`, `server/middleware/auth.ts` | Access and refresh tokens use hashed DB lookup and `HttpOnly`, `SameSite=Strict`, `Secure` (production) cookies with same-origin enforcement on cookie-authenticated mutations. |
| CORS, CSP & Security Headers | `server/app.ts` | Helmet configures frame-compatible CSP (`frame-ancestors 'self' https://aistudio.google.com ...`), HSTS in production, `nosniff`, and strict CORS origin allowlisting (`ALLOWED_ORIGINS` + localhost in dev). |
| IDOR & Ownership Checks | `server/routes/api.ts`, `server/services/` | Direct messages, saved locations, location search history, device sessions, passkeys, and posts/comments verify `req.user.id` ownership or Admin role before read/update/delete. |
| Rate Limiting & Lockouts | `server/services/authService.ts` | Login, recovery reset, registration, and WebAuthn endpoints enforce database-backed per-IP and per-account rate limits, progressive delays, and proof-of-work bot challenges. |
| Dependency Security | `package.json`, `bun.lock` | `bun audit` verified across 236 installed packages with 0 known vulnerabilities. |

---

## PoC Verification

### 1. Hardcoded Privileged Credentials Removed
#### Summary
| Field | Value |
|---|---|
| Issue Type | Hardcoded Initial Admin & Moderator Credentials |
| Impact | High |
| Affected File | `server/db/database.ts:1043`, `server/routes/api.ts` |
| Test Scenario | Unconfigured fresh database receives `POST /api/auth/login` for `@THEBACKDOOR` / `@campus_mod`, followed by one-time `POST /api/auth/setup-admin` and duplicate claim replay. |

#### How It Was Fixed
Removed all hardcoded fallback passwords from `syncTheBackdoorAdminIdentity` and `syncDefaultModeratorAccount`, defaulting unconfigured installs to `!UNCLAIMED_SETUP_REQUIRED`. Added `npm run provision:staff` for CLI/env provisioning and a single-use `POST /api/auth/setup-admin` claim route when `ADMIN_PASSWORD` is unset.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `POST /api/auth/login` arrives for `@THEBACKDOOR` on a fresh unconfigured DB | Enters `authService.login` |
| 2 | `verifyPassword` in `server/utils/security.ts` rejects `!UNCLAIMED_SETUP_REQUIRED` | Returns `401` |
| 3 | First-run `POST /api/auth/setup-admin` sets Argon2id hash & 10 recovery codes | Returns `201`, `adminNeedsSetup` flips to `false` |
| 4 | Second `POST /api/auth/setup-admin` checks sentinel in `claimFirstRunAdminPassword` | **Handled Safely (`409 Conflict`)** |

#### Conclusion
**Fix Verified** — Unconfigured privileged accounts cannot be accessed with known defaults and one-time browser claim permanently locks after first setup.

---

### 2. Query-String Session Token Removal on Realtime Stream
#### Summary
| Field | Value |
|---|---|
| Issue Type | Bearer Session Token Accepted in URL Query Parameter |
| Impact | High |
| Affected File | `server/routes/api.ts:1290` |
| Test Scenario | `GET /api/realtime/stream?token=<raw_admin_session_token>` vs `GET /api/realtime/stream?ticket=<signed_ticket>` |

#### How It Was Fixed
Deleted the `req.query.token` validation path from `/api/realtime/stream` so only `Authorization`/cookie sessions or short-lived tickets from `POST /api/realtime/ticket` authenticate a stream.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `GET /api/realtime/stream?token=<raw_token>` enters SSE handler | `req.isAuthenticatedUser` is `false` |
| 2 | Handler at `server/routes/api.ts:1294` checks only `req.query.ticket` | `?token=` is ignored |
| 3 | `sseManager.addClient(userId, ...)` receives `userId = '__anon__'` | **Handled Safely (Anonymous Stream Only)** |

#### Conclusion
**Fix Verified** — Raw session tokens passed in query strings never authenticate private realtime channels.

---

### 3. Step-Up Re-Authentication on Sensitive Admin Operations
#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Recent Re-Authentication on High-Impact Admin Routes |
| Impact | High |
| Affected File | `server/middleware/auth.ts`, `server/routes/api.ts:2065` |
| Test Scenario | Admin session with stale `last_reauthenticated_at` (`-30 minutes`) calls `PUT /api/admin/settings`, `POST /api/admin/staff/role`, and `POST /api/admin/security/sessions/revoke`. |

#### How It Was Fixed
Added `requireRecentReauth` middleware enforcing recent password/passkey verification (`<= 15 minutes` or inline `currentPassword`) before executing privileged mutations, paired with an interactive re-auth modal in `src/pages/AdminPage.tsx`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `PUT /api/admin/settings` passes `requireAuth` and `requireAdmin` | Reaches `requireRecentReauth` |
| 2 | `hasRecentReauth(req.user)` evaluates false and no `currentPassword` is provided | Returns `403 { code: 'REAUTH_REQUIRED' }` |
| 3 | Caller confirms via `POST /api/auth/reauthenticate`, updating `last_reauthenticated_at` | Retry returns **Handled Safely (`200 OK`)** |

#### Conclusion
**Fix Verified** — Compromised or idle Admin sessions cannot modify roles, security settings, backups, or sessions without fresh authentication.

---

### 4. Moderator Scope Enforcement, Anonymous Masking & Peer-Moderator Guard
#### Summary
| Field | Value |
|---|---|
| Issue Type | Over-Permissive Moderator Poll Data, Anonymous Author Leak & Cross-Moderator Modification |
| Impact | High |
| Affected File | `server/routes/api.ts:1373`, `server/services/moderatorService.ts:150` |
| Test Scenario | Moderator with `canReviewReports: false` polls `/api/realtime/poll`; peer moderator inspects anonymous report and tries hiding a fellow moderator's post (`PATCH /api/mod/content/post/:id`) or passing `:type = users`. |

#### How It Was Fixed
Checked `canReviewReports` before including `adminReports` in `/api/realtime/poll`, masked anonymous post authors in `listReportsForModerator`, rejected moderator content actions against other moderators (`403`), and rejected non-`post`/`comment` types (`400`).

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `GET /api/realtime/poll` checks `moderatorService.getModeratorPermissions` | Omits `adminReports` when `canReviewReports` is false |
| 2 | `GET /api/mod/reports` encounters `is_anonymous = 1` on target post | Masks handle to `@anonymous` and omits `targetUserId` |
| 3 | `PATCH /api/mod/content/post/:id` checks target author's role (`admin` or `moderator`) | Returns **Handled Safely (`403 Forbidden`)** |

#### Conclusion
**Fix Verified** — Moderators stay strictly within their assigned capability matrix, anonymous student identities stay protected, and fellow moderators/admins cannot be overridden.

---

### 5. Hidden Media Protection & Response Data Minimization
#### Summary
| Field | Value |
|---|---|
| Issue Type | Hidden Content Media Still Served Publicly & Legacy PII Fields in API Responses |
| Impact | Medium |
| Affected File | `server/services/fileService.ts:364`, `server/services/userService.ts`, `server/services/adminControlService.ts` |
| Test Scenario | Public `GET /api/uploads/<filename>` on an image attached only to a hidden post (`is_hidden = 1`), and inspection of `/api/me`, `/api/users/:id/profile`, `/api/admin/users`, `/api/admin/moderators`, `/api/admin/staff`, and `/api/admin/appeals`. |

#### How It Was Fixed
Updated `getFileServePolicy` queries to exclude hidden posts/comments (`COALESCE(is_hidden, 0) = 0`), and stripped legacy `email`, `phoneNumber`, and credential metadata from API payloads.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `GET /api/uploads/<hidden_file>` invokes `fileService.getFileServePolicy` | SQL requires `COALESCE(is_hidden, 0) = 0` |
| 2 | No visible post or avatar references the file | Returns **Handled Safely (`404 Not Found`)** |
| 3 | Profile and Admin serializers construct JSON payloads | Legacy `email`, `phoneNumber`, and secret hashes are omitted |

#### Conclusion
**Fix Verified** — Moderated media is inaccessible via direct URL and API responses follow strict data minimization.

/**
 * Automated test suite for Schoolbackdoor backend and database
 * Runs with `npx tsx server/test/backend.test.ts`
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolbackdoor-test-'));
process.env.SCHOOLBACKDOOR_DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.SCHOOLBACKDOOR_BACKUP_DIR = path.join(TMP_DIR, 'backups');
process.env.SCHOOLBACKDOOR_UPLOADS_DIR = path.join(TMP_DIR, 'uploads');

function cleanupTempDir() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
}

function assert(condition: any, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    cleanupTempDir();
    process.exit(1);
  } else {
    console.log(`✅ PASSED: ${message}`);
  }
}

function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0) {
      bits += 8;
    } else {
      bits += Math.clz32(byte) - 24;
      break;
    }
  }
  return bits;
}

function solvePow(nonce: string, difficulty: number): string {
  for (let counter = 0; ; counter++) {
    const sol = counter.toString(36);
    const digest = crypto.createHash('sha256').update(`${nonce}:${sol}`, 'utf8').digest();
    if (countLeadingZeroBits(digest) >= difficulty) {
      return sol;
    }
  }
}

async function fetchSolvedChallenge(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/auth/challenge`);
  const body = (await res.json()) as { challengeId: string; nonce: string; difficulty: number };
  return {
    botChallengeId: body.challengeId,
    botChallengeNonce: body.nonce,
    botChallengeSolution: solvePow(body.nonce, body.difficulty),
  };
}

async function runTests() {
  const { initDatabase, db, runInTransaction, checkpointDatabase } = await import('../db/database.js');
  const { seedInitialData, hashPassword } = await import('../db/seed.js');
  const { userService } = await import('../services/userService.js');
  const { postService } = await import('../services/postService.js');
  const { commentReactionService } = await import('../services/commentReactionService.js');
  const { chatService } = await import('../services/chatService.js');
  const { communityService } = await import('../services/communityService.js');
  const { notificationService } = await import('../services/notificationService.js');
  const { adminReportService } = await import('../services/adminReportService.js');
  const { fileService, getUploadsDir, PROTECTION_MODE_MAX_UPLOAD_BYTES } = await import('../services/fileService.js');
  const { landmarkService } = await import('../services/landmarkService.js');
  const { adminSecurityService } = await import('../services/adminSecurityService.js');
  const { adminControlService } = await import('../services/adminControlService.js');
  const { deletionService } = await import('../services/deletionService.js');
  const { redactSensitiveData } = await import('../utils/logger.js');
  const { authService, AuthRateLimitError } = await import('../services/authService.js');
  const { computeTotpCode } = await import('../utils/totp.js');
  const { presenceService } = await import('../services/presenceService.js');
  const { cache } = await import('../utils/cache.js');

  console.log('\n======================================================');
  console.log('🧪 SCHOOLBACKDOOR BACKEND & DATABASE TEST SUITE');
  console.log('======================================================\n');

  // --- Step 1: Database Connection & Schema Verification ---
  console.log('--- 1. Testing Database Connection & Schema ---');
  initDatabase();
  seedInitialData();

  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  assert(foreignKeys.foreign_keys === 1, 'Foreign keys enforcement is ACTIVE');

  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>;
  const tableNames = tables.map((t) => t.name);

  const requiredTables = [
    'users',
    'user_profiles',
    'posts',
    'comments',
    'likes',
    'chats',
    'chat_participants',
    'messages',
    'communities',
    'community_memberships',
    'announcements',
    'notifications',
    'subscriptions',
    'payments',
    'reports',
    'admin_audit_logs',
  ];

  for (const reqTable of requiredTables) {
    assert(tableNames.includes(reqTable), `Schema includes table '${reqTable}'`);
  }

  // --- Step 2: Reading Records ---
  console.log('\n--- 2. Testing Reading Records ---');
  const user = userService.getUserById('u-ayodele');
  assert(user !== undefined && user.matric_number === 'CSC/20/8901', 'Can read user by ID');

  const profile = userService.getProfileByUserId('u-ayodele');
  assert(profile !== null && profile.department === 'Computer Science', 'Can read user profile');

  const feed = postService.getFeedPosts('u-ayodele', 10);
  assert(feed.length >= 3, `Feed returned ${feed.length} seeded posts`);

  const communities = communityService.getAllCommunities('u-ayodele');
  assert(communities.length >= 6, `Returned ${communities.length} campus communities`);
  const socComm = communities.find((c) => c.acronym === 'SOC');
  assert(socComm?.isJoined === true, 'Ayodele is identified as joined in SOC');

  const notifications = notificationService.getUserNotifications('u-ayodele');
  assert(notifications.length >= 3, `Returned ${notifications.length} user notifications`);

  // --- Step 3: Creating Records ---
  console.log('\n--- 3. Testing Creating Records ---');
  const testUserId = `u-test-${Date.now()}`;
  db.prepare(`
    INSERT INTO users (id, matric_number, email, password_hash, role, status)
    VALUES (?, ?, ?, ?, 'student', 'active')
  `).run(testUserId, `TEST/${Date.now()}`, `test-${Date.now()}@futa.edu.ng`, hashPassword('Secret123!'));

  db.prepare(`
    INSERT INTO user_profiles (id, user_id, name, handle, department, school, level, hall_of_residence, avatar_initials, avatar_bg)
    VALUES (?, ?, 'Test Student', ?, 'Physics', 'School of Sciences', '200L', 'Akindeko', 'TS', 'bg-stone-500 text-white')
  `).run(`p-${testUserId}`, testUserId, `@test_${Date.now()}`);

  const testUser = userService.getUserById(testUserId);
  assert(testUser !== undefined, 'Successfully created test student user');

  // Create Post
  const createdPost = postService.createPost(testUserId, {
    content: 'Testing campus sensor network dispatch at ETF 3',
    school_tag: 'SOS',
    location: {
      id: 'spot-etf3',
      name: 'ETF 3 Lecture Theatre',
      coordinates: [7.3048, 5.136],
    },
    images: ['https://images.unsplash.com/photo-1523240795612-9a054b0db644'],
  });
  if (!createdPost) throw new Error('Post creation failed');
  assert(createdPost.id.startsWith('post-'), 'Created new dispatch with location & images');

  // Create Comment
  const comment = commentReactionService.addComment(createdPost.id, 'u-kemi', 'Great test dispatch!');
  assert(comment !== null && comment.content === 'Great test dispatch!', 'Created comment on test dispatch');

  // Toggle Like (Like post)
  const likeResult = commentReactionService.toggleLike(createdPost.id, 'u-kemi');
  assert(likeResult.isLiked === true && likeResult.likes === 1, 'Toggled like ON (likes = 1)');

  // Send Message in Conv-1
  const message = chatService.sendMessage('conv-1', 'u-ayodele', {
    text: 'Automated test message dispatch',
    images: ['https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8'],
  });
  assert(message.id.startsWith('m-') && message.images?.length === 1, 'Sent chat message with photo attachment');

  // Create Moderation Report
  const report = adminReportService.createReport(testUserId, {
    target_type: 'post',
    target_id: createdPost.id,
    reason: 'Testing report mechanism',
    details: 'Dev suite verification',
  });
  assert(report.status === 'pending', 'Created moderation report in pending status');

  // --- Step 4: Updating Records ---
  console.log('\n--- 4. Testing Updating Records ---');
  const updatedProfile = userService.updateProfile(testUserId, {
    bio: 'Updated student bio for 2026 academic session.',
    level: '300L',
  });
  assert(updatedProfile?.bio === 'Updated student bio for 2026 academic session.', 'Profile bio updated');
  assert(updatedProfile?.level === '300L', 'Profile academic level updated');

  // Toggle Like again (Unlike post)
  const unlikeResult = commentReactionService.toggleLike(createdPost.id, 'u-kemi');
  assert(unlikeResult.isLiked === false && unlikeResult.likes === 0, 'Toggled like OFF (likes = 0)');

  // Mark notification read
  const unreadBefore = notificationService.getUnreadCount('u-ayodele');
  notificationService.markAsRead(notifications[0].id, 'u-ayodele');
  const unreadAfter = notificationService.getUnreadCount('u-ayodele');
  assert(unreadAfter <= unreadBefore, 'Marked notification as read');

  // Update report status
  const resolvedReport = adminReportService.updateReportStatus(report.id, 'u-admin', 'resolved', 'Verified non-violating');
  assert(resolvedReport.status === 'resolved', 'Admin resolved moderation report');

  // --- Step 5: Deleting Records & Cascade Verification ---
  console.log('\n--- 5. Testing Deleting Records & Cascades ---');
  // Delete comment
  const deleteCommentRes = commentReactionService.deleteComment(comment.id, 'u-kemi', 'student');
  assert(deleteCommentRes.success === true, 'Deleted test comment');

  const postAfterCommentDelete = postService.getPostById(createdPost.id, testUserId);
  assert(postAfterCommentDelete?.commentsCount === 0, 'Post comments_count decremented to 0');

  // Delete post
  const deletePostRes = postService.deletePost(createdPost.id, testUserId, 'student');
  assert(deletePostRes.success === true, 'Deleted test post');

  // Verify post is gone
  const deletedPostCheck = postService.getPostById(createdPost.id, testUserId);
  assert(deletedPostCheck === null, 'Verified post is deleted from database');

  // Delete test user and verify cascading deletion of profile, subscriptions, and payments
  db.prepare('DELETE FROM users WHERE id = ?').run(testUserId);
  const profileAfterCascade = db.prepare('SELECT 1 FROM user_profiles WHERE user_id = ?').get(testUserId);
  assert(profileAfterCascade === undefined, 'User deletion cascaded to user_profiles');

  const subsAfterCascade = db.prepare('SELECT 1 FROM subscriptions WHERE user_id = ?').get(testUserId);
  assert(subsAfterCascade === undefined, 'User deletion cascaded to subscriptions');

  // --- Step 6: Testing Permissions & Least Privilege ---
  console.log('\n--- 6. Testing Permissions & Least Privilege ---');
  // Attempt to read private chat messages by non-participant
  let accessDenied = false;
  try {
    chatService.getChatMessages('conv-2', 'u-kemi'); // Kemi is NOT in conv-2
  } catch (err: any) {
    accessDenied = err.message.includes('Access denied');
  }
  assert(accessDenied, 'Non-participant blocked from reading private chat');

  // Attempt to delete someone else's post
  let unauthorizedDelete = false;
  try {
    postService.deletePost('post-1', 'u-kemi', 'student'); // Post 1 is Ayodele's
  } catch (err: any) {
    unauthorizedDelete = err.message.includes('Unauthorized');
  }
  assert(unauthorizedDelete, 'Student blocked from deleting another student’s dispatch');

  // --- Step 7: Testing Error Handling ---
  console.log('\n--- 7. Testing Error Handling & Validation ---');
  let emptyPostError = false;
  try {
    postService.createPost('u-ayodele', { content: '   ' });
  } catch (err: any) {
    emptyPostError = err.message.includes('cannot be empty');
  }
  assert(emptyPostError, 'Rejected empty post content with validation error');

  let heavyFileError = false;
  let heavyStatus = 0;
  try {
    // Generate a dummy JPEG-headed buffer > 20MB
    const heavyBuffer = Buffer.alloc(20 * 1024 * 1024 + 512);
    heavyBuffer[0] = 0xff;
    heavyBuffer[1] = 0xd8;
    heavyBuffer[2] = 0xff;
    const heavyDataUrl = `data:image/jpeg;base64,${heavyBuffer.toString('base64')}`;
    fileService.saveBase64Image(heavyDataUrl, 'u-ayodele');
  } catch (err: any) {
    heavyFileError = err.message.includes('maximum upload size of 20MB');
    heavyStatus = Number(err?.status || 0);
  }
  assert(heavyFileError && heavyStatus === 413, 'File > 20MB rejected with 413 status and clear 20MB limit error message');

  // --- Step 8: Testing Stage 3 Registration, Authentication, Profiles & Privacy ---
  console.log('\n--- 8. Testing Stage 3 User Registration & Validation ---');
  const { blockService } = await import('../services/blockService.js');

  // Test 8a: Username validation requiring '@' symbol
  const invalidUser1 = authService.validateUsername('invalid_user_no_at');
  assert(invalidUser1.valid === true && invalidUser1.normalized === '@invalid_user_no_at', 'Automatically prefixes @ if omitted');

  const invalidUser2 = authService.validateUsername('@a'); // too short (< 3 chars total)
  assert(invalidUser2.valid === false, 'Rejects username shorter than 3 characters');

  const invalidUser3 = authService.validateUsername('@futa!illegal*char');
  assert(invalidUser3.valid === false, 'Rejects username with illegal characters');

  const invalidUser4 = authService.validateUsername('@admin');
  assert(invalidUser4.valid === false, 'Rejects reserved institutional username');

  const validUserCheck = authService.validateUsername('@futa_scholar26');
  assert(validUserCheck.valid === true && validUserCheck.normalized === '@futa_scholar26', 'Accepts valid FUTA student handle with @');

  // Test 8b: Register with unique @username + password + confirmPassword -> Argon2id & 10 recovery codes
  const regHandle = `@scholar_${Date.now().toString().slice(-6)}`;
  const regResult = authService.register({
    username: regHandle,
    password: 'SecurePassword123!',
    confirmPassword: 'SecurePassword123!',
    acceptTerms: true,
    name: 'Scholar Babatunde',
    department: 'Software Engineering',
    level: '200L',
    hall_of_residence: 'Titans Hall',
  });
  assert(
    regResult.user.username === regHandle &&
      Array.isArray(regResult.recoveryCodes) &&
      regResult.recoveryCodes.length === 10 &&
      regResult.user.recoveryCodesRemaining === 10,
    'Registered new student with @username and received 10 single-use recovery codes once'
  );
  assert(regResult.token.length === 64, 'Generated secure 64-char hex session token upon registration');

  // Test 8c: Reject duplicate case-insensitive username & mismatched confirmPassword
  let mismatchRejected = false;
  try {
    authService.register({
      username: `@mismatch_${Date.now().toString().slice(-4)}`,
      password: 'AnotherPassword123!',
      confirmPassword: 'DifferentPassword123!',
      acceptTerms: true,
    });
  } catch (err: any) {
    mismatchRejected = err.message.includes('do not match');
  }
  assert(mismatchRejected, 'Rejected registration when confirmPassword does not match password');

  let duplicateHandleRejected = false;
  try {
    authService.register({
      username: regHandle.toUpperCase(),
      password: 'AnotherPassword123!',
      confirmPassword: 'AnotherPassword123!',
      acceptTerms: true,
    });
  } catch (err: any) {
    duplicateHandleRejected = err.message.includes('already taken');
  }
  assert(duplicateHandleRejected, 'Rejected case-insensitive duplicate username registration');

  // Test 8d: Recovery code status exposes counts only
  const rcStatus = authService.getRecoveryCodeStatus(regResult.user.id);
  assert(rcStatus.remainingCount === 10 && rcStatus.totalCount === 10, 'Recovery code status reports 10 unused codes');

  // Test 8e: Authentication & SHA-256 Hashed Session Token Resolution
  const loginRes = authService.login(regHandle, 'SecurePassword123!');
  assert(loginRes.token.length === 64, 'Logged in using @ handle and received session token');

  const { hashSessionToken } = await import('../utils/security.js');
  const rawTokenDbRow = db.prepare('SELECT token FROM sessions WHERE token = ?').get(loginRes.token);
  const hashedTokenDbRow = db.prepare('SELECT token FROM sessions WHERE token = ?').get(hashSessionToken(loginRes.token));
  assert(
    rawTokenDbRow === undefined && hashedTokenDbRow !== undefined,
    'Database stores SHA-256 hashed session token instead of plaintext token'
  );

  const sessionUser = authService.validateSession(loginRes.token);
  assert(sessionUser !== null && sessionUser.id === regResult.user.id, 'Session token resolves to authenticated student');

  // Test 8f: Login Rate Limiting & Generic Error Message
  let badPasswordRejected = false;
  try {
    authService.login(regHandle, 'WrongPassword123!');
  } catch (err: any) {
    badPasswordRejected = err.message === 'Invalid username or password.';
  }
  assert(badPasswordRejected, 'Rejected incorrect password with generic error message');

  let unknownUserRejectedGeneric = false;
  try {
    authService.login('@nonexistent_student_999', 'WrongPassword123!');
  } catch (err: any) {
    unknownUserRejectedGeneric = err.message === 'Invalid username or password.';
  }
  assert(unknownUserRejectedGeneric, 'Rejected unknown username with identical generic error message');

  // Test 8g: Method A Password Recovery Flow (username + single-use recovery code)
  const usedCode0 = regResult.recoveryCodes[0];
  const resetRes = authService.resetPasswordWithRecoveryCode({
    username: regHandle,
    recoveryCode: usedCode0,
    newPassword: 'BrandNewSecret2026!',
    confirmPassword: 'BrandNewSecret2026!',
  });
  assert(resetRes.success === true, 'Reset password using valid single-use recovery code');

  // Reusing the same recovery code must fail
  let reusedCodeRejected = false;
  try {
    authService.resetPasswordWithRecoveryCode({
      username: regHandle,
      recoveryCode: usedCode0,
      newPassword: 'AnotherSecret2026!',
      confirmPassword: 'AnotherSecret2026!',
    });
  } catch {
    reusedCodeRejected = true;
  }
  assert(reusedCodeRejected, 'Single-use recovery code cannot be reused after password reset');

  // Previous session invalidated
  const invalidatedSessionCheck = authService.validateSession(loginRes.token);
  assert(invalidatedSessionCheck === null, 'All sessions invalidated after password reset');

  // Can log in with new password
  const newLoginRes = authService.login(regHandle.toUpperCase(), 'BrandNewSecret2026!');
  assert(newLoginRes.token.length === 64, 'Successfully authenticated using new password and case-insensitive username');

  // Logout session invalidation
  authService.logout(newLoginRes.token);
  const loggedOutSessionCheck = authService.validateSession(newLoginRes.token);
  assert(loggedOutSessionCheck === null, 'Session destroyed upon logout');

  // Test 8h: Profile Updates & Protected Field Safeguards
  console.log('\n--- 9. Testing Profile Management & Field Safeguards ---');
  const studentProfile = userService.getProfileByUserId(regResult.user.id);
  assert(studentProfile !== null && studentProfile.department === 'Software Engineering', 'Retrieved student dossier');

  // Allow permitted edits (bio, level, avatar)
  const editedProfile = userService.updateProfile(regResult.user.id, {
    bio: 'Specializing in distributed systems and campus networks.',
    level: '300L',
    is_private: true,
  });
  assert(editedProfile?.bio === 'Specializing in distributed systems and campus networks.', 'Updated permitted bio field');
  assert(editedProfile?.level === '300L', 'Updated permitted level field');
  assert(editedProfile?.isPrivate === true, 'Enabled private student profile');

  // Shield protected fields against student modification
  let matricTamperBlocked = false;
  try {
    userService.updateProfile(regResult.user.id, {
      matric_number: 'CSC/99/9999',
    }, 'student');
  } catch (err: any) {
    matricTamperBlocked = err.message.includes('Permission denied');
  }
  assert(matricTamperBlocked, 'Blocked student attempt to tamper with institutional matriculation number');

  // Test 8i: Privacy & Anonymity Controls
  console.log('\n--- 10. Testing Privacy Shielding & Anonymous Dispatches ---');
  // Stranger viewing private profile
  const shieldedView = userService.getProfileByUserId(regResult.user.id, 'u-ayodele', 'student');
  assert(shieldedView?.matricNumber === 'CONFIDENTIAL', 'Private profile shields matric number from stranger');
  assert(shieldedView?.bio?.includes('marked private'), 'Private profile shields bio from stranger');

  // Owner viewing own private profile
  const ownerView = userService.getProfileByUserId(regResult.user.id, regResult.user.id, 'student');
  assert(ownerView?.matricNumber !== 'CONFIDENTIAL', 'Owner sees full unshielded matric number in own dossier');

  // Anonymous dispatch creation
  const anonPost = postService.createPost(regResult.user.id, {
    content: 'Anonymous campus inquiry: Are night reading spaces open in ETF today?',
    is_anonymous: true,
  });
  assert(anonPost !== null, 'Created anonymous dispatch');

  // Ordinary student viewing feed
  const feedForPeer = postService.getFeedPosts('u-ayodele', 50, 0, 'student');
  const feedAnonPost = feedForPeer.find((p) => p.id === anonPost!.id);
  assert(feedAnonPost?.authorName === 'Anonymous Member', 'Author name masked to Anonymous Member for peer');
  assert(feedAnonPost?.authorHandle === '@anonymous', 'Author handle masked to @anonymous for peer');

  // Author viewing feed
  const feedForAuthor = postService.getFeedPosts(regResult.user.id, 50, 0, 'student');
  const authorFeedAnonPost = feedForAuthor.find((p) => p.id === anonPost!.id);
  assert(Boolean(authorFeedAnonPost?.operatorNote), 'Author sees transparent operator traceability disclosure');

  // Test 8j: Blocking & Unblocking Mechanisms
  console.log('\n--- 11. Testing User Blocking & Direct Messaging Guards ---');
  // Ayodele blocks the new test student
  const blockResult = blockService.blockUser('u-ayodele', regResult.user.id);
  assert(blockResult.success === true, 'Ayodele blocked test student');

  const blockedList = blockService.getBlockedUsers('u-ayodele');
  assert(blockedList.some((b) => b.userId === regResult.user.id), 'Blocked student appears in Ayodele’s blocked list');
  assert(blockService.isBlockedEitherWay('u-ayodele', regResult.user.id) === true, 'isBlockedEitherWay evaluates to true');

  // Blocked student cannot start direct chat with Ayodele
  let directChatBlocked = false;
  try {
    chatService.createDirectChat(regResult.user.id, 'u-ayodele');
  } catch (err: any) {
    directChatBlocked = err.message.includes('Communication restricted');
  }
  assert(directChatBlocked, 'Blocked student prohibited from starting direct chat');

  // Public updates remain viewable
  const publicFeed = postService.getFeedPosts(regResult.user.id, 5);
  assert(publicFeed.length > 0, 'Blocked student can still read public campus feed updates');

  // Unblock user
  const unblockResult = blockService.unblockUser('u-ayodele', regResult.user.id);
  assert(unblockResult.success === true, 'Ayodele unblocked test student');
  assert(blockService.isBlockedEitherWay('u-ayodele', regResult.user.id) === false, 'isBlockedEitherWay evaluates to false after unblock');

  // Clean up test student
  db.prepare('DELETE FROM users WHERE id = ?').run(regResult.user.id);

  // --- Step 12: Testing Stage 5 Direct Messaging, Real-time & Notifications ---
  console.log('\n--- 12. Testing Stage 5 Direct Messaging, Expiry & Notifications ---');

  // 12a: Conversation Creation & Idempotency
  const directChat1 = chatService.createDirectChat('u-ayodele', 'u-kemi');
  assert(Boolean(directChat1.chatId), 'Created direct conversation between Ayodele and Kemi');

  const directChat2 = chatService.createDirectChat('u-ayodele', 'u-kemi');
  assert(directChat2.chatId === directChat1.chatId && directChat2.isNew === false, 'Reusing existing conversation without duplicates');

  let selfChatBlocked = false;
  try {
    chatService.createDirectChat('u-ayodele', 'u-ayodele');
  } catch (e: any) {
    selfChatBlocked = e.message.includes('cannot start a direct chat with yourself');
  }
  assert(selfChatBlocked, 'Prohibited creating direct chat with oneself');

  // 12b: Eligible partners search
  const partners = chatService.searchEligiblePartners('u-ayodele', 'kemi');
  assert(partners.length > 0 && partners.some((p) => p.userId === 'u-kemi'), 'Search found eligible unblocked student Kemi');

  // 12c: Message Sending & Idempotency / Duplicate Prevention
  const testClientId = `test-client-${Date.now()}`;
  const sentMsg1 = chatService.sendMessage(directChat1.chatId, 'u-ayodele', {
    text: 'Hello Kemi, checking syllabus for SEET exam',
    client_id: testClientId,
  });
  assert(sentMsg1.id.startsWith('m-'), 'Delivered message to direct chat');

  // Resending with same client_id returns existing message without duplicate row
  const sentMsg2 = chatService.sendMessage(directChat1.chatId, 'u-ayodele', {
    text: 'Hello Kemi, checking syllabus for SEET exam',
    client_id: testClientId,
  });
  assert(sentMsg2.id === sentMsg1.id, 'Duplicate message prevented via client_id idempotency');

  // Before recipient opens the conversation, sender sees 'sent' and recipient has unreadCount >= 1
  const ayoChatsBeforeRead = chatService.getUserChats('u-ayodele');
  const ayoDirectBefore = ayoChatsBeforeRead.find((c) => c.id === directChat1.chatId);
  const ayoMsgBefore = ayoDirectBefore?.messages.find((m) => m.id === sentMsg1.id);
  assert(
    ayoMsgBefore?.status === 'sent' && !ayoMsgBefore?.readAt,
    'Direct message starts with status="sent" and no readAt before recipient opens conversation'
  );

  const kemiChatsBeforeRead = chatService.getUserChats('u-kemi');
  const kemiActiveBefore = kemiChatsBeforeRead.find((c) => c.id === directChat1.chatId);
  assert(
    kemiActiveBefore !== undefined && kemiActiveBefore.unreadCount >= 1,
    'Recipient sees unreadCount >= 1 before opening direct conversation'
  );

  const messagesInChat = chatService.getChatMessages(directChat1.chatId, 'u-kemi');
  const duplicateCount = messagesInChat.filter((m) => m.clientId === testClientId).length;
  assert(duplicateCount === 1, 'Only one record exists in conversation for the client_id');

  // Opening conversation via getChatMessages marks incoming messages read for sender
  const ayoChatsAfterOpen = chatService.getUserChats('u-ayodele');
  const ayoMsgAfterOpen = ayoChatsAfterOpen
    .find((c) => c.id === directChat1.chatId)
    ?.messages.find((m) => m.id === sentMsg1.id);
  assert(
    ayoMsgAfterOpen?.status === 'read' && Boolean(ayoMsgAfterOpen?.readAt),
    'Sender sees status="read" and readAt once recipient opens conversation'
  );

  // 12d: Explicit markChatAsRead + SSE/status verification on new message + group isolation
  const sentMsgReceipt = chatService.sendMessage(directChat1.chatId, 'u-ayodele', {
    text: 'Confirming tomorrow venue is ETF 2pm',
  });
  const kemiChatsBeforeSecondRead = chatService.getUserChats('u-kemi');
  assert(
    (kemiChatsBeforeSecondRead.find((c) => c.id === directChat1.chatId)?.unreadCount || 0) === 1,
    'Second direct message increments recipient unreadCount to 1'
  );
  const ayoBeforeMark = chatService
    .getChatMessages(directChat1.chatId, 'u-ayodele')
    .find((m) => m.id === sentMsgReceipt.id);
  assert(ayoBeforeMark?.status === 'sent', 'Recipient-unread message remains status="sent" when sender opens chat');

  const markReadRes = chatService.markChatAsRead(directChat1.chatId, 'u-kemi');
  assert(
    markReadRes.success === true && markReadRes.readCount === 1 && Boolean(markReadRes.readAt),
    'markChatAsRead marks 1 unread direct message as read for Kemi'
  );

  const kemiChatsAfterMark = chatService.getUserChats('u-kemi');
  assert(
    kemiChatsAfterMark.find((c) => c.id === directChat1.chatId)?.unreadCount === 0,
    'Recipient unreadCount resets to 0 after marking conversation as read'
  );

  const ayoAfterMark = chatService
    .getChatMessages(directChat1.chatId, 'u-ayodele')
    .find((m) => m.id === sentMsgReceipt.id);
  assert(
    ayoAfterMark?.status === 'read' && ayoAfterMark?.readAt === markReadRes.readAt,
    'Sender sees status="read" matching readAt timestamp after recipient markChatAsRead'
  );

  // Non-participant cannot mark direct conversation read
  let nonPartMarkBlocked = false;
  try {
    chatService.markChatAsRead(directChat1.chatId, 'u-admin');
  } catch (e: any) {
    nonPartMarkBlocked = e.message.includes('Access denied');
  }
  assert(nonPartMarkBlocked, 'Non-participant blocked from calling markChatAsRead');

  // Group chat messages keep status="sent" (read receipts scoped to direct chats)
  const groupMsgSent = chatService.sendMessage('conv-1', 'u-ayodele', {
    text: 'Group read-receipt isolation check',
  });
  chatService.markChatAsRead('conv-1', 'u-kemi');
  const groupMsgCheck = chatService
    .getChatMessages('conv-1', 'u-ayodele')
    .find((m) => m.id === groupMsgSent.id);
  assert(groupMsgCheck?.status === 'sent', 'Group chat outgoing messages remain status="sent" without direct read receipt');

  // 12e: 72-Hour Message Expiry Enforcement
  console.log('\n--- 13. Testing 72-Hour Message Expiry & Background Purge ---');
  // Insert simulated expired message (created 75 hours ago)
  const expiredMsgId = `m-expired-${Date.now()}`;
  db.prepare(`
    INSERT INTO messages (id, chat_id, sender_id, text, created_at)
    VALUES (?, ?, 'u-ayodele', 'This is an old message that should have expired', datetime('now', '-75 hours'))
  `).run(expiredMsgId, directChat1.chatId);

  // Insert simulated fresh message (created 2 hours ago)
  const freshMsgId = `m-fresh-${Date.now()}`;
  db.prepare(`
    INSERT INTO messages (id, chat_id, sender_id, text, created_at)
    VALUES (?, ?, 'u-ayodele', 'This is a fresh message within 72 hours', datetime('now', '-2 hours'))
  `).run(freshMsgId, directChat1.chatId);

  // Check that application API queries strictly hide the expired message
  const activeChatMessages = chatService.getChatMessages(directChat1.chatId, 'u-ayodele');
  const containsExpiredInApi = activeChatMessages.some((m) => m.id === expiredMsgId);
  const containsFreshInApi = activeChatMessages.some((m) => m.id === freshMsgId);
  assert(!containsExpiredInApi, 'Expired message (>72h) is hidden from application API');
  assert(containsFreshInApi, 'Fresh message (<72h) remains accessible in conversation');

  // Run the background purge worker
  const purgeResult = chatService.purgeExpiredMessages();
  assert(purgeResult.purgedCount >= 1, `Purge job cleaned up ${purgeResult.purgedCount} expired messages`);

  // Verify expired message is permanently deleted from database
  const checkDbExpired = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(expiredMsgId);
  assert(checkDbExpired === undefined, 'Expired message permanently deleted from SQLite table');

  const checkDbFresh = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(freshMsgId);
  assert(checkDbFresh !== undefined, 'Fresh message preserved in SQLite table');

  // Clean up fresh test message
  db.prepare('DELETE FROM messages WHERE id = ?').run(freshMsgId);

  // 12f: Privacy & Access Control for Conversations
  console.log('\n--- 14. Testing Chat Access Control & Security ---');
  let unauthorizedReadBlocked = false;
  try {
    chatService.getChatMessages(directChat1.chatId, 'u-admin'); // Admin is not participant of Ayodele-Kemi direct chat
  } catch (e: any) {
    unauthorizedReadBlocked = e.message.includes('Access denied');
  }
  assert(unauthorizedReadBlocked, 'Non-participant blocked from accessing private conversation');

  let unauthorizedSendBlocked = false;
  try {
    chatService.sendMessage(directChat1.chatId, 'u-admin', { text: 'Intrusion attempt' });
  } catch (e: any) {
    unauthorizedSendBlocked = e.message.includes('Access denied');
  }
  assert(unauthorizedSendBlocked, 'Non-participant blocked from sending message to private conversation');

  // 12g: Notifications & Mention Detection
  console.log('\n--- 15. Testing Notifications System & Mentions ---');
  // Manual notification creation
  const testNotif = notificationService.createNotification({
    userId: 'u-ayodele',
    type: 'system',
    title: 'Account Security Alert',
    body: 'New login detected from FUTA campus network',
    actorId: 'u-kemi',
  });
  assert(testNotif !== null && testNotif.id.startsWith('n-'), 'Created notification successfully');

  // Self-action notification is skipped
  const selfNotif = notificationService.createNotification({
    userId: 'u-ayodele',
    type: 'like',
    title: 'Self reaction',
    body: 'You reacted to your own post',
    actorId: 'u-ayodele',
  });
  assert(selfNotif === null, 'Avoided unnecessary self-notification');

  // Mention processing: mentioning @ayodele_ao by Kemi
  const mentionNotifs = notificationService.processMentions(
    'Have you seen the dispatch from @ayodele_ao about the computer science lab?',
    'u-kemi',
    '/home?post=post-1',
    'Campus Commons'
  );
  assert(mentionNotifs.length === 1 && mentionNotifs[0].userId === 'u-ayodele', 'Detected @ayodele_ao mention and notified Ayodele');

  // Mark notification read
  const markNotifRes = notificationService.markAsRead(testNotif!.id, 'u-ayodele');
  assert(markNotifRes.success === true, 'Marked notification as read');

  // Mark all notifications read
  const markAllRes = notificationService.markAllAsRead('u-ayodele');
  assert(markAllRes.success === true, 'Marked all notifications as read');

  // --- Step 16: STAGE 6 - Communities, Group Conversations & Permissions ---
  console.log('\n--- 16. Testing Communities, Governance & Announcements ---');
  // 16a: Create Community with linked group chat
  const testAcronym = `TEST${Math.floor(Math.random() * 8999 + 1000)}`;
  const createdGuild = communityService.createCommunity('u-ayodele', {
    name: 'FUTA Autonomous Robotics Guild',
    acronym: testAcronym,
    category: 'tech',
    description: 'Autonomous drones, ground vehicles, and embedded sensor systems.',
    location: 'SEET Workshop IV, Obanla',
    leaders: 'Lead: A. Balogun · Staff Adviser: Dr. Akindeko',
    rules: 'Respect laboratory equipment and maintain code attribution.',
  });
  if (!createdGuild) {
    throw new Error('Guild creation failed');
  }
  assert(createdGuild.id.startsWith('comm-'), 'Created new community successfully');
  assert(createdGuild.isJoined === true, 'Creator is automatically joined');
  assert(createdGuild.userRole === 'lead', 'Creator is assigned role "lead"');
  assert(Boolean(createdGuild.chatId), 'Linked group conversation was established in chats table');

  // Verify group chat exists in database
  const linkedChat = db.prepare('SELECT * FROM chats WHERE id = ?').get(createdGuild.chatId) as any;
  assert(linkedChat !== undefined && linkedChat.type === 'group', 'Linked chat exists with type "group"');

  // 16b: Member joining & linked chat participation
  const kemiJoinRes = communityService.toggleMembership(createdGuild.id, 'u-kemi');
  assert(kemiJoinRes.isJoined === true, 'Kemi joined the new guild');

  const kemiInChat = db.prepare('SELECT role FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(createdGuild.chatId, 'u-kemi') as any;
  assert(kemiInChat !== undefined && kemiInChat.role === 'member', 'Joined member added to linked group chat automatically');

  // 16c: Member roster and role management
  const rosterBefore = communityService.getCommunityMembers(createdGuild.id);
  assert(rosterBefore.length === 2, 'Roster shows 2 active members (Lead and Member)');

  // Promote Kemi to moderator (Authorized for Lead)
  const promoteRes = communityService.updateMemberRole(createdGuild.id, 'u-ayodele', 'student', 'u-kemi', 'moderator');
  assert(promoteRes.success === true && promoteRes.newRole === 'moderator', 'Lead promoted member to moderator');

  // Verify unauthorized user cannot promote
  let unauthorizedPromoteBlocked = false;
  try {
    communityService.updateMemberRole(createdGuild.id, 'u-dami', 'student', 'u-kemi', 'lead');
  } catch (e: any) {
    unauthorizedPromoteBlocked = e.message.includes('Only the community lead');
  }
  assert(unauthorizedPromoteBlocked, 'Unauthorized user blocked from updating guild leadership roles');

  // 16d: Publishing official announcements vs discussions
  // Lead publishes official announcement
  const announcementPost = communityService.createCommunityPost(createdGuild.id, 'u-ayodele', {
    content: 'First General Assembly on Embedded Quadcopter Avionics this Saturday at SEET.',
    isAnnouncement: true,
    announcementUrgency: 'high',
  });
  assert(announcementPost.isAnnouncement === true, 'Created official guild announcement');
  assert(announcementPost.isPinned === true, 'Guild announcement is automatically pinned');
  assert(announcementPost.announcementUrgency === 'high', 'Announcement preserves high urgency flag');

  // Non-lead/non-mod ordinary member attempt to post announcement is blocked
  const damiJoinRes = communityService.toggleMembership(createdGuild.id, 'u-dami');
  assert(damiJoinRes.isJoined === true, 'Dami joined guild as ordinary member');

  let unauthorizedAnnouncementBlocked = false;
  try {
    communityService.createCommunityPost(createdGuild.id, 'u-dami', {
      content: 'Unauthorized executive announcement attempt.',
      isAnnouncement: true,
    });
  } catch (e: any) {
    unauthorizedAnnouncementBlocked = e.message.includes('Only community leads');
  }
  assert(unauthorizedAnnouncementBlocked, 'Ordinary member blocked from publishing executive announcement');

  // Ordinary member CAN post normal discussion
  const discussionPost = communityService.createCommunityPost(createdGuild.id, 'u-dami', {
    content: 'Does anyone have spare STM32 microcontroller boards for testing?',
    isAnnouncement: false,
  });
  assert(discussionPost.isAnnouncement === false && discussionPost.communityId === createdGuild.id, 'Member successfully published discussion');

  // 16e: Community Edit Information
  const editedGuild = communityService.editCommunity(createdGuild.id, 'u-ayodele', 'student', {
    name: 'FUTA Autonomous Robotics & Drone Guild',
    description: 'Updated charter covering autonomous drones and sub-surface sensors.',
  });
  assert(editedGuild?.name === 'FUTA Autonomous Robotics & Drone Guild', 'Lead updated permitted community information');

  // --- Step 17: STAGE 6 - Campus & Off-Campus Landmarks (Zero Paid Map APIs) ---
  console.log('\n--- 17. Testing Campus Landmarks & Off-Campus Pinning ---');
  landmarkService.ensureLandmarksSeeded();

  const allLandmarks = landmarkService.getAllLandmarks();
  assert(allLandmarks.length >= 16, `Loaded ${allLandmarks.length} recognized FUTA landmarks`);

  const onCampusSpots = landmarkService.getAllLandmarks({ zone: 'on_campus' });
  const offCampusSpots = landmarkService.getAllLandmarks({ zone: 'off_campus' });
  assert(onCampusSpots.length > 0, `Filtered ${onCampusSpots.length} On-Campus (Obanla) landmarks`);
  assert(offCampusSpots.length > 0, `Filtered ${offCampusSpots.length} Off-Campus (South Gate / Town) spots`);

  // Verify landmark fields and coordinates
  const etf3 = allLandmarks.find((l) => l.id === 'spot-etf3');
  assert(etf3 !== undefined && etf3.coordinates[0] === 7.3048 && etf3.coordinates[1] === 5.136, 'Landmark ETF 3 has accurate coordinates');

  const titans = allLandmarks.find((l) => l.id === 'spot-titans');
  assert(titans !== undefined && titans.isOffCampus === true, 'Titans Hostel identified as Off-Campus');

  // Search landmark
  const searchResults = landmarkService.getAllLandmarks({ search: 'South Gate' });
  assert(searchResults.length >= 1, `Landmark search for "South Gate" returned ${searchResults.length} matches`);

  // Pinning landmark increments pin count
  const pinCountBefore = etf3?.pinnedCount || 0;
  landmarkService.incrementPinCount('spot-etf3');
  const etf3Updated = landmarkService.getLandmarkById('spot-etf3');
  assert(etf3Updated !== null && etf3Updated.pinnedCount === pinCountBefore + 1, 'Pinning landmark correctly increments pinned count');

  // --- Step 18: 100% Free Platform Access & Historical Financial Record Preservation ---
  console.log('\n--- 18. Testing 100% Free Platform Access & Historical Financial Record Preservation ---');

  // 18.1: Legacy user registered >210 days ago with ZERO subscriptions/payments has unrestricted chat & platform access
  db.prepare("DELETE FROM user_profiles WHERE handle LIKE '@legacy_free_%'").run();
  db.prepare("DELETE FROM users WHERE username LIKE '@legacy_free_%'").run();

  const legacyFreeUserId = `u-free-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const legacyFreeHandle = `@legacy_free_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(`
    INSERT INTO users (id, matric_number, username, email, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, 'hashed', 'student', datetime('now', '-210 days'))
  `).run(legacyFreeUserId, `CSC/${Date.now().toString().slice(-4)}/001`, legacyFreeHandle, `legacy_free_${Date.now()}@futa.edu.ng`);

  db.prepare(`
    INSERT INTO user_profiles (
      id, user_id, name, handle, department, school, level, hall_of_residence,
      campus, bio, avatar_initials, avatar_bg, verified
    ) VALUES (?, ?, 'Legacy Free Scholar', ?, 'SEET', 'Engineering', '400L', 'Titans Hall', 'Obanla', 'Bio', 'LF', 'bg-stone-800 text-stone-100', 0)
  `).run(`prof-${legacyFreeUserId}`, legacyFreeUserId, legacyFreeHandle);

  const openChat = chatService.createDirectChat(legacyFreeUserId, 'u-ayodele');
  const freeChatMsg = chatService.sendMessage(openChat.chatId, legacyFreeUserId, {
    text: 'Unrestricted 100% free message from legacy (>210d) student with zero subscription!',
  });
  assert(Boolean(freeChatMsg && freeChatMsg.id), 'Legacy user (>210d, zero subscriptions) sends chat messages freely');

  const openPost = postService.createPost(legacyFreeUserId, {
    content: 'Open 100% free campus dispatch from legacy scholar.',
    school_tag: 'SEET',
  });
  assert(openPost !== null && openPost.id.startsWith('post-'), 'Legacy user creates posts freely without fees or trials');

  const freeComment = commentReactionService.addComment(openPost!.id, 'u-dami', 'Free comment reply check');
  assert(Boolean(freeComment && freeComment.id), 'Comments and reactions work freely');

  // 18.2: Historical financial records (payments, subscriptions, payment_audit_logs) stay intact across DB init
  const historicalPalmId = `pay-hist-palmpay-${Date.now()}`;
  const historicalFcmbId = `pay-hist-fcmb-${Date.now()}`;
  const historicalMnpId = `pay-hist-mnp-${Date.now()}`;
  db.prepare(`
    INSERT INTO payments (id, user_id, reference, channel, amount_kobo, currency, purpose, status, paid_at)
    VALUES (?, ?, ?, 'palmpay', 150000, 'NGN', 'subscription', 'confirmed', CURRENT_TIMESTAMP),
           (?, ?, ?, 'fcmb', 500000, 'NGN', 'subscription', 'confirmed', CURRENT_TIMESTAMP),
           (?, ?, ?, 'moniepoint', 150000, 'NGN', 'subscription', 'confirmed', CURRENT_TIMESTAMP)
  `).run(
    historicalPalmId,
    legacyFreeUserId,
    `HIST-PLM-${Date.now()}`,
    historicalFcmbId,
    legacyFreeUserId,
    `HIST-FCMB-${Date.now()}`,
    historicalMnpId,
    legacyFreeUserId,
    `HIST-MNP-${Date.now()}`
  );

  // Re-running initDatabase() preserves historical ledger tables & rows while cleaning payment feature settings
  initDatabase();
  const histPreserved = db.prepare(`SELECT COUNT(*) as c FROM payments WHERE id IN (?, ?, ?)`).get(
    historicalPalmId,
    historicalFcmbId,
    historicalMnpId
  ) as any;
  assert(histPreserved.c === 3, 'Historical PalmPay, FCMB, and Moniepoint payment rows remain preserved untouched in database');

  // Clean up Step 18 temporary test user & rows
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(openChat.chatId);
  db.prepare('DELETE FROM chat_participants WHERE chat_id = ?').run(openChat.chatId);
  db.prepare('DELETE FROM chats WHERE id = ?').run(openChat.chatId);
  db.prepare('DELETE FROM comments WHERE post_id = ?').run(openPost!.id);
  db.prepare('DELETE FROM payments WHERE user_id = ?').run(legacyFreeUserId);
  db.prepare('DELETE FROM posts WHERE author_id = ?').run(legacyFreeUserId);
  db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(legacyFreeUserId);
  db.prepare('DELETE FROM users WHERE id = ?').run(legacyFreeUserId);

  // --- Step 19: STAGE 8 Administration, Security, Privacy & Data Deletion ---
  console.log('\n--- 19. Testing Stage 8 Administration, RBAC, Moderation, Deletion & Backups ---');

  // 19a: Real Dashboard Statistics (live queries, zero mocks)
  const dashboardStats = adminSecurityService.getDashboardStatistics();
  assert(dashboardStats.users.total > 0, 'Dashboard returns real count of registered users');
  assert(dashboardStats.users.staff >= 1, 'Dashboard counts administrative and staff personnel');
  assert(dashboardStats.content.posts >= 0, 'Dashboard returns real count of campus posts');
  assert(dashboardStats.storage.databaseBytes > 0, 'Storage utilisation reports real database file size in bytes');
  assert(dashboardStats.deletionJobs.retentionPolicy.includes('72-Hour'), 'Documents 72-hour ephemeral retention policy');

  // 19b: Role-Based Access Control (RBAC) & Least-Privilege Matrix
  const testStudentUser = db.prepare("SELECT * FROM users WHERE id = 'u-ayodele' OR role = 'student'").get() as any;
  assert(testStudentUser !== null && testStudentUser !== undefined, 'Found existing student for RBAC test');

  const adminActor = (db.prepare("SELECT * FROM users WHERE role = 'admin'").get() as any) || { id: 'u-admin', role: 'admin' };

  // Normal student cannot give themselves or others administrative privileges
  let studentPrivilegeEscalationBlocked = false;
  try {
    adminSecurityService.assignStaffRole(testStudentUser.id, 'student', testStudentUser.id, 'admin');
  } catch (err: any) {
    studentPrivilegeEscalationBlocked = err.message.includes('Only an Admin');
  }
  assert(studentPrivilegeEscalationBlocked, 'RBAC Rule: Normal student cannot elevate themselves to admin or assign staff roles');

  // Single Admin CAN assign 'admin' role
  const promoteResult = adminSecurityService.assignStaffRole(adminActor.id, 'admin', testStudentUser.id, 'admin');
  assert(promoteResult.success === true, 'Admin successfully assigns single Admin role');
  assert(promoteResult.newRole === 'admin', 'User role upgraded to admin');

  // Demote back to student
  adminSecurityService.assignStaffRole(adminActor.id, 'admin', testStudentUser.id, 'student');
  const restoredRoleUser = userService.getUserById(testStudentUser.id);
  assert(restoredRoleUser?.role === 'student', 'User role cleanly demoted back to student');

  // 19c: User Warnings & Community Notification
  const warningResult = adminSecurityService.issueWarning(
    adminActor.id,
    'admin',
    testStudentUser.id,
    'Posting unverified examination timetable rumor',
    'standard',
    'First offense notice regarding Examination Malpractice policy.'
  );
  assert(warningResult.success === true, 'Warning issued successfully by admin');
  assert(warningResult.severity === 'standard', 'Warning recorded with standard severity');

  const studentNotifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(testStudentUser!.id) as any;
  assert(studentNotifs?.title.includes('Guideline Notice'), 'In-app notification delivered to warned student');

  // 19d: Temporary Account Suspension & Session Invalidation
  // Create a temporary student to test suspension & session kill
  const suspendCandidateId = `u-susp-${Date.now()}`;
  db.prepare(`
    INSERT INTO users (id, matric_number, username, email, password_hash, role, status)
    VALUES (?, ?, '@trouble_maker', 'trouble@futa.edu.ng', 'hash', 'student', 'active')
  `).run(suspendCandidateId, `SUSP/${Date.now().toString().slice(-4)}/999`);

  // Create an active session for the candidate
  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES ('test-active-session-token', ?, datetime('now', '+7 days'))
  `).run(suspendCandidateId);

  const activeSessionsBefore = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(suspendCandidateId) as any;
  assert(activeSessionsBefore.c === 1, 'Active session exists for student prior to suspension');

  const suspensionResult = adminSecurityService.suspendUser(
    adminActor.id,
    'admin',
    suspendCandidateId,
    3,
    'Repeated spam dispatches in South Gate feed'
  );
  assert(suspensionResult.status === 'suspended', 'User status transitioned to suspended');

  const activeSessionsAfter = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(suspendCandidateId) as any;
  assert(activeSessionsAfter.c === 0, 'Active sessions killed immediately upon account suspension');

  // 19e: Student Appeals & Moderation Review
  const appeal = adminSecurityService.submitAppeal(
    suspendCandidateId,
    'suspension',
    'I apologize for the spam dispatches. My younger sibling was using my phone. I have reviewed the guidelines and will adhere strictly.'
  );
  assert(appeal.status === 'pending', 'Appeal submitted in pending status');
  assert(appeal.type === 'suspension', 'Appeal registered for suspension');

  // Admin reviews and accepts the appeal
  const appealReview = adminSecurityService.reviewAppeal(
    adminActor.id,
    'admin',
    appeal.id,
    'accepted',
    'First offense forgiven with stern admonition.'
  );
  assert(appealReview.status === 'accepted', 'Appeal accepted by moderation desk');

  const unsuspendedUser = db.prepare('SELECT status, suspension_reason FROM users WHERE id = ?').get(suspendCandidateId) as any;
  assert(unsuspendedUser.status === 'active', 'User automatically unsuspended upon accepted suspension appeal');
  assert(unsuspendedUser.suspension_reason === null, 'Suspension reason cleared');

  // Clean up candidate
  db.prepare('DELETE FROM appeals WHERE user_id = ?').run(suspendCandidateId);
  db.prepare('DELETE FROM users WHERE id = ?').run(suspendCandidateId);

  // 19f: Input Sanitization (XSS & Script Injection Prevention)
  const maliciousInput = '<script>alert("pwned")</script>Hello FUTA <img src="x" onerror="stealCookies()"/> <a href="javascript:alert(1)">Click</a>';
  const sanitized = adminSecurityService.sanitizeText(maliciousInput);
  assert(!sanitized.includes('<script>'), 'Sanitization stripped <script> tags');
  assert(!sanitized.includes('onerror='), 'Sanitization stripped onerror event handlers');
  assert(!sanitized.includes('javascript:'), 'Sanitization stripped javascript: pseudo-schemes');
  assert(sanitized.includes('Hello FUTA'), 'Legitimate text preserved');

  // 19g: File Upload Restriction (<=20MB, valid image format)
  const validJpegMock = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
  const validMockImage = `data:image/jpeg;base64,${validJpegMock.toString('base64')}`;
  const validUpload = adminSecurityService.validateFileUpload(validMockImage, 'image/jpeg', 20 * 1024 * 1024);
  assert(validUpload.valid === true, 'Valid JPEG file within 20MB accepted');

  let invalidMimeBlocked = false;
  try {
    adminSecurityService.validateFileUpload(validMockImage, 'application/x-executable');
  } catch (err: any) {
    invalidMimeBlocked = err.message.includes('Unsupported image format');
  }
  assert(invalidMimeBlocked, 'Non-image executable mime type blocked');

  // 19h: Bot Protection (Honeypot trap verification)
  const humanRequest = { username: '@new_scholar', matric_number: 'EEE/21/1111' };
  assert(adminSecurityService.verifyBotProtection(humanRequest) === true, 'Legitimate human request passes bot check');

  const botRequest = { username: '@spam_bot', _hp_security_check: 'automated-val' };
  assert(adminSecurityService.verifyBotProtection(botRequest) === false, 'Bot submission with honeypot trap caught and rejected');

  // 19i: Permanent Account Deletion & Right to be Forgotten (NDPA 2023)
  db.prepare("DELETE FROM users WHERE email LIKE 'del%@futa.edu.ng'").run();
  const deleteTargetId = `u-del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const deleteHandle = `@del_${Date.now().toString().slice(-4)}`;
  db.prepare(`
    INSERT INTO users (id, matric_number, username, email, password_hash, role)
    VALUES (?, ?, ?, ?, 'hash', 'student')
  `).run(deleteTargetId, `DEL/${Date.now().toString().slice(-4)}/000`, deleteHandle, `del_${Date.now()}@futa.edu.ng`);

  db.prepare(`
    INSERT INTO user_profiles (
      id, user_id, name, handle, department, school, level, hall_of_residence,
      campus, bio, avatar_initials, avatar_bg, verified
    ) VALUES (?, ?, 'Delete Candidate', ?, 'CPE', 'SEET', '400L', 'Titans Hall', 'Obanla', 'Bio', 'DC', 'bg-stone-800 text-stone-100', 0)
  `).run(`prof-${deleteTargetId}`, deleteTargetId, deleteHandle);

  // Add dummy post and comment for candidate
  db.prepare(`
    INSERT INTO posts (id, author_id, content, school_tag)
    VALUES (?, ?, 'Content to be permanently forgotten.', 'SEET')
  `).run(`post-${deleteTargetId}`, deleteTargetId);

  db.prepare(`
    INSERT INTO comments (id, post_id, author_id, content)
    VALUES (?, ?, ?, 'Comment to be wiped.')
  `).run(`c-${deleteTargetId}`, `post-${deleteTargetId}`, deleteTargetId);

  const deleteResult = adminSecurityService.deleteUserPermanently(deleteTargetId, deleteTargetId, 'Student invoked Right to be Forgotten');
  assert(deleteResult.status === 'permanently_erased', 'Account permanently erased');

  // Verify zero orphaned records across all tables
  const userCheck = db.prepare('SELECT COUNT(*) as c FROM users WHERE id = ?').get(deleteTargetId) as any;
  const profileCheck = db.prepare('SELECT COUNT(*) as c FROM user_profiles WHERE user_id = ?').get(deleteTargetId) as any;
  const postsCheck = db.prepare('SELECT COUNT(*) as c FROM posts WHERE author_id = ?').get(deleteTargetId) as any;
  const commentsCheck = db.prepare('SELECT COUNT(*) as c FROM comments WHERE author_id = ?').get(deleteTargetId) as any;
  assert(userCheck.c === 0, 'Core user row deleted');
  assert(profileCheck.c === 0, 'User profile row deleted');
  assert(postsCheck.c === 0, 'Associated posts completely deleted');
  assert(commentsCheck.c === 0, 'Associated comments completely deleted');

  // Verify deletion tombstone
  const tombstone = db.prepare('SELECT * FROM deletion_tombstones WHERE id = ?').get(deleteResult.tombstoneId) as any;
  assert(tombstone !== null, 'Cryptographic deletion tombstone recorded');
  assert(tombstone.records_purged >= 15, 'Tombstone verifies cascading across system tables');

  // 19j: Database Backups & Tombstone Reconciliation
  const backup = adminSecurityService.createBackup(adminActor.id, 'admin');
  assert(backup.id.startsWith('snap-'), 'Backup snapshot created');
  assert(backup.checksum.length === 64, 'SHA-256 checksum calculated for backup integrity');
  assert(backup.retentionPolicy.includes('14-Day'), 'Truthful backup lifecycle documented (14-Day Automated Rotation)');

  const backupsList = adminSecurityService.getBackups();
  assert(backupsList.length >= 1, 'Backup list retrieves created snapshots');

  // 19k: 72-Hour Ephemeral Retention Purge Job
  const purgeSummary = adminSecurityService.run72HourPurgeJob('u-system-job');
  assert(typeof purgeSummary.messagesPurged === 'number', '72-Hour purge job reports purged messages count');
  assert(typeof purgeSummary.postsPurged === 'number', '72-Hour purge job reports unpinned expired dispatches count');

  // --- Step 20: STAGE 9 - Scalability, Live Presence, Caching & Pagination ---
  console.log('\n--- 20. Testing Stage 9 Presence, Privacy, Pagination, Caching & Telemetry ---');

  // 20a: Multi-tab deduplication (same user across 3 tabs = 1 unique user online)
  db.prepare('DELETE FROM user_presence_clients').run();
  db.prepare('DELETE FROM user_presence').run();
  cache.clear();

  presenceService.recordHeartbeat('u-ayodele', 'tab-a-1', 'TestBrowser/1.0');
  presenceService.recordHeartbeat('u-ayodele', 'tab-a-2', 'TestBrowser/1.0');
  presenceService.recordHeartbeat('u-ayodele', 'tab-a-3', 'TestBrowser/1.0');

  let onlineSummary = presenceService.getOnlineSummary();
  assert(onlineSummary.onlineCount === 1, '3 tabs for 1 authenticated user count as 1 unique user online');
  assert(onlineSummary.message === '1 student online now.', `Online message formatted cleanly: "${onlineSummary.message}"`);

  // Closing 1 tab leaves user online
  onlineSummary = presenceService.removeClientPresence('u-ayodele', 'tab-a-1');
  assert(onlineSummary.onlineCount === 1, 'Closing 1 of 3 tabs preserves user online state');

  // Add second distinct user
  presenceService.recordHeartbeat('u-dami', 'tab-d-1', 'MobileBrowser/1.0');
  onlineSummary = presenceService.getOnlineSummary();
  assert(onlineSummary.onlineCount === 2, '2 distinct authenticated users count as 2 students online');
  assert(onlineSummary.message === '2 students online now.', `Plural online message formatted cleanly: "${onlineSummary.message}"`);
  assert(!('users' in (onlineSummary as any)) && !('emails' in (onlineSummary as any)), 'Public online summary leaks zero PII');

  // 20b: Online visibility privacy preference
  userService.updateProfile('u-dami', { show_online_status: false }, 'student');
  onlineSummary = presenceService.getOnlineSummary();
  assert(onlineSummary.onlineCount === 1, 'Hidden user (show_online_status=false) excluded from public online count');

  const adminPresence = presenceService.getAdminBreakdown();
  assert(adminPresence.totalAuthenticatedOnlineCount === 2, 'Admin telemetry accurately tracks total authenticated online users');
  assert(adminPresence.visibleOnlineCount === 1, 'Admin telemetry accurately tracks visible public online users');
  assert(adminPresence.activeClientSessions === 3, 'Admin telemetry tracks 3 active tab client sessions');

  // Restore visibility
  userService.updateProfile('u-dami', { show_online_status: true }, 'student');

  // 20c: Inactive presence expiration sweep
  db.prepare(`
    UPDATE user_presence_clients SET expires_at = datetime('now', '-5 minutes') WHERE user_id = 'u-dami'
  `).run();
  db.prepare(`
    UPDATE user_presence SET expires_at = datetime('now', '-5 minutes') WHERE user_id = 'u-dami'
  `).run();
  const expiredRes = presenceService.expireInactivePresence();
  assert(expiredRes.purgedUsers >= 1 && expiredRes.purgedClients >= 1, 'Expired presence records purged cleanly by sweep');
  assert(presenceService.getOnlineSummary().onlineCount === 1, 'Online count decrements after inactive presence expiry');

  // 20d: Chat partner online status honors real presence
  const ayodeleChats = chatService.getUserChats('u-ayodele');
  assert(Array.isArray(ayodeleChats), 'Batched getUserChats executes without N+1 errors');

  // 20e: Feed pagination & cache hit/miss verification
  const page1 = postService.getFeedPostsPaginated('u-ayodele', { limit: 2, offset: 0, filter: 'all' });
  assert(page1.posts.length <= 2 && page1.total >= page1.posts.length, 'Paginated feed returns valid slice & total count');

  const statsBeforeCache = cache.getStats();
  postService.getFeedPostsPaginated('u-ayodele', { limit: 2, offset: 0, filter: 'all' });
  const statsAfterCache = cache.getStats();
  assert(statsAfterCache.hits > statsBeforeCache.hits, 'Repeated feed read hits shared TTL cache');

  // 20f: Stage 9 Admin Statistics (DAU/WAU/MAU, Registrations, Pending/Failed Jobs, System Health)
  cache.invalidatePrefix('admin:dashboard');
  const stage9Stats = adminSecurityService.getDashboardStatistics();
  assert(typeof stage9Stats.users.dau === 'number' && stage9Stats.users.dau >= 1, 'Admin telemetry computes real DAU');
  assert(typeof stage9Stats.users.wau === 'number' && stage9Stats.users.wau >= stage9Stats.users.dau, 'Admin telemetry computes real WAU >= DAU');
  assert(typeof stage9Stats.users.mau === 'number' && stage9Stats.users.mau >= stage9Stats.users.wau, 'Admin telemetry computes real MAU >= WAU');
  assert(typeof stage9Stats.users.newRegistrations24h === 'number', 'Admin telemetry tracks 24h registrations');
  assert(typeof stage9Stats.deletionJobs.totalPendingDeletions === 'number', 'Admin telemetry tracks pending deletion jobs');
  assert(typeof stage9Stats.jobs?.failedJobsCount === 'number' && Array.isArray(stage9Stats.jobs?.recentJobs), 'Admin telemetry tracks background jobs & failure count');
  assert(typeof stage9Stats.system.dbLatencyMs === 'number' && stage9Stats.system.memoryRssMb > 0, 'Admin telemetry measures real DB latency & process memory');

  // --- Step 21: SINGLE ADMIN ROLE & COMPLETE DASHBOARD CONTROL ---
  console.log('\n--- 21. Testing Single Admin Role, Feature Management, Settings, Storage Orphans & MFA ---');

  // 21a: Enforce single 'admin' role (rejects legacy 'superadmin' at SQLite CHECK level)
  let legacySuperadminRejected = false;
  try {
    db.prepare(`
      INSERT INTO users (id, matric_number, username, email, password_hash, role)
      VALUES ('u-bad-role', 'BAD/00/000', '@bad_role', 'bad@futa.edu.ng', 'hash', 'superadmin')
    `).run();
  } catch {
    legacySuperadminRejected = true;
  }
  assert(legacySuperadminRejected, 'DB Schema strictly forbids legacy superadmin role (only admin/staff/student permitted)');

  // Prevent demoting the last active Admin
  let lastAdminProtected = false;
  try {
    adminSecurityService.assignStaffRole(adminActor.id, 'admin', adminActor.id, 'student');
  } catch (err: any) {
    lastAdminProtected = err.message.includes('At least one active Admin');
  }
  assert(lastAdminProtected, 'Safeguard prevents demoting the sole remaining Admin account');

  // 21b: Admin user creation, profile edit, and permanent deletion
  const adminCreated = adminControlService.createUserByAdmin(adminActor.id, {
    username: '@adm_created',
    password: 'Password123!',
    name: 'Created Scholar',
    role: 'student',
    department: 'MEE',
    level: '200L',
  });
  assert(adminCreated.role === 'student' && adminCreated.username === '@adm_created', 'Admin creates student account cleanly');

  const editedUser = adminControlService.updateUserProfileByAdmin(adminActor.id, adminCreated.id, {
    department: 'CPE',
    level: '300L',
  });
  assert(editedUser?.department === 'CPE' && editedUser?.level === '300L', 'Admin edits user profile details');

  const erasedCreated = adminSecurityService.deleteUserPermanently(adminCreated.id, adminActor.id, 'Test cleanup');
  assert(erasedCreated.status === 'permanently_erased', 'Admin permanently deletes user account');

  // 21c: Content moderation (hide/pin) & privacy-guarded chat inspection with required reason
  const modPost = postService.createPost('u-ayodele', { content: 'Admin visibility toggle test dispatch' });
  adminControlService.togglePostVisibility(adminActor.id, modPost!.id, true);
  const hiddenRow = db.prepare('SELECT is_hidden FROM posts WHERE id = ?').get(modPost!.id) as any;
  assert(hiddenRow.is_hidden === 1, 'Admin hides post from public feed');
  adminControlService.togglePostVisibility(adminActor.id, modPost!.id, false);
  adminControlService.togglePostPinned(adminActor.id, modPost!.id, true);
  const pinnedRow = db.prepare('SELECT is_pinned FROM posts WHERE id = ?').get(modPost!.id) as any;
  assert(pinnedRow.is_pinned === 1, 'Admin pins post cleanly');

  const chatRows = adminControlService.listChatsModerationOverview();
  if (chatRows.length > 0) {
    let reasonRequired = false;
    try {
      adminControlService.inspectChatForModeration(adminActor.id, chatRows[0].id, 'short');
    } catch {
      reasonRequired = true;
    }
    assert(reasonRequired, 'Chat moderation inspection requires documented 10+ character reason');

    const inspected = adminControlService.inspectChatForModeration(
      adminActor.id,
      chatRows[0].id,
      'Investigating reported harassment claim #104'
    );
    assert(Array.isArray(inspected.messages), 'Admin chat inspection returns thread messages with audit entry');
  }

  // 21d: Broadcast notifications & communities admin controls
  const broadcastRes = adminControlService.broadcastNotification(adminActor.id, {
    title: 'Admin Test Broadcast',
    body: 'Senate ICT verification test',
    targetUserId: 'u-ayodele',
  });
  assert(broadcastRes.deliveredCount === 1, 'Admin broadcasts notification cleanly');

  const commCountBefore = adminControlService.listCommunitiesAdmin().length;
  assert(commCountBefore >= 1, 'Admin lists all communities');

  // 21e: Feature Management (disabling preserves existing data; configurable limits & custom flags)
  const disableComm = adminControlService.updateFeature(adminActor.id, 'communities', { enabled: false, visibleInNav: false });
  assert(disableComm?.enabled === false && disableComm?.visibleInNav === false, 'Admin disables communities & hides from nav');
  const commGuardBlocked = adminControlService.checkFeatureAccess('communities');
  assert(!commGuardBlocked.allowed && commGuardBlocked.status === 403, 'Disabled feature enforces 403 server guard');
  assert(adminControlService.listCommunitiesAdmin().length === commCountBefore, 'Disabling feature NEVER deletes existing database records');
  adminControlService.updateFeature(adminActor.id, 'communities', { enabled: true, visibleInNav: true });

  const customFeat = adminControlService.registerConfigurableFeature(adminActor.id, {
    key: 'exam_schedule',
    name: 'Exam Timetable Checker',
    description: 'Configurable feature flag for semester exams',
    category: 'discovery',
    limits: { maxDaysAhead: 14 },
  });
  assert(customFeat?.key === 'exam_schedule', 'Admin registers custom configurable feature flag cleanly');

  // 21f: Website Settings (Maintenance mode & Registration toggle)
  adminControlService.updateWebsiteSettings(adminActor.id, { allow_new_registrations: 'false' });
  let publicRegBlocked = false;
  try {
    authService.register({
      username: '@blocked_reg',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
  } catch (err: any) {
    publicRegBlocked = err.message.includes('paused');
  }
  assert(publicRegBlocked, 'Public registration is blocked when Admin sets allow_new_registrations=false');
  adminControlService.updateWebsiteSettings(adminActor.id, { allow_new_registrations: 'true' });

  adminControlService.updateWebsiteSettings(adminActor.id, { maintenance_mode: 'true' });
  const maintCheck = adminControlService.checkFeatureAccess('posts');
  assert(!maintCheck.allowed && maintCheck.status === 503, 'Global maintenance mode enforces 503 service unavailable guard');
  adminControlService.updateWebsiteSettings(adminActor.id, { maintenance_mode: 'false' });

  // 21g: 10 GB Storage Quota, Orphaned Upload Detection & Cleanup, Cache Clear & Report
  fs.mkdirSync(process.env.SCHOOLBACKDOOR_UPLOADS_DIR!, { recursive: true });
  const orphanPath = path.join(process.env.SCHOOLBACKDOOR_UPLOADS_DIR!, 'orphan-test-artifact.jpg');
  fs.writeFileSync(orphanPath, Buffer.from('unreferenced bytes'));

  const storageBefore = adminControlService.getStorageOverview();
  assert(storageBefore.quotaGb === 10, 'Storage quota configured to 10 GB');
  assert(storageBefore.orphans.count >= 1 && storageBefore.orphans.filenames.includes('orphan-test-artifact.jpg'), 'Storage scanner identifies genuine unreferenced upload file');

  const orphanCleanRes = adminControlService.cleanOrphanedFiles(adminActor.id);
  assert(orphanCleanRes.deletedCount >= 1 && !fs.existsSync(orphanPath), 'Orphan cleanup removes unreferenced disk file while keeping active DB records');

  const cacheClearRes = adminControlService.clearExpiredCaches(adminActor.id);
  assert(cacheClearRes.success === true, 'Clear expired caches succeeds');

  const storageReport = adminControlService.generateStorageReport(adminActor.id);
  assert(
    storageReport.targetLimitGb === 10 && typeof storageReport.recordCounts.payments === 'number',
    'Storage report tracks historical payment/account archives within 10GB target'
  );

  // 21h: Admin RFC-6238 TOTP MFA setup, verification & login enforcement
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword('AdminPass123!'), adminActor.id);
  const mfaSetup = adminControlService.initiateAdminMfaSetup(adminActor.id, '@THEBACKDOOR');
  const validCode = computeTotpCode(mfaSetup.secret);
  const mfaVerifyRes = adminControlService.verifyAndEnableAdminMfa(adminActor.id, validCode);
  assert(mfaVerifyRes.mfaEnabled === true, 'Admin MFA activated after valid 6-digit RFC-6238 TOTP code');

  let loginWithoutMfaBlocked = false;
  try {
    authService.login(adminActor.username, 'AdminPass123!');
  } catch (err: any) {
    loginWithoutMfaBlocked = err.message.startsWith('MFA_REQUIRED:');
  }
  assert(loginWithoutMfaBlocked, 'Admin login blocked when MFA is enabled and no TOTP code supplied');

  const loginWithMfa = authService.login(adminActor.username, 'AdminPass123!', undefined, undefined, computeTotpCode(mfaSetup.secret));
  assert(Boolean(loginWithMfa.token), 'Admin login succeeds when valid 6-digit TOTP code supplied');

  adminControlService.disableAdminMfa(adminActor.id, 'AdminPass123!');

  // --- Step 22: Strict 10GB Storage Budget, 72h Expiry, Deduplication, Encrypted Backups & Redacted Logs ---
  console.log('\n--- 22. Testing 10GB Storage Protection, Strict 72h Expiry, Encrypted Backups & Deduplication ---');

  // 22a: SHA-256 Upload Deduplication & Thumbnail Storage
  const tinyPngDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const up1 = fileService.saveBase64Image(tinyPngDataUrl, 'u-ayodele', { thumbnailDataUrl: tinyPngDataUrl });
  const up2 = fileService.saveBase64Image(tinyPngDataUrl, 'u-ayodele');
  assert(up1.filename === up2.filename && up1.url === up2.url, 'SHA-256 upload deduplication reuses identical image file');
  assert(Boolean(up1.thumbnailUrl), 'Optional compact thumbnail variant persisted alongside full image');

  // 22b: Strict 72-hour UTC backend expiry across posts, community posts, comments, replies, likes, notifications & direct upload links
  const expPost = postService.createPost('u-ayodele', {
    content: 'Ephemeral 72h test dispatch with media',
    images: [up1.url],
  });
  const expReplyParent = commentReactionService.addComment(expPost!.id, 'u-dami', 'Top-level comment on ephemeral dispatch');
  const expReplyChild = commentReactionService.addComment(
    expPost!.id,
    'u-ayodele',
    'Anchored reply on ephemeral dispatch',
    expReplyParent.id
  );
  commentReactionService.toggleLike(expPost!.id, 'u-dami');
  assert(expReplyChild.parentCommentId === expReplyParent.id, 'Nested comment reply anchors to parentCommentId');
  assert(fileService.isFileAccessible(up1.filename) === true, 'Active upload file is accessible before 72h expiry');

  // Force post & notification timestamps past 72h UTC
  db.prepare(`UPDATE posts SET created_at = datetime('now', '-73 hours') WHERE id = ?`).run(expPost!.id);
  db.prepare(`UPDATE notifications SET created_at = datetime('now', '-73 hours') WHERE link LIKE ?`).run(`%post=${expPost!.id}%`);
  cache.clear();

  assert(postService.getPostById(expPost!.id, 'u-ayodele') === null, 'Expired >72h post immediately hidden from getPostById');
  assert(
    !postService.getFeedPosts('u-ayodele', 50, 0).some((p) => p.id === expPost!.id),
    'Expired >72h post immediately excluded from feed queries'
  );
  assert(
    fileService.isFileAccessible(up1.filename) === false,
    'Direct /api/uploads/:filename access blocked immediately once referencing post expires (>72h)'
  );

  let commentOnExpiredBlocked = false;
  try {
    commentReactionService.addComment(expPost!.id, 'u-dami', 'Late comment attempt');
  } catch {
    commentOnExpiredBlocked = true;
  }
  assert(commentOnExpiredBlocked, 'Comments/likes on expired (>72h) posts are rejected by backend');

  const activePostBeforePurge = postService.createPost('u-ayodele', {
    content: 'Active post created now must survive 72h purge sweep',
  });
  const strictPurge1 = adminSecurityService.run72HourPurgeJob(adminActor.id);
  assert(
    strictPurge1.postsPurged >= 1 && strictPurge1.filesDeleted >= 1,
    '72h lifecycle sweep purges expired post, comments, likes, notifications, and physical upload files'
  );
  assert(
    postService.getPostById(activePostBeforePurge!.id, 'u-ayodele') !== null,
    'Active non-expired post survives automated 72h purge sweep'
  );
  const strictPurge2 = adminSecurityService.run72HourPurgeJob(adminActor.id);
  assert(strictPurge2.postsPurged === 0, '72h lifecycle sweep is idempotent on consecutive execution');

  // 22c: Anonymized 7-year accounting retention on permanent user erasure + AES-256-GCM encrypted backup verify
  const acctDelId = `u-acct-${Date.now()}`;
  const acctUpload = fileService.saveBase64Image(tinyPngDataUrl, acctDelId);
  db.prepare(`
    INSERT INTO users (id, matric_number, username, email, password_hash, role)
    VALUES (?, 'CSC/24/7777', '@acct_erasure', 'acct_erasure@futa.edu.ng', 'hash', 'student')
  `).run(acctDelId);
  db.prepare(`
    INSERT INTO user_profiles (
      id, user_id, name, handle, department, school, level, hall_of_residence,
      campus, bio, avatar_initials, avatar_bg, avatar_url, verified
    ) VALUES (?, ?, 'Accounting Retention Test', '@acct_erasure', 'CSC', 'SOC', '200L', 'Jibowu', 'Obanla', '', 'AR', 'bg-stone-800', ?, 0)
  `).run(`prof-${acctDelId}`, acctDelId, acctUpload.url);
  db.prepare(`
    INSERT INTO payments (id, user_id, reference, channel, amount_kobo, currency, purpose, status, paid_at)
    VALUES (?, ?, ?, 'palmpay', 150000, 'NGN', 'subscription', 'confirmed', CURRENT_TIMESTAMP)
  `).run(`pay-${acctDelId}`, acctDelId, `REF-ACCT-${Date.now()}`);

  const acctEraseOutcome = adminSecurityService.deleteUserPermanently(acctDelId, acctDelId, 'Verify anonymized accounting retention');
  assert(acctEraseOutcome.retainedAccountingRows === 1 && acctEraseOutcome.filesDeleted >= 1, 'Permanent user deletion archives anonymized payment row and wipes uploaded file');
  const retainedRow = db.prepare(`SELECT * FROM retained_accounting_records WHERE id = ?`).get(`ret-pay-${acctDelId}`) as any;
  assert(Boolean(retainedRow && retainedRow.user_id_hash && !retainedRow.user_id), 'Retained accounting record holds anonymized user_id_hash with zero PII');
  assert(
    !fs.existsSync(path.join(process.env.SCHOOLBACKDOOR_UPLOADS_DIR!, acctUpload.filename)),
    'Deleted account upload file permanently unlinked from disk'
  );

  // Verify AES-256-GCM encrypted backup format (.db.enc) and tamper rejection
  const encBackup = adminSecurityService.createBackup(adminActor.id, 'admin');
  assert(encBackup.filename.endsWith('.db.enc'), 'Backup artifact created with .db.enc extension');
  const encBackupPath = path.join(process.env.SCHOOLBACKDOOR_BACKUP_DIR!, encBackup.filename);
  const encHeader = fs.readFileSync(encBackupPath).subarray(0, 8).toString('utf8');
  assert(encHeader === 'SBDBENC1', 'Backup on disk is encrypted (AES-256-GCM envelope) rather than plaintext SQLite');

  const restoreClean = adminSecurityService.restoreBackup(adminActor.id, 'admin', encBackup.id);
  assert(restoreClean.success === true, 'AES-256-GCM encrypted backup decrypts and restores cleanly');
  assert(
    (db.prepare('SELECT COUNT(*) as c FROM users WHERE id = ?').get(acctDelId) as any).c === 0,
    'Deleted account stays erased across encrypted backup restore via tombstone reconciliation'
  );

  // 22d: Strict 10 GB Quota & Simulated 70% / 85% / 95% Storage Protection Mode Alerts
  const baselineStorage = deletionService.getDetailedStorageMetrics({ skipProtectionAutoSweep: true });
  try {
    process.env.SCHOOLBACKDOOR_STORAGE_QUOTA_BYTES = String(Math.ceil(baselineStorage.totalUsedBytes / 0.72));
    const warnMetrics = deletionService.getDetailedStorageMetrics({ skipProtectionAutoSweep: true });
    assert(warnMetrics.alertLevel === 'warning_70' && warnMetrics.storageProtectionMode === false, '70% threshold triggers warning_70 alert without blocking uploads');

    process.env.SCHOOLBACKDOOR_STORAGE_QUOTA_BYTES = String(Math.ceil(baselineStorage.totalUsedBytes / 0.87));
    const critMetrics = deletionService.getDetailedStorageMetrics({ skipProtectionAutoSweep: true });
    assert(critMetrics.alertLevel === 'critical_85' && critMetrics.storageProtectionMode === false, '85% threshold triggers critical_85 alert');

    process.env.SCHOOLBACKDOOR_STORAGE_QUOTA_BYTES = String(Math.ceil(baselineStorage.totalUsedBytes / 0.97));
    const protMetrics = deletionService.getDetailedStorageMetrics({ skipProtectionAutoSweep: false });
    assert(
      protMetrics.alertLevel === 'protection_95' && protMetrics.storageProtectionMode === true && protMetrics.protectionActions.length >= 3,
      '95% threshold triggers Storage Protection Mode with automated protective actions'
    );

    const oversizedBase64 = `data:image/png;base64,${Buffer.alloc(300 * 1024, 1).toString('base64')}`;
    let largeUploadBlocked = false;
    try {
      fileService.saveBase64Image(oversizedBase64, 'u-ayodele', { maxBytesOverride: PROTECTION_MODE_MAX_UPLOAD_BYTES });
    } catch (err: any) {
      largeUploadBlocked = String(err?.message || '').includes('Storage Protection Mode');
    }
    assert(largeUploadBlocked, '95% Storage Protection Mode blocks uploads above 256 KB');
    assert(
      postService.getPostById(activePostBeforePurge!.id, 'u-ayodele') !== null,
      '95% Storage Protection Mode never deletes active user posts or accounts'
    );
  } finally {
    delete process.env.SCHOOLBACKDOOR_STORAGE_QUOTA_BYTES;
  }

  // 22e: Redacted privacy-safe logger
  const redacted = redactSensitiveData({
    password: 'MySecretPassword123',
    token: 'tok-secret-value',
    mfa_secret: 'BASE32SECRET',
    text: 'Private student message body',
    safeField: 'campus-public',
  });
  assert(
    redacted.password === '[REDACTED]' &&
      redacted.token === '[REDACTED]' &&
      redacted.mfa_secret === '[REDACTED]' &&
      redacted.text === '[REDACTED]' &&
      redacted.safeField === 'campus-public',
    'Privacy-safe logger redacts passwords, tokens, MFA secrets, and private message bodies'
  );

  // --- Step 23: Verify Free-Platform Chat Feature Flags Without Trial Expiry ---
  console.log('\n--- 23. Verifying Free Platform Chat Configuration ---');
  const chatsFeature = adminControlService.getPublicPlatformConfig().features.find((f) => f.key === 'chats');
  assert(
    Boolean(chatsFeature && chatsFeature.enabled && !('enforceSubscriptionAfterTrial' in (chatsFeature.limits || {}))),
    'Chats feature flag has zero subscription or trial enforcement'
  );

  // ==============================================================================
  // STEP 24: ZERO N+1 QUERY VERIFICATION (O(1) SCALING WITH JOINs & BATCHING)
  // ==============================================================================
  console.log('\n[Step 24] Verifying O(1) SQL query counts (Zero N+1) across services...');

  const countQueries = <T>(fn: () => T): { queries: number; result: T } => {
    let queries = 0;
    const origPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      queries++;
      return origPrepare(sql);
    };
    try {
      const result = fn();
      return { queries, result };
    } finally {
      (db as any).prepare = origPrepare;
    }
  };

  // Seed 12 extra users + group chat + community + mentions to test N=12 scaling
  const nPlusUsers: string[] = [];
  const nPlusHandles: string[] = [];
  const groupChatId = `conv-nplus-${Date.now()}`;
  const nPlusCommId = `comm-nplus-${Date.now()}`;
  db.prepare(`
    INSERT INTO chats (id, type, title, handle, subtitle, avatar_initials, avatar_bg, last_message)
    VALUES (?, 'group', 'N+1 Scaling Test Group', '@nplus_grp', 'Test', 'NP', 'bg-stone-800', 'hi')
  `).run(groupChatId);
  db.prepare(`INSERT INTO chat_participants (id, chat_id, user_id, role) VALUES (?, ?, ?, 'admin')`).run(
    `cp-lead-${Date.now()}`,
    groupChatId,
    'u-ayodele'
  );
  db.prepare(`
    INSERT INTO communities (id, name, acronym, category, member_count, description, location, creator_id, chat_id)
    VALUES (?, 'N+1 Community', 'NPLC', 'tech', 1, 'Scaling guild', 'SOC', 'u-ayodele', ?)
  `).run(nPlusCommId, groupChatId);
  db.prepare(`INSERT INTO community_memberships (id, community_id, user_id, role) VALUES (?, ?, 'u-ayodele', 'lead')`).run(
    `cm-lead-${Date.now()}`,
    nPlusCommId
  );

  for (let i = 0; i < 12; i++) {
    const u = authService.register(
      {
        username: `@nplus_u_${i}_${Date.now().toString(36).slice(-3)}`,
        password: 'Password123!',
        confirmPassword: 'Password123!',
        name: `Scaling Student ${i}`,
        department: 'Software Engineering',
        level: '300L',
        hall_of_residence: 'Jibowu',
      },
      undefined,
      true
    );
    nPlusUsers.push(u.user.id);
    nPlusHandles.push(u.profile.handle);
    db.prepare(`INSERT INTO chat_participants (id, chat_id, user_id, role) VALUES (?, ?, ?, 'member')`).run(
      `cp-np-${i}-${Date.now()}`,
      groupChatId,
      u.user.id
    );
    db.prepare(`INSERT INTO community_memberships (id, community_id, user_id, role) VALUES (?, ?, ?, 'member')`).run(
      `cm-np-${i}-${Date.now()}`,
      nPlusCommId,
      u.user.id
    );
  }
  // Block 2 of them from u-ayodele to exercise LEFT JOIN block filtering
  blockService.blockUser('u-ayodele', nPlusUsers[0]);
  blockService.blockUser(nPlusUsers[1], 'u-ayodele');

  // 24a: searchEligiblePartners must use 1 JOIN query and exclude both blocked users
  const eligibleRun = countQueries(() => chatService.searchEligiblePartners('u-ayodele', 'Scaling Student', 15));
  assert(
    eligibleRun.queries === 1,
    `searchEligiblePartners executes 1 JOIN query for N=12 candidates (got ${eligibleRun.queries})`
  );
  assert(
    !eligibleRun.result.some((u) => u.userId === nPlusUsers[0] || u.userId === nPlusUsers[1]) &&
      eligibleRun.result.length === 10,
    'searchEligiblePartners JOIN accurately excludes both-way blocks and returns remaining 10 users'
  );
  // Unblock for group messaging test
  blockService.unblockUser('u-ayodele', nPlusUsers[0]);
  blockService.unblockUser(nPlusUsers[1], 'u-ayodele');

  // 24b: sendMessage to 13-participant group executes O(1) queries (single JOIN + batched notification insert)
  const sendRun = countQueries(() =>
    chatService.sendMessage(groupChatId, 'u-ayodele', { text: 'Hello 12 peers in O(1) queries!' })
  );
  assert(
    sendRun.queries <= 6,
    `chatService.sendMessage across 13 participants uses <= 6 queries (got ${sendRun.queries})`
  );

  // 24c: processMentions with 12 @handles executes 2 queries total (1 JOIN SELECT + 1 batch INSERT)
  const mentionText = `Shoutout ${nPlusHandles.join(' ')}!`;
  const mentionRun = countQueries(() =>
    notificationService.processMentions(mentionText, 'u-ayodele', '/home', 'Scaling test')
  );
  assert(
    mentionRun.queries === 2 && mentionRun.result.length === 12,
    `notificationService.processMentions for 12 handles executes exactly 2 queries (got ${mentionRun.queries}, notified ${mentionRun.result.length})`
  );

  // 24d: createCommunityPost official announcement to 12 members executes O(1) queries
  const commPostRun = countQueries(() =>
    communityService.createCommunityPost(nPlusCommId, 'u-ayodele', {
      content: 'Official guild announcement for all 12 members!',
      isAnnouncement: true,
    })
  );
  assert(
    commPostRun.queries <= 8,
    `communityService.createCommunityPost announcement for 12 members uses <= 8 queries (got ${commPostRun.queries})`
  );

  // 24e: userService.getProfileByUserId executes 1 single LEFT JOIN query
  const profileRun = countQueries(() => userService.getProfileByUserId('u-ayodele', 'u-ayodele', 'admin'));
  assert(
    profileRun.queries === 1 && profileRun.result !== null,
    `userService.getProfileByUserId executes 1 query (got ${profileRun.queries})`
  );

  // 24f: adminControlService listings execute 1 query each (ZERO correlated subqueries / 2-query joins)
  const adminUsersRun = countQueries(() => adminControlService.listUsers());
  const adminChatsRun = countQueries(() => adminControlService.listChatsModerationOverview());
  const adminCommsRun = countQueries(() => adminControlService.listCommunitiesAdmin());
  assert(
    adminUsersRun.queries === 1 &&
      adminChatsRun.queries === 1 &&
      adminCommsRun.queries === 1,
    `Admin control list methods execute 1 query each (got users=${adminUsersRun.queries}, chats=${adminChatsRun.queries}, comms=${adminCommsRun.queries})`
  );

  // 24g: broadcastNotification across all active users executes O(1) queries (1 INSERT SELECT + 1 audit log)
  const broadcastRun = countQueries(() =>
    adminControlService.broadcastNotification(adminActor.id, {
      title: 'Campus O(1) Notice',
      body: 'Single SQL broadcast delivery across all active accounts.',
    })
  );
  assert(
    broadcastRun.queries <= 4 && broadcastRun.result.deliveredCount >= 12,
    `broadcastNotification inserts for ${broadcastRun.result.deliveredCount} users in <= 4 queries (got ${broadcastRun.queries})`
  );

  // 24h: cleanup sweep with 8 expired posts + 8 post notifications uses O(1) queries (no per-post delete loop)
  for (let i = 0; i < 8; i++) {
    const oldPostId = `old-np-${i}-${Date.now()}`;
    db.prepare(`
      INSERT INTO posts (id, author_id, content, created_at)
      VALUES (?, 'u-ayodele', 'Old post', datetime('now', '-80 hours'))
    `).run(oldPostId);
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link, created_at)
      VALUES (?, 'u-ayodele', 'like', 'Like', 'Someone liked', ?, datetime('now', '-80 hours'))
    `).run(`old-npn-${i}-${Date.now()}`, `/home?post=${oldPostId}`);
  }
  const sweepRun = countQueries(() => deletionService.run72HourExpirySweep('u-system-job'));
  assert(
    sweepRun.queries <= 30 && sweepRun.result.postsPurged >= 8,
    `run72HourExpirySweep purged ${sweepRun.result.postsPurged} posts + notifications in O(1) queries (got ${sweepRun.queries})`
  );

  // --- Step 25: Performance, Caching Isolation, Read Pool, Strict 72h Upload Policy & Pagination ---
  console.log('\n--- 25. Testing Caching Isolation, ETags, Read Pool, Pagination & 72h File Policy ---');
  const { withReadConnection, getPoolStats } = await import('../db/database.js');
  const { apiRouter } = await import('../routes/api.js');
  const expressMod = await import('express');
  const httpMod = await import('node:http');

  // 25a: Read connection pool concurrent reads & telemetry
  const poolBefore = getPoolStats();
  const concurrentReads = await Promise.all([
    Promise.resolve(withReadConnection((c) => c.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number })),
    Promise.resolve(withReadConnection((c) => c.prepare('SELECT COUNT(*) AS cnt FROM posts').get() as { cnt: number })),
    Promise.resolve(withReadConnection((c) => c.prepare('SELECT COUNT(*) AS cnt FROM communities').get() as { cnt: number })),
    Promise.resolve(withReadConnection((c) => c.prepare('SELECT COUNT(*) AS cnt FROM landmarks').get() as { cnt: number })),
  ]);
  const poolAfter = getPoolStats();
  assert(
    concurrentReads.every((r) => typeof r.cnt === 'number' && r.cnt >= 0) &&
      poolAfter.totalReadQueries >= poolBefore.totalReadQueries + 4 &&
      poolAfter.maxConnections >= 1,
    `SQLite read pool served concurrent queries cleanly (max=${poolAfter.maxConnections}, open=${poolAfter.openConnections}, totalQueries=${poolAfter.totalReadQueries})`
  );

  // 25b: Mount apiRouter on an ephemeral local HTTP server for real header/ETag/72h/pagination tests
  const testApp = expressMod.default();
  testApp.use(expressMod.default.json({ limit: '32mb' }));
  testApp.use('/api', apiRouter);
  const testServer = await new Promise<import('node:http').Server>((resolve) => {
    const s = httpMod.createServer(testApp);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = testServer.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Issue session tokens for seeded admin and active student
    const adminRow = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get() as any;
    db.prepare('UPDATE users SET last_reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ?').run(adminRow.id);
    const adminToken = authService.createSession(adminRow.id, '127.0.0.1', 'TestSuite').token;
    const studentUser = db.prepare("SELECT * FROM users WHERE role = 'student' OR role = 'user' LIMIT 1").get() as any;
    const studentToken = authService.createSession(studentUser.id, '127.0.0.1', 'TestSuite').token;

    // Public endpoints return public Cache-Control, CDN-Cache-Control, weak ETag, and 304 on If-None-Match
    for (const pubPath of ['/api/landmarks', '/api/notices', '/api/platform/config']) {
      const r1 = await fetch(`${baseUrl}${pubPath}`);
      const cc = r1.headers.get('cache-control') || '';
      const cdnCc = r1.headers.get('cdn-cache-control') || '';
      const etag = r1.headers.get('etag') || '';
      assert(
        r1.status === 200 && cc.includes('public') && cdnCc.includes('public') && etag.startsWith('W/"'),
        `Public endpoint ${pubPath} sets public CDN cache headers + ETag (${etag})`
      );
      const r304 = await fetch(`${baseUrl}${pubPath}`, {
        headers: { 'If-None-Match': etag },
      });
      assert(r304.status === 304, `Public endpoint ${pubPath} returns 304 Not Modified on ETag match`);
    }

    // Obsolete payment and subscription routes return 404
    for (const removedRoute of [
      '/api/subscriptions',
      '/api/subscriptions/entitlement',
      '/api/payments/banks',
      '/api/admin/payments',
      '/api/admin/subscriptions',
    ]) {
      const r404 = await fetch(`${baseUrl}${removedRoute}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert(r404.status === 404, `Obsolete payment/subscription endpoint ${removedRoute} returns 404`);
    }

    // Legacy (>210 days) user with zero payment/subscription sends HTTP POST /api/chats/:id/messages cleanly (201)
    const httpLegacyUserId = `u-http-free-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const httpLegacyHandle = `@http_free_${Math.random().toString(36).slice(2, 7)}`;
    db.prepare(`
      INSERT INTO users (id, matric_number, username, email, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, 'hashed', 'student', datetime('now', '-210 days'))
    `).run(httpLegacyUserId, `CPE/${Date.now().toString().slice(-4)}/002`, httpLegacyHandle, `http_free_${Date.now()}@futa.edu.ng`);
    db.prepare(`
      INSERT INTO user_profiles (
        id, user_id, name, handle, department, school, level, hall_of_residence,
        campus, bio, avatar_initials, avatar_bg, verified
      ) VALUES (?, ?, 'HTTP Legacy Scholar', ?, 'SEET', 'Computer Engineering', '400L', 'Abiola Hall', 'Obanla', 'Bio', 'HL', 'bg-stone-800 text-stone-100', 0)
    `).run(`prof-${httpLegacyUserId}`, httpLegacyUserId, httpLegacyHandle);
    const httpLegacyChat = chatService.createDirectChat(httpLegacyUserId, 'u-ayodele');
    const legacyHttpToken = authService.createSession(httpLegacyUserId, '127.0.0.1', 'TestSuite').token;
    const legacyMsgRes = await fetch(`${baseUrl}/api/chats/${httpLegacyChat.chatId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${legacyHttpToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'HTTP verification: >210d account sends chat message with 0 payment restrictions.',
      }),
    });
    const legacyMsgBody = (await legacyMsgRes.json()) as any;
    assert(
      legacyMsgRes.status === 201 && Boolean(legacyMsgBody?.id),
      `Legacy (>210d) account POST /api/chats/${httpLegacyChat.chatId}/messages succeeds with 201`
    );
    db.prepare('DELETE FROM notifications WHERE link = ?').run(`/chats?conv=${httpLegacyChat.chatId}`);
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(httpLegacyChat.chatId);
    db.prepare('DELETE FROM chat_participants WHERE chat_id = ?').run(httpLegacyChat.chatId);
    db.prepare('DELETE FROM chats WHERE id = ?').run(httpLegacyChat.chatId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(httpLegacyUserId);
    db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(httpLegacyUserId);
    db.prepare('DELETE FROM users WHERE id = ?').run(httpLegacyUserId);

    // Private student/admin endpoints strictly enforce Cache-Control: private, no-store & CDN-Cache-Control: no-store
    const adminDashboardRes = await fetch(`${baseUrl}/api/admin/dashboard`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(
      adminDashboardRes.status === 200 &&
        (adminDashboardRes.headers.get('cache-control') || '').includes('no-store') &&
        adminDashboardRes.headers.get('cdn-cache-control') === 'no-store',
      'GET /api/admin/dashboard strictly prevents shared CDN caching'
    );

    for (const privPath of ['/api/me', '/api/chats', '/api/notifications']) {
      const r = await fetch(`${baseUrl}${privPath}`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      const cc = r.headers.get('cache-control') || '';
      const cdnCc = r.headers.get('cdn-cache-control') || '';
      assert(
        r.status === 200 && cc.includes('private') && cc.includes('no-store') && cdnCc === 'no-store',
        `Private endpoint ${privPath} enforces private no-store (${cc})`
      );
    }

    // Paginated endpoints return expected pagination metadata shapes
    const notifPageRes = await fetch(`${baseUrl}/api/notifications?paginated=1&limit=5&offset=0`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const notifPage = await notifPageRes.json() as any;
    assert(
      Array.isArray(notifPage.notifications) && typeof notifPage.total === 'number' && typeof notifPage.hasMore === 'boolean',
      'GET /api/notifications?paginated=1 returns paginated metadata shape'
    );

    const commRow = db.prepare('SELECT id FROM communities LIMIT 1').get() as { id: string };
    const commPostsRes = await fetch(`${baseUrl}/api/communities/${commRow.id}/posts?paginated=1&limit=5&offset=0`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const commPostsPage = await commPostsRes.json() as any;
    assert(
      Array.isArray(commPostsPage.posts) && typeof commPostsPage.total === 'number' && typeof commPostsPage.hasMore === 'boolean',
      'GET /api/communities/:id/posts?paginated=1 returns paginated metadata shape'
    );

    const commMembersRes = await fetch(`${baseUrl}/api/communities/${commRow.id}/members?paginated=1&limit=5&offset=0`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const commMembersPage = await commMembersRes.json() as any;
    assert(
      Array.isArray(commMembersPage.members) && typeof commMembersPage.total === 'number' && typeof commMembersPage.hasMore === 'boolean',
      'GET /api/communities/:id/members?paginated=1 returns paginated metadata shape'
    );

    const chatPart = db.prepare('SELECT chat_id FROM chat_participants WHERE user_id = ? LIMIT 1').get(studentUser.id) as
      | { chat_id: string }
      | undefined;
    if (chatPart) {
      const chatMsgRes = await fetch(`${baseUrl}/api/chats/${chatPart.chat_id}/messages?paginated=1&limit=10&offset=0`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      const chatMsgPage = await chatMsgRes.json() as any;
      assert(
        Array.isArray(chatMsgPage.messages) && typeof chatMsgPage.total === 'number' && typeof chatMsgPage.hasMore === 'boolean',
        'GET /api/chats/:id/messages?paginated=1 returns paginated metadata shape'
      );
    }

    // Strict 72-hour upload file policy: serves active post photo with Expires, immediately 404s once > 72h
    const tinyPngBase64 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
    const savedImg = fileService.saveBase64Image(tinyPngBase64, studentUser.id);
    const filename = savedImg.filename;
    const photoPost = postService.createPost(studentUser.id, {
      content: 'Post with 72h expiry upload check',
      images: [savedImg.url],
    })!;
    assert(Boolean(photoPost?.id), 'Created photoPost for 72h upload check');

    const activeUploadRes = await fetch(`${baseUrl}/api/uploads/${filename}`);
    const expiresHeader = activeUploadRes.headers.get('expires');
    assert(
      activeUploadRes.status === 200 && Boolean(expiresHeader) && (activeUploadRes.headers.get('cache-control') || '').includes('max-age='),
      `GET /api/uploads/${filename} serves active post image with Expires=${expiresHeader}`
    );

    // Backdate post timestamp past 72h without running purge sweep
    db.prepare(`UPDATE posts SET created_at = datetime('now', '-73 hours') WHERE id = ?`).run(photoPost.id);
    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('uploads:');

    const expiredUploadRes = await fetch(`${baseUrl}/api/uploads/${filename}`);
    assert(
      expiredUploadRes.status === 404,
      `GET /api/uploads/${filename} immediately returns 404 once content passes 72h (${expiredUploadRes.status})`
    );

    // =========================================================================
    // 26. POST REPORT BUTTON & ADMIN DASHBOARD NOTIFICATION PIPELINE
    // =========================================================================
    console.log('\n--- 26. Testing Post Report Flow -> Admin Dashboard Notification ---');
    const flaggedTargetPost = postService.createPost(adminRow.id, {
      content: 'Sample dispatch under moderation review test #campus',
    })!;
    assert(Boolean(flaggedTargetPost?.id), 'Created target post for moderation flagging test');

    // 26a: HTTP POST /api/reports as student succeeds (201) and alerts Admin
    const reportHttpRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_type: 'post',
        target_id: flaggedTargetPost.id,
        reason: 'Spam, phishing, or scam',
        details: 'Unsolicited promotional link posted in campus stream',
      }),
    });
    const reportCreatedBody = (await reportHttpRes.json()) as any;
    assert(
      reportHttpRes.status === 201 &&
        Boolean(reportCreatedBody?.id) &&
        reportCreatedBody.target_id === flaggedTargetPost.id &&
        reportCreatedBody.status === 'pending',
      `POST /api/reports created pending report (${reportCreatedBody?.id})`
    );

    // 26b: Admin notification bell receives persistent 'system' notification pointing to /admin?section=moderation
    const adminNotifsRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminNotifs = (await adminNotifsRes.json()) as any[];
    const reportAlertNotif = Array.isArray(adminNotifs)
      ? adminNotifs.find(
          (n) =>
            n.type === 'system' &&
            n.link === '/admin?section=moderation' &&
            String(n.body || '').includes('Spam, phishing, or scam')
        )
      : undefined;
    assert(
      adminNotifsRes.status === 200 && Boolean(reportAlertNotif),
      'Admin GET /api/notifications contains persistent moderation alert for flagged post'
    );

    // 26c: Admin moderation queue (GET /api/admin/reports) reflects new pending report immediately
    const adminReportsRes = await fetch(`${baseUrl}/api/admin/reports`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminReports = (await adminReportsRes.json()) as any[];
    assert(
      adminReportsRes.status === 200 &&
        Array.isArray(adminReports) &&
        adminReports.some(
          (r) => r.id === reportCreatedBody.id && r.reporter_handle && r.status === 'pending'
        ),
      'Admin GET /api/admin/reports includes newly flagged post with reporter handle'
    );

    // 26d: Duplicate pending report from same student for same post is rejected (409)
    const dupReportRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_type: 'post',
        target_id: flaggedTargetPost.id,
        reason: 'Spam, phishing, or scam',
      }),
    });
    assert(
      dupReportRes.status === 409,
      `Duplicate pending report from same student returns 409 (${dupReportRes.status})`
    );

    // 26e: Reporting a non-existent post returns 404
    const missingReportRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_type: 'post',
        target_id: 'post-does-not-exist-999',
        reason: 'Harassment, bullying, or hate speech',
      }),
    });
    assert(
      missingReportRes.status === 404,
      `Reporting non-existent post returns 404 (${missingReportRes.status})`
    );

    // =========================================================================
    // 27. @USERNAME AUTH, RECOVERY CODES, SEARCH, CONNECTIONS, REPOSTS & THREADS
    // =========================================================================
    console.log('\n--- 27. Testing @Username Auth, PoW Signup, Recovery Codes, Search, Connections, Reposts & Threaded Comments ---');

    // 27a: Registration without PoW challenge is rejected with HTTP 400
    const missingPowRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@nopow_${Date.now().toString().slice(-4)}`,
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!',
        acceptTerms: true,
      }),
    });
    assert(missingPowRes.status === 400, `Rejects registration without PoW bot challenge with HTTP 400 (${missingPowRes.status})`);

    // 27b: Valid @username registration with PoW + 10 recovery codes + cookie + @username login
    const gUniq = Date.now().toString().slice(-5);
    const socialHandle = `@social_${gUniq}`;
    const socialChallenge = await fetchSolvedChallenge(baseUrl);
    const validRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: socialHandle,
        password: 'SocialPassword123!',
        confirmPassword: 'SocialPassword123!',
        acceptTerms: true,
        name: 'Social Member',
        ...socialChallenge,
      }),
    });
    const validRegBody = (await validRegRes.json()) as any;
    const regSetCookie = String(validRegRes.headers.get('set-cookie') || '');
    assert(
      validRegRes.status === 201 &&
        Boolean(validRegBody.token) &&
        Array.isArray(validRegBody.recoveryCodes) &&
        validRegBody.recoveryCodes.length === 10 &&
        validRegBody.user?.verification_code === undefined &&
        regSetCookie.includes('sb_session=') &&
        regSetCookie.includes('HttpOnly') &&
        regSetCookie.includes('SameSite=Strict'),
      'Valid @username + PoW registration succeeds (201), sets HttpOnly SameSite=Strict cookie, returns 10 recovery codes once'
    );

    // Cookie-only authenticated request to /api/me
    const cookiePair = regSetCookie.split(';')[0];
    const cookieMeRes = await fetch(`${baseUrl}/api/me`, {
      headers: { Cookie: cookiePair },
    });
    const cookieMeBody = (await cookieMeRes.json()) as any;
    assert(cookieMeRes.status === 200 && cookieMeBody.user?.id === validRegBody.user.id, 'HttpOnly sb_session cookie authenticates /api/me cleanly');

    const removedResendRes = await fetch(`${baseUrl}/api/auth/verify/resend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${validRegBody.token}` },
    });
    assert(removedResendRes.status === 404, 'Removed legacy POST /api/auth/verify/resend returns 404');

    const removedForgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: socialHandle }),
    });
    assert(removedForgotRes.status === 404, 'Removed legacy POST /api/auth/forgot-password returns 404');

    const loginHandleRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: socialHandle, password: 'SocialPassword123!' }),
    });
    const loginHandleBody = (await loginHandleRes.json()) as any;
    assert(
      loginHandleRes.status === 200 &&
        loginHandleBody.recoveryCodes === undefined &&
        String(loginHandleRes.headers.get('set-cookie') || '').includes('HttpOnly'),
      'Logs in cleanly with @username + password, issues HttpOnly cookie, and never exposes recoveryCodes'
    );

    const loginUpperRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: socialHandle.toUpperCase(), password: 'SocialPassword123!' }),
    });
    assert(loginUpperRes.status === 200, 'Logs in cleanly with case-insensitive @username + password');

    // 27c: Friend search & connection toggle + profile posts shielding
    const searchUsersRes = await fetch(`${baseUrl}/api/users/search?q=ayodele`, {
      headers: { Authorization: `Bearer ${validRegBody.token}` },
    });
    const searchUsersList = (await searchUsersRes.json()) as any[];
    assert(
      searchUsersRes.status === 200 && Array.isArray(searchUsersList) && searchUsersList.some((u) => u.userId === 'u-ayodele'),
      'GET /api/users/search locates users by handle/name'
    );

    const connRes = await fetch(`${baseUrl}/api/users/u-ayodele/connect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${validRegBody.token}` },
    });
    const connBody = (await connRes.json()) as any;
    assert(
      connRes.status === 200 && connBody.isConnected === true && typeof connBody.followersCount === 'number',
      'POST /api/users/:id/connect persists connection state'
    );

    // Anonymous post is excluded from public user post history
    const anonUserPost = postService.createPost(validRegBody.user.id, {
      content: 'Anonymous post hidden from profile timeline',
      is_anonymous: true,
    })!;
    const publicUserPostsRes = await fetch(`${baseUrl}/api/users/${validRegBody.user.id}/posts`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const publicUserPosts = (await publicUserPostsRes.json()) as any[];
    assert(
      publicUserPostsRes.status === 200 && !publicUserPosts.some((p) => p.id === anonUserPost.id),
      'GET /api/users/:id/posts excludes anonymous posts from peer view'
    );

    // 27d: GET /api/posts/:id masks anonymous author for peer & supports repost + threaded reply comments
    const singleAnonRes = await fetch(`${baseUrl}/api/posts/${anonUserPost.id}`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const singleAnonPost = (await singleAnonRes.json()) as any;
    assert(
      singleAnonRes.status === 200 &&
        singleAnonPost.authorName === 'Anonymous Member' &&
        singleAnonPost.authorHandle === '@anonymous',
      'GET /api/posts/:id masks anonymous author identity for peer viewers'
    );

    const repostRes = await fetch(`${baseUrl}/api/posts/${flaggedTargetPost.id}/repost`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${validRegBody.token}` },
    });
    const repostBody = (await repostRes.json()) as any;
    assert(repostRes.status === 200 && repostBody.isReposted === true && repostBody.reposts >= 1, 'POST /api/posts/:id/repost toggles repost count cleanly');

    const topCommentRes = await fetch(`${baseUrl}/api/posts/${flaggedTargetPost.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Top-level social comment!' }),
    });
    const topComment = (await topCommentRes.json()) as any;
    assert(topCommentRes.status === 201 && Boolean(topComment.id), 'Creates top-level comment (201)');

    const replyCommentRes = await fetch(`${baseUrl}/api/posts/${flaggedTargetPost.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Direct threaded reply!', parentCommentId: topComment.id }),
    });
    const replyComment = (await replyCommentRes.json()) as any;
    assert(
      replyCommentRes.status === 201 && replyComment.parentCommentId === topComment.id,
      'Creates nested reply referencing parentCommentId (201)'
    );

    const fetchedThreadRes = await fetch(`${baseUrl}/api/posts/${flaggedTargetPost.id}`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const fetchedThreadPost = (await fetchedThreadRes.json()) as any;
    assert(
      fetchedThreadRes.status === 200 &&
        Array.isArray(fetchedThreadPost.comments) &&
        fetchedThreadPost.comments.some((c: any) => c.id === replyComment.id && c.parentCommentId === topComment.id),
      'GET /api/posts/:id returns full threaded comment hierarchy'
    );

    // =========================================================================
    // 28. VIBESEC SECURITY HARDENING REGRESSIONS
    // =========================================================================
    console.log('\n--- 28. Testing VibeSec Security Hardening Controls ---');

    // 28a: Spoofed PNG magic bytes rejected by fileService & /api/files/upload
    const fakePngDataUrl = `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;
    let spoofRejectedService = false;
    try {
      fileService.saveBase64Image(fakePngDataUrl, validRegBody.user.id);
    } catch {
      spoofRejectedService = true;
    }
    assert(spoofRejectedService, 'fileService.saveBase64Image rejects spoofed PNG magic bytes');

    const spoofUploadRes = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dataUrl: fakePngDataUrl }),
    });
    assert(spoofUploadRes.status === 400, `POST /api/files/upload rejects spoofed magic bytes with 400 (${spoofUploadRes.status})`);

    // 28b: Dangerous URI schemes in post images & fileService.externalizeImages rejected
    let badImgRejected = false;
    try {
      postService.createPost(validRegBody.user.id, {
        content: 'Testing image URL sanitization',
        images: ['javascript:alert(document.cookie)'],
      });
    } catch {
      badImgRejected = true;
    }
    assert(badImgRejected, 'postService.createPost rejects javascript: image URLs');
    let jsExtRejected = false;
    try {
      fileService.externalizeImages(['javascript:alert(1)'], validRegBody.user.id);
    } catch {
      jsExtRejected = true;
    }
    let svgExtRejected = false;
    try {
      fileService.externalizeImages(['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='], validRegBody.user.id);
    } catch {
      svgExtRejected = true;
    }
    assert(jsExtRejected && svgExtRejected, 'fileService.externalizeImages rejects javascript: and SVG data: URLs');

    // 28c: Strong password enforcement (length + complexity + weak blocklist) on register & recovery reset
    const shortPwdRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@short_${gUniq}`,
        password: '1234567',
        confirmPassword: '1234567',
        acceptTerms: true,
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    assert(shortPwdRegRes.status === 400, `POST /api/auth/register enforces >=8 char passwords (${shortPwdRegRes.status})`);

    const weakPwdRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@weak_${gUniq}`,
        password: 'Password123',
        confirmPassword: 'Password123',
        acceptTerms: true,
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    assert(weakPwdRegRes.status === 400, `POST /api/auth/register rejects password missing symbol (${weakPwdRegRes.status})`);

    const commonPwdRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@common_${gUniq}`,
        password: 'Qwerty123!',
        confirmPassword: 'Qwerty123!',
        acceptTerms: true,
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    assert(commonPwdRegRes.status === 400, `POST /api/auth/register rejects common weak password (${commonPwdRegRes.status})`);

    let shortResetRejected = false;
    try {
      authService.resetPasswordWithRecoveryCode({
        username: socialHandle,
        recoveryCode: validRegBody.recoveryCodes[0],
        newPassword: 'short7',
        confirmPassword: 'short7',
      });
    } catch (e: any) {
      shortResetRejected = String(e?.message || '').includes('8 characters');
    }
    assert(shortResetRejected, 'authService.resetPasswordWithRecoveryCode enforces >=8 char strong passwords');

    // 28d: Recovery-code reset brute-force rate limit (HTTP 429 after 5 bad attempts)
    let recoveryLocked429 = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const badRecRes = await fetch(`${baseUrl}/api/auth/recovery/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: socialHandle,
          recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
          newPassword: 'ValidResetPassword!2026',
          confirmPassword: 'ValidResetPassword!2026',
        }),
      });
      if (badRecRes.status === 429) {
        recoveryLocked429 = true;
        break;
      }
    }
    assert(recoveryLocked429, 'POST /api/auth/recovery/reset rate-limits brute force attempts (429)');
    db.prepare("DELETE FROM login_attempts WHERE identifier LIKE 'rec%'").run();

    // 28d-ii: Login brute-force lockout returns HTTP 429 with Retry-After header after 5 failures
    let loginLocked429 = false;
    let loginRetryAfter = '';
    for (let attempt = 1; attempt <= 6; attempt++) {
      const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: socialHandle, password: 'WrongAttemptPassword!9' }),
      });
      if (badLoginRes.status === 429) {
        loginLocked429 = true;
        loginRetryAfter = String(badLoginRes.headers.get('retry-after') || '');
        break;
      }
    }
    assert(
      loginLocked429 && Number(loginRetryAfter) > 0,
      `POST /api/auth/login locks after 5 failures with HTTP 429 + Retry-After (${loginRetryAfter}s)`
    );
    db.prepare('DELETE FROM login_attempts').run();
    db.prepare('DELETE FROM account_lockouts').run();

    // 28e: Normal student cannot escalate privileges to create pinned/announcement posts
    const escalateRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Unauthorized campus-wide announcement attempt',
        is_announcement: true,
        is_pinned: true,
      }),
    });
    assert(escalateRes.status === 403, `Normal student creating is_announcement/is_pinned post returns 403 (${escalateRes.status})`);

    // 28f: Private community enforces membership on posts & member list
    const privCommId = `comm-priv-${Date.now()}`;
    db.prepare(
      `INSERT INTO communities (id, name, acronym, category, description, location, settings_json)
       VALUES (?, 'Secret Honor Society', 'SHS', 'academic', 'Private group', 'Obanla Campus', ?)`
    ).run(privCommId, JSON.stringify({ isPrivate: true, allowMemberDiscussions: true }));
    db.prepare(`INSERT INTO community_memberships (id, user_id, community_id) VALUES (?, ?, ?)`).run(
      `cm-priv-${Date.now()}`,
      validRegBody.user.id,
      privCommId
    );

    const nonMemberPostsRes = await fetch(`${baseUrl}/api/communities/${privCommId}/posts`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const nonMemberMembersRes = await fetch(`${baseUrl}/api/communities/${privCommId}/members`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert(
      nonMemberPostsRes.status === 403 && nonMemberMembersRes.status === 403,
      `Private community blocks non-member reads (posts=${nonMemberPostsRes.status}, members=${nonMemberMembersRes.status})`
    );

    const memberPostsRes = await fetch(`${baseUrl}/api/communities/${privCommId}/posts`, {
      headers: { Authorization: `Bearer ${validRegBody.token}` },
    });
    const adminPrivMembersRes = await fetch(`${baseUrl}/api/communities/${privCommId}/members`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(
      memberPostsRes.status === 200 && adminPrivMembersRes.status === 200,
      'Private community permits member and admin reads (200)'
    );

    // 28g: user_blocks prevents viewing blocker's post and commenting/liking/reposting
    const blockerPost = postService.createPost(validRegBody.user.id, {
      content: 'Post from user who will block student',
    })!;
    blockService.blockUser(validRegBody.user.id, 'u-ayodele');

    const blockedViewRes = await fetch(`${baseUrl}/api/posts/${blockerPost.id}`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const blockedCommentRes = await fetch(`${baseUrl}/api/posts/${blockerPost.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Should be blocked!' }),
    });
    const blockedLikeRes = await fetch(`${baseUrl}/api/posts/${blockerPost.id}/like`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert(
      blockedViewRes.status === 404 && blockedCommentRes.status === 403 && blockedLikeRes.status === 403,
      `Blocked user access denied on post view/comment/like (view=${blockedViewRes.status}, comment=${blockedCommentRes.status}, like=${blockedLikeRes.status})`
    );
    blockService.unblockUser(validRegBody.user.id, 'u-ayodele');

    // =========================================================================
    // 29. INTERACTIVE MULTI-CHOICE POLLS (CREATE, VOTE, SWITCH, TOGGLE, EXPIRY)
    // =========================================================================
    console.log('\n--- 29. Testing Interactive Polls Creation, Voting & 72h Expiry ---');

    // 29a: Reject polls with <2 or >6 choices
    const tooFewPollRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Invalid single option poll',
        poll: { options: ['Only one'] },
      }),
    });
    const tooManyPollRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Invalid 7 options poll',
        poll: { options: ['1', '2', '3', '4', '5', '6', '7'] },
      }),
    });
    assert(
      tooFewPollRes.status === 400 && tooManyPollRes.status === 400,
      `Invalid poll option counts (<2 or >6) rejected with HTTP 400 (${tooFewPollRes.status}, ${tooManyPollRes.status})`
    );

    // 29b: Single-choice poll creation + vote + switch option preserves single vote
    const singlePollRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Best spot for late night reading?',
        poll: {
          options: ['Albert Ilemobade Library', '3-in-1 Hall', 'ETF Auditorium'],
          allowMultiple: false,
        },
      }),
    });
    const singlePollPost = (await singlePollRes.json()) as any;
    assert(
      singlePollRes.status === 201 &&
        Boolean(singlePollPost?.poll) &&
        singlePollPost.poll.options.length === 3 &&
        singlePollPost.poll.allowMultiple === false,
      `POST /api/posts creates single-choice poll (${singlePollPost?.id})`
    );

    const opt1 = singlePollPost.poll.options[0].id;
    const opt2 = singlePollPost.poll.options[1].id;

    const vote1Res = await fetch(`${baseUrl}/api/posts/${singlePollPost.id}/poll/vote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: opt1 }),
    });
    const vote1Body = (await vote1Res.json()) as any;
    assert(
      vote1Res.status === 200 &&
        vote1Body.poll.totalVotes === 1 &&
        vote1Body.poll.userVotedOptionIds.includes(opt1),
      'POST /api/posts/:id/poll/vote records initial single-choice vote (total=1)'
    );

    const switchVoteRes = await fetch(`${baseUrl}/api/posts/${singlePollPost.id}/poll/vote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: opt2 }),
    });
    const switchVoteBody = (await switchVoteRes.json()) as any;
    const switchedOpt1 = switchVoteBody.poll.options.find((o: any) => o.id === opt1);
    const switchedOpt2 = switchVoteBody.poll.options.find((o: any) => o.id === opt2);
    assert(
      switchVoteRes.status === 200 &&
        switchVoteBody.poll.totalVotes === 1 &&
        switchedOpt1?.votes === 0 &&
        switchedOpt2?.votes === 1 &&
        switchVoteBody.poll.userVotedOptionIds.length === 1 &&
        switchVoteBody.poll.userVotedOptionIds[0] === opt2,
      'Single-choice poll switch moves vote from opt1 to opt2 without double-counting'
    );

    // 29c: Multi-choice poll allows selecting multiple options and toggling off
    const multiPollRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Which campus events are you attending this week?',
        poll: {
          options: ['Tech Hangout', 'Game Night', 'Open Mic'],
          allowMultiple: true,
        },
      }),
    });
    const multiPollPost = (await multiPollRes.json()) as any;
    assert(
      multiPollRes.status === 201 && multiPollPost.poll?.allowMultiple === true,
      `POST /api/posts creates multi-choice poll (${multiPollPost?.id})`
    );

    const mOptA = multiPollPost.poll.options[0].id;
    const mOptB = multiPollPost.poll.options[1].id;

    await fetch(`${baseUrl}/api/posts/${multiPollPost.id}/poll/vote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: mOptA }),
    });
    const multiAddRes = await fetch(`${baseUrl}/api/posts/${multiPollPost.id}/poll/vote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: mOptB }),
    });
    const multiAddBody = (await multiAddRes.json()) as any;
    assert(
      multiAddRes.status === 200 &&
        multiAddBody.poll.totalVotes === 2 &&
        multiAddBody.poll.userVotedOptionIds.includes(mOptA) &&
        multiAddBody.poll.userVotedOptionIds.includes(mOptB),
      'Multi-choice poll records multiple concurrent selections per user'
    );

    const multiToggleOffRes = await fetch(`${baseUrl}/api/posts/${multiPollPost.id}/poll/vote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: mOptA }),
    });
    const multiToggleOffBody = (await multiToggleOffRes.json()) as any;
    assert(
      multiToggleOffRes.status === 200 &&
        multiToggleOffBody.poll.totalVotes === 1 &&
        !multiToggleOffBody.poll.userVotedOptionIds.includes(mOptA) &&
        multiToggleOffBody.poll.userVotedOptionIds.includes(mOptB),
      'Multi-choice poll toggles individual vote off cleanly'
    );

    // 29d: Blocked user vote rejected with 403 & 72h sweep purges poll_votes
    blockService.blockUser(studentUser.id, validRegBody.user.id);
    const blockedVoteRes = await fetch(`${baseUrl}/api/posts/${singlePollPost.id}/poll/vote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId: opt1 }),
    });
    assert(blockedVoteRes.status === 403, `Blocked user poll vote returns 403 (${blockedVoteRes.status})`);
    blockService.unblockUser(studentUser.id, validRegBody.user.id);

    db.prepare(`UPDATE posts SET created_at = datetime('now', '-73 hours') WHERE id = ?`).run(singlePollPost.id);
    cache.invalidatePrefix('posts:');
    deletionService.run72HourExpirySweep('u-system-job');
    const remainingVotes = db
      .prepare('SELECT COUNT(*) as cnt FROM poll_votes WHERE post_id = ?')
      .get(singlePollPost.id) as { cnt: number };
    assert(remainingVotes.cnt === 0, '72-hour expiry sweep cleans up poll_votes for expired posts');

    // =========================================================================
    // 30. LOCATION-BASED & TRENDING POST FEEDS, VIEWS, PRIVACY & FAIR RANKING
    // =========================================================================
    console.log('\n--- 30. Testing Location-Based & Trending Post Feeds, Views & Anti-Manipulation ---');

    // 30a: Coarse location taxonomy endpoint returns 7 campus/surrounding areas
    const locsRes = await fetch(`${baseUrl}/api/feed/locations`);
    const locsBody = (await locsRes.json()) as any;
    assert(
      locsRes.status === 200 &&
        Array.isArray(locsBody) &&
        locsBody.length >= 7 &&
        locsBody.some((a: any) => a.key === 'south_gate' && a.shortLabel === 'South Gate') &&
        locsBody.some((a: any) => a.key === 'obanla'),
      `GET /api/feed/locations exposes coarse area taxonomy without GPS tracking (${Array.isArray(locsBody) ? locsBody.length : 0} areas)`
    );

    // 30b: Location privacy — precise GPS coordinates MUST be rejected with 400
    const rawGpsRejectRes = await fetch(`${baseUrl}/api/me/location-preference`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationSharingEnabled: true,
        preferredLocationArea: 'south_gate',
        latitude: 7.3021,
        longitude: 5.1342,
      }),
    });
    assert(
      rawGpsRejectRes.status === 400,
      `PUT /api/me/location-preference rejects raw GPS coordinates with HTTP 400 (${rawGpsRejectRes.status})`
    );

    const optInAreaRes = await fetch(`${baseUrl}/api/me/location-preference`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationSharingEnabled: true,
        preferredLocationArea: 'south_gate',
      }),
    });
    const optInAreaBody = (await optInAreaRes.json()) as any;
    assert(
      optInAreaRes.status === 200 &&
        optInAreaBody.locationSharingEnabled === true &&
        optInAreaBody.preferredLocationArea === 'south_gate',
      'PUT /api/me/location-preference saves opt-in coarse area preference'
    );

    // 30c: Create location-tagged posts and verify coarse area metadata
    const sgPostRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Study group meetup near South Gate this evening.',
        areaKey: 'south_gate',
        hostel_tag: 'South Gate',
      }),
    });
    const sgPost = (await sgPostRes.json()) as any;
    assert(
      sgPostRes.status === 201 && sgPost.areaKey === 'south_gate' && sgPost.areaLabel === 'South Gate',
      `POST /api/posts persists coarse areaKey=south_gate (${sgPost?.id})`
    );

    const obanlaPostRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Exam revision happening at Obanla Campus ETF hall right now!',
        areaKey: 'obanla',
      }),
    });
    const obanlaPost = (await obanlaPostRes.json()) as any;
    assert(
      obanlaPostRes.status === 201 && obanlaPost.areaKey === 'obanla',
      `POST /api/posts persists coarse areaKey=obanla (${obanlaPost?.id})`
    );

    // 30d: Genuine view deduplication, self-view exclusion, bot filtering & low dwell filtering
    const browserHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    };

    // Bot user agent skipped
    const botViewRes = await fetch(`${baseUrl}/api/posts/views`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'curl/8.4.0',
      },
      body: JSON.stringify({ postIds: [obanlaPost.id], visitorId: 'botvisitor001', dwellMs: 1200 }),
    });
    const botViewBody = (await botViewRes.json()) as any;
    assert(
      botViewRes.status === 200 && botViewBody.skippedBot === true && botViewBody.recorded === 0,
      'POST /api/posts/views ignores suspected bot user agents'
    );

    // Drive-by low dwell (<400ms) skipped
    const shortDwellRes = await fetch(`${baseUrl}/api/posts/views`, {
      method: 'POST',
      headers: { ...browserHeaders, Authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ postIds: [obanlaPost.id], dwellMs: 150 }),
    });
    const shortDwellBody = (await shortDwellRes.json()) as any;
    assert(
      shortDwellRes.status === 200 && shortDwellBody.recorded === 0,
      'POST /api/posts/views rejects sub-400ms drive-by views'
    );

    // Author self-view ignored
    const selfViewRes = await fetch(`${baseUrl}/api/posts/views`, {
      method: 'POST',
      headers: { ...browserHeaders, Authorization: `Bearer ${validRegBody.token}` },
      body: JSON.stringify({ postIds: [obanlaPost.id], dwellMs: 1500 }),
    });
    const selfViewBody = (await selfViewRes.json()) as any;
    assert(
      selfViewRes.status === 200 && selfViewBody.recorded === 0,
      'POST /api/posts/views excludes author self-views'
    );

    // Genuine authenticated view increments once, repeat does NOT double count
    const firstViewRes = await fetch(`${baseUrl}/api/posts/views`, {
      method: 'POST',
      headers: { ...browserHeaders, Authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ postIds: [obanlaPost.id], dwellMs: 1200 }),
    });
    const firstViewBody = (await firstViewRes.json()) as any;

    const duplicateViewRes = await fetch(`${baseUrl}/api/posts/views`, {
      method: 'POST',
      headers: { ...browserHeaders, Authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ postIds: [obanlaPost.id], dwellMs: 2500 }),
    });
    const duplicateViewBody = (await duplicateViewRes.json()) as any;
    assert(
      firstViewBody.recorded === 1 &&
        firstViewBody.viewsByPost?.[obanlaPost.id] === 1 &&
        duplicateViewBody.recorded === 0 &&
        duplicateViewBody.viewsByPost?.[obanlaPost.id] === 1,
      'POST /api/posts/views deduplicates repeated views by the same user'
    );

    // Guest visitor deduplication
    const guestVid = `guest_${Date.now()}`;
    const guestView1 = await (
      await fetch(`${baseUrl}/api/posts/${obanlaPost.id}/view`, {
        method: 'POST',
        headers: browserHeaders,
        body: JSON.stringify({ visitorId: guestVid, dwellMs: 1100 }),
      })
    ).json() as any;
    const guestView2 = await (
      await fetch(`${baseUrl}/api/posts/${obanlaPost.id}/view`, {
        method: 'POST',
        headers: browserHeaders,
        body: JSON.stringify({ visitorId: guestVid, dwellMs: 1100 }),
      })
    ).json() as any;
    assert(
      guestView1.recorded === 1 && guestView1.views === 2 && guestView2.recorded === 0 && guestView2.views === 2,
      'POST /api/posts/:id/view deduplicates repeated views by the same guest visitorId'
    );

    // 30e: Deduplicated share tracking
    const selfShareBody = await (
      await fetch(`${baseUrl}/api/posts/${obanlaPost.id}/share`, {
        method: 'POST',
        headers: { ...browserHeaders, Authorization: `Bearer ${validRegBody.token}` },
      })
    ).json() as any;
    const firstShareBody = await (
      await fetch(`${baseUrl}/api/posts/${obanlaPost.id}/share`, {
        method: 'POST',
        headers: { ...browserHeaders, Authorization: `Bearer ${studentToken}` },
      })
    ).json() as any;
    const dupShareBody = await (
      await fetch(`${baseUrl}/api/posts/${obanlaPost.id}/share`, {
        method: 'POST',
        headers: { ...browserHeaders, Authorization: `Bearer ${studentToken}` },
      })
    ).json() as any;
    assert(
      selfShareBody.incremented === false &&
        firstShareBody.incremented === true &&
        firstShareBody.shares === 1 &&
        dupShareBody.incremented === false &&
        dupShareBody.shares === 1,
      'POST /api/posts/:id/share counts unique shares once and excludes author self-shares'
    );

    // 30f: Anti-manipulation & balanced ranking (view-botted zero-engagement post vs genuine multi-signal trending post + single-user reply spam)
    const spamViewPost = postService.createPost(validRegBody.user.id, {
      content: 'Artificially viewed post with zero interactions.',
      areaKey: 'ipinsa',
    })!;
    db.prepare('UPDATE posts SET views_count = 160 WHERE id = ?').run(spamViewPost.id);

    const balancedTrendingPost = postService.createPost(validRegBody.user.id, {
      content: 'Genuine high-velocity campus update with real discussion and shares!',
      areaKey: 'obanla',
    })!;
    // Multi-actor meaningful engagement on balancedTrendingPost
    await fetch(`${baseUrl}/api/posts/${balancedTrendingPost.id}/like`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    await fetch(`${baseUrl}/api/posts/${balancedTrendingPost.id}/like`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await fetch(`${baseUrl}/api/posts/${balancedTrendingPost.id}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Super helpful info, thanks!' }),
    });
    await fetch(`${baseUrl}/api/posts/${balancedTrendingPost.id}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Confirmed, everyone take note.' }),
    });
    await fetch(`${baseUrl}/api/posts/${balancedTrendingPost.id}/repost`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    await fetch(`${baseUrl}/api/posts/${balancedTrendingPost.id}/share`, {
      method: 'POST',
      headers: { ...browserHeaders, Authorization: `Bearer ${studentToken}` },
    });
    await fetch(`${baseUrl}/api/posts/${balancedTrendingPost.id}/share`, {
      method: 'POST',
      headers: { ...browserHeaders, Authorization: `Bearer ${adminToken}` },
    });

    // Single-user comment spam test post (8 replies from the exact same user, zero other actors)
    const replySpamPost = postService.createPost(adminRow.id, {
      content: 'Post spammed with repeated comments from one account.',
      areaKey: 'ipinsa',
    })!;
    for (let i = 0; i < 8; i++) {
      await fetch(`${baseUrl}/api/posts/${replySpamPost.id}/comments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${validRegBody.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `Bump #${i}` }),
      });
    }
    cache.invalidatePrefix('posts:');

    // Verify Trending category places genuine burst post above view-botted & single-actor-spammed posts
    const trendingFeedRes = await fetch(`${baseUrl}/api/posts?paginated=1&limit=25&category=trending`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const trendingFeed = (await trendingFeedRes.json()) as any;
    const trendIds = (trendingFeed.posts || []).map((p: any) => p.id);
    const idxBalanced = trendIds.indexOf(balancedTrendingPost.id);
    const idxSpamView = trendIds.indexOf(spamViewPost.id);
    const idxReplySpam = trendIds.indexOf(replySpamPost.id);
    assert(
      trendingFeedRes.status === 200 &&
        trendingFeed.activeCategory === 'trending' &&
        idxBalanced !== -1 &&
        idxSpamView !== -1 &&
        idxReplySpam !== -1 &&
        idxBalanced < idxSpamView &&
        idxBalanced < idxReplySpam,
      `Trending feed promotes genuine multi-signal post (#${idxBalanced}) above view-botted (#${idxSpamView}) and reply-spammed (#${idxReplySpam}) posts`
    );

    // 30g: Nearby & Location filter test (excludes distant areas, prioritizes selected area) + Latest + pagination disjointness
    const nearbyFilteredPreRes = await fetch(`${baseUrl}/api/posts?paginated=1&limit=20&category=nearby&location=south_gate`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const nearbyFilteredPre = (await nearbyFilteredPreRes.json()) as any;
    const preIds = (nearbyFilteredPre.posts || []).map((p: any) => p.id);
    assert(
      nearbyFilteredPreRes.status === 200 &&
        nearbyFilteredPre.activeCategory === 'nearby' &&
        nearbyFilteredPre.activeLocation === 'south_gate' &&
        preIds.includes(sgPost.id) &&
        !preIds.includes(spamViewPost.id),
      'Nearby feed + South Gate filter includes South Gate posts and excludes distant areas (Ipinsa)'
    );

    // Give sgPost modest normal engagement so location + freshness + engagement places it #1 in Nearby + South Gate
    await fetch(`${baseUrl}/api/posts/${sgPost.id}/like`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    await fetch(`${baseUrl}/api/posts/${sgPost.id}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'See you at South Gate!' }),
    });
    cache.invalidatePrefix('posts:');

    const nearbySgRes = await fetch(`${baseUrl}/api/posts?paginated=1&limit=20&category=nearby&location=south_gate`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const nearbySgFeed = (await nearbySgRes.json()) as any;
    assert(
      nearbySgRes.status === 200 && nearbySgFeed.posts[0]?.areaKey === 'south_gate',
      `Nearby feed + South Gate filter ranks active South Gate post at top (top area=${nearbySgFeed.posts[0]?.areaKey})`
    );

    const latestRes = await fetch(`${baseUrl}/api/posts?paginated=1&limit=20&category=latest`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const latestFeed = (await latestRes.json()) as any;
    assert(
      latestRes.status === 200 &&
        latestFeed.activeCategory === 'latest' &&
        (latestFeed.posts || []).some((p: any) => p.id === replySpamPost.id),
      'Latest feed category returns chronological active posts'
    );

    const page1Res = await fetch(`${baseUrl}/api/posts?paginated=1&limit=2&offset=0&category=for_you`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const page1 = (await page1Res.json()) as any;
    const page2Res = await fetch(`${baseUrl}/api/posts?paginated=1&limit=2&offset=${page1.nextOffset ?? 2}&category=for_you`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const page2 = (await page2Res.json()) as any;
    const p1Ids = new Set((page1.posts || []).map((p: any) => p.id));
    const overlap = (page2.posts || []).filter((p: any) => p1Ids.has(p.id));
    assert(
      page1.posts?.length === 2 &&
        page1.hasMore === true &&
        page2.posts?.length > 0 &&
        overlap.length === 0,
      'Paginated For You feed returns deterministic disjoint pages'
    );

    // 30h: Opting out of location sharing wipes preferredLocationArea
    const optOutAreaRes = await fetch(`${baseUrl}/api/me/location-preference`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${studentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationSharingEnabled: false,
      }),
    });
    const optOutAreaBody = (await optOutAreaRes.json()) as any;
    assert(
      optOutAreaRes.status === 200 &&
        optOutAreaBody.locationSharingEnabled === false &&
        optOutAreaBody.preferredLocationArea === null,
      'Opting out of location sharing clears stored preferredLocationArea to null'
    );

    // 30i: 72-hour expiry sweep cleans up post_views and post_shares
    db.prepare(`UPDATE posts SET created_at = datetime('now', '-73 hours') WHERE id = ?`).run(obanlaPost.id);
    cache.invalidatePrefix('posts:');
    deletionService.run72HourExpirySweep('u-system-job');
    const remViews = (
      db.prepare('SELECT COUNT(*) as cnt FROM post_views WHERE post_id = ?').get(obanlaPost.id) as { cnt: number }
    ).cnt;
    const remShares = (
      db.prepare('SELECT COUNT(*) as cnt FROM post_shares WHERE post_id = ?').get(obanlaPost.id) as { cnt: number }
    ).cnt;
    assert(
      remViews === 0 && remShares === 0,
      '72-hour expiry sweep purges post_views and post_shares for expired posts'
    );

    // 30j: Dynamic Freshness & Engagement Velocity Weighting in 'For You' Feed
    const { computeDynamicForYouWeights } = await import('../services/feedRankingService.js');
    const busyFeedCtx = {
      freshRatio: 0.5,
      activeBurstRatio: 0.45,
      medianAgeHours: 5.5,
      adaptiveHalfLifeHours: 20,
    };
    const wFresh = computeDynamicForYouWeights({
      ageHours: 0.25,
      trendingVelocity: 0.15,
      accelerationFactor: 0.1,
      viewAnomalyFactor: 1.0,
      feedContext: busyFeedCtx,
    });
    const wSurging = computeDynamicForYouWeights({
      ageHours: 5.0,
      trendingVelocity: 0.8,
      accelerationFactor: 0.85,
      viewAnomalyFactor: 1.0,
      feedContext: busyFeedCtx,
    });
    const wDormant = computeDynamicForYouWeights({
      ageHours: 30.0,
      trendingVelocity: 0.04,
      accelerationFactor: 0.0,
      viewAnomalyFactor: 1.0,
      feedContext: busyFeedCtx,
    });
    const wViewBot = computeDynamicForYouWeights({
      ageHours: 5.0,
      trendingVelocity: 0.8,
      accelerationFactor: 0.0,
      viewAnomalyFactor: 0.35,
      feedContext: busyFeedCtx,
    });
    const sumWeights = (w: typeof wFresh) =>
      w.freshness + w.velocity + w.engagement + w.location + w.views + w.personalization;

    assert(
      Math.abs(sumWeights(wFresh) - 1) < 1e-6 &&
        Math.abs(sumWeights(wSurging) - 1) < 1e-6 &&
        wFresh.freshness <= 0.36 &&
        wSurging.velocity <= 0.36 &&
        wFresh.freshness > wSurging.freshness &&
        wSurging.velocity > wDormant.velocity &&
        wSurging.velocity > wViewBot.velocity,
      'computeDynamicForYouWeights dynamically shifts normalized weights across fresh, surging, dormant, and view-botted posts'
    );

    // HTTP check: recent surging post outranks older stagnant high-count post in For You
    const staleOldPost = postService.createPost(validRegBody.user.id, {
      content: 'Old yesterday discussion with static counts and zero recent activity.',
      areaKey: 'obanla',
    })!;
    db.prepare(`UPDATE posts SET created_at = datetime('now', '-34 hours'), likes_count = 14, comments_count = 5 WHERE id = ?`).run(
      staleOldPost.id
    );
    cache.invalidatePrefix('posts:');

    const forYouDynRes = await fetch(`${baseUrl}/api/posts?paginated=1&limit=25&category=for_you`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const forYouDyn = (await forYouDynRes.json()) as any;
    const fyIds = (forYouDyn.posts || []).map((p: any) => p.id);
    const idxSurging = fyIds.indexOf(balancedTrendingPost.id);
    const idxStale = fyIds.indexOf(staleOldPost.id);
    const idxBotFy = fyIds.indexOf(spamViewPost.id);
    assert(
      forYouDynRes.status === 200 &&
        forYouDyn.rankingStrategy === 'dynamic_velocity_freshness_v2' &&
        idxSurging !== -1 &&
        idxStale !== -1 &&
        idxBotFy !== -1 &&
        idxSurging < idxStale &&
        idxSurging < idxBotFy,
      `For You dynamic ranking promotes surging fresh post (#${idxSurging}) over stale 34h post (#${idxStale}) and view-botted post (#${idxBotFy})`
    );

    // =========================================================================
    // 31. ADMIN CONTROL (@THEBACKDOOR), ANALYTICS, ADS/PAYMENTS & MODERATOR RBAC
    // =========================================================================
    console.log('\n--- 31. Testing Admin Control (@THEBACKDOOR), Analytics, Ads, Payment Records & Moderator Role ---');

    // 31a: Single @THEBACKDOOR Admin account verification + reserved handle protection
    const adminAccounts = db.prepare("SELECT id, username, email, role FROM users WHERE role IN ('admin', 'superadmin')").all() as any[];
    assert(
      adminAccounts.length === 1 &&
        adminAccounts[0].id === 'u-admin' &&
        adminAccounts[0].username === '@THEBACKDOOR' &&
        adminAccounts[0].role === 'admin',
      'Database enforces strictly ONE Admin account (@THEBACKDOOR) with zero superadmin role'
    );

    const reservedRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: '@thebackdoor',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!',
        acceptTerms: true,
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    assert(reservedRegRes.status === 400, `Blocks public registration of reserved handle @thebackdoor (${reservedRegRes.status})`);

    // 31b: Official Admin post creation, editing, pinning & featuring
    const adminCreatePostRes = await fetch(`${baseUrl}/api/admin/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Official Campus Security & Exam Timetable Advisory from Platform Governance.',
        isPinned: true,
        isFeatured: true,
        distributionScope: 'global',
        areaKey: 'obanla',
      }),
    });
    const adminPost = (await adminCreatePostRes.json()) as any;
    assert(
      adminCreatePostRes.status === 201 &&
        adminPost.isAdminPost === true &&
        adminPost.isPinned === true &&
        adminPost.isFeatured === true &&
        adminPost.distributionScope === 'global',
      `Admin creates official pinned & globally featured post (${adminPost?.id})`
    );

    const adminEditPostRes = await fetch(`${baseUrl}/api/admin/posts/${adminPost.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Official Campus Security & Exam Timetable Advisory (Updated Notice).',
      }),
    });
    const editedAdminPost = (await adminEditPostRes.json()) as any;
    assert(
      adminEditPostRes.status === 200 && String(editedAdminPost.content || '').includes('Updated Notice'),
      'Admin edits official post cleanly'
    );

    const adminFeedCheckRes = await fetch(`${baseUrl}/api/posts?paginated=1&limit=15&category=for_you`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const adminFeedCheck = (await adminFeedCheckRes.json()) as any;
    const surfacedOfficial = (adminFeedCheck.posts || []).find((p: any) => p.id === adminPost.id);
    assert(
      Boolean(surfacedOfficial && surfacedOfficial.isAdminPost === true && surfacedOfficial.authorHandle === '@THEBACKDOOR'),
      'Official Admin post surfaces in student feed with @THEBACKDOOR attribution and isAdminPost=true'
    );

    // 31c: Complete Real-DB Analytics + Formula-Safe CSV & JSON Export
    const realTotalUsers = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
    const analytics7dRes = await fetch(`${baseUrl}/api/admin/analytics?range=7d`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const analytics7d = (await analytics7dRes.json()) as any;
    assert(
      analytics7dRes.status === 200 &&
        analytics7d.users?.totalUsers === realTotalUsers &&
        Array.isArray(analytics7d.activityTimeSeries) &&
        Array.isArray(analytics7d.locationActivity) &&
        typeof analytics7d.system?.databaseBytes === 'number',
      `Admin analytics returns real SQLite user total (${analytics7d.users?.totalUsers}) and non-fabricated breakdowns`
    );

    const csvExportRes = await fetch(`${baseUrl}/api/admin/analytics/export?range=7d&format=csv`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const csvExportText = await csvExportRes.text();
    assert(
      csvExportRes.status === 200 &&
        (csvExportRes.headers.get('content-type') || '').includes('text/csv') &&
        csvExportText.includes('"Section","Metric","Value","Notes"'),
      'Admin analytics CSV export returns valid structured CSV'
    );

    // 31d: Advertisements CRUD & Event Tracking + Admin Payment Records (while /api/admin/payments remains 404)
    const createAdRes = await fetch(`${baseUrl}/api/admin/advertisements`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Tech Bootcamp Cohort',
        sponsorName: 'Akure Tech Hub',
        body: 'Free weekend engineering workshop for students.',
        placement: 'feed',
        targetArea: 'obanla',
        status: 'active',
        budgetNaira: 25000,
      }),
    });
    const createdAd = (await createAdRes.json()) as any;
    assert(createAdRes.status === 201 && createdAd.title === 'Tech Bootcamp Cohort', `Admin creates advertisement (${createdAd?.id})`);

    const activeAdsRes = await fetch(`${baseUrl}/api/advertisements/active?area=obanla&placement=feed`);
    const activeAds = (await activeAdsRes.json()) as any[];
    assert(
      activeAdsRes.status === 200 && activeAds.some((a) => a.id === createdAd.id),
      'Active advertisement returned for targeted area/placement'
    );

    await fetch(`${baseUrl}/api/advertisements/${createdAd.id}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'impression' }),
    });
    const clickAdRes = await fetch(`${baseUrl}/api/advertisements/${createdAd.id}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'click' }),
    });
    const updatedAd = (await clickAdRes.json()) as any;
    assert(
      updatedAd.impressionsCount >= 1 && updatedAd.clicksCount >= 1 && updatedAd.ctrPercent > 0,
      `Advertisement event tracking updates impressions/clicks/CTR (${updatedAd.impressionsCount}/${updatedAd.clicksCount})`
    );

    const createPayRecRes = await fetch(`${baseUrl}/api/admin/payment-records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reference: `AD-REC-${Date.now()}`,
        amountNaira: 25000,
        purpose: 'sponsored_ad',
        channel: 'bank_transfer',
        payerAccountName: 'Akure Tech Hub',
        status: 'pending',
      }),
    });
    const createdPayRec = (await createPayRecRes.json()) as any;
    assert(createPayRecRes.status === 201 && createdPayRec.amountNaira === 25000, `Admin records sponsor payment (${createdPayRec?.id})`);

    const patchPayRecRes = await fetch(`${baseUrl}/api/admin/payment-records/${createdPayRec.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    const patchedPayRec = (await patchPayRecRes.json()) as any;
    assert(patchPayRecRes.status === 200 && patchedPayRec.status === 'confirmed', 'Admin confirms sponsor payment record status');

    const obsoletePayStill404 = await fetch(`${baseUrl}/api/admin/payments`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(obsoletePayStill404.status === 404, 'Legacy /api/admin/payments route remains strictly removed (404)');

    // 31e: Separate Moderator Role Creation, Backend Permission Matrix, Escalation & Restriction Enforcement
    const modUniq = Date.now().toString().slice(-5);
    const assignModRes = await fetch(`${baseUrl}/api/admin/moderators`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: `@mod_${modUniq}`,
        password: 'ModStrongPassword123!',
        name: 'Campus Moderator',
        department: 'Trust & Safety',
        permissions: {
          canReviewReports: true,
          canHideContent: true,
          canWarnUsers: true,
          canRestrictUsers: true,
          maxRestrictionHours: 24,
          canReviewCommunities: true,
          canEscalate: true,
          assignedAreas: ['obanla', 'south_gate'],
        },
      }),
    });
    const assignedMod = (await assignModRes.json()) as any;
    assert(
      assignModRes.status === 201 && Boolean(assignedMod?.id) && assignedMod.permissions?.maxRestrictionHours === 24,
      `Admin creates scoped Moderator account (${assignedMod?.id})`
    );

    const modLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `@mod_${modUniq}`, password: 'ModStrongPassword123!' }),
    });
    const modLoginBody = (await modLoginRes.json()) as any;
    const modToken = modLoginBody.token;
    assert(modLoginRes.status === 200 && Boolean(modToken) && modLoginBody.user?.role === 'moderator', 'Moderator logs in with role="moderator"');

    // Moderator access to /api/mod/* succeeds
    const modDashRes = await fetch(`${baseUrl}/api/mod/dashboard`, {
      headers: { Authorization: `Bearer ${modToken}` },
    });
    const modDashBody = (await modDashRes.json()) as any;
    assert(
      modDashRes.status === 200 && typeof modDashBody.stats?.pendingReports === 'number',
      'Moderator accesses /api/mod/dashboard cleanly'
    );

    // Moderator is strictly blocked (403) from ALL Admin routes, settings, payments, ads, chats & user dumps
    for (const forbiddenAdminRoute of [
      { method: 'GET', path: '/api/admin/dashboard' },
      { method: 'GET', path: '/api/admin/analytics' },
      { method: 'GET', path: '/api/admin/settings' },
      { method: 'GET', path: '/api/admin/payment-records' },
      { method: 'GET', path: '/api/admin/advertisements' },
      { method: 'GET', path: '/api/admin/moderators' },
      { method: 'GET', path: '/api/admin/chats' },
      { method: 'GET', path: '/api/admin/users' },
    ]) {
      const denyRes = await fetch(`${baseUrl}${forbiddenAdminRoute.path}`, {
        method: forbiddenAdminRoute.method,
        headers: { Authorization: `Bearer ${modToken}` },
      });
      assert(denyRes.status === 403, `Moderator strictly blocked (403) from ${forbiddenAdminRoute.method} ${forbiddenAdminRoute.path}`);
    }

    // Moderator CANNOT target Admin (@THEBACKDOOR) for warning or hiding official posts
    const modWarnAdminRes = await fetch(`${baseUrl}/api/mod/users/${adminRow.id}/warn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${modToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Unauthorized attempt against admin' }),
    });
    assert(modWarnAdminRes.status === 403, 'Moderator blocked (403) from issuing warning to Admin @THEBACKDOOR');

    const modHideAdminPostRes = await fetch(`${baseUrl}/api/mod/content/post/${adminPost.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${modToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'hide', reason: 'Attempt to hide official notice' }),
    });
    assert(modHideAdminPostRes.status === 403, 'Moderator blocked (403) from hiding Official Admin post');

    // Moderator exceeds maxRestrictionHours (48 > 24) -> blocked with 403 MODERATOR_DURATION_EXCEEDED
    const exceedHoursRes = await fetch(`${baseUrl}/api/mod/users/${validRegBody.user.id}/restrict`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${modToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ durationHours: 48, reason: 'Testing max hours boundary' }),
    });
    assert(exceedHoursRes.status === 403, 'Moderator blocked (403) when attempting restriction exceeding maxRestrictionHours');

    // Moderator warns student & applies valid 12h temporary restriction -> student blocked from posting/commenting/messaging (403 ACCOUNT_RESTRICTED)
    const modWarnStudentRes = await fetch(`${baseUrl}/api/mod/users/${validRegBody.user.id}/warn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${modToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Repeated off-topic spam in feed', severity: 'standard' }),
    });
    assert(modWarnStudentRes.status === 201, 'Moderator successfully warns student account');

    const modRestrictRes = await fetch(`${baseUrl}/api/mod/users/${validRegBody.user.id}/restrict`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${modToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ durationHours: 12, reason: 'Temporary 12h cooldown after warning' }),
    });
    assert(modRestrictRes.status === 200, 'Moderator successfully applies time-bounded 12h temporary restriction');

    const restrictedPostRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Blocked while temporarily restricted' }),
    });
    const restrictedPostBody = (await restrictedPostRes.json()) as any;
    assert(
      restrictedPostRes.status === 403 && restrictedPostBody.code === 'ACCOUNT_RESTRICTED',
      'Temporarily restricted student blocked (403 ACCOUNT_RESTRICTED) from creating posts'
    );

    const restrictedCommentRes = await fetch(`${baseUrl}/api/posts/${flaggedTargetPost.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Blocked comment while restricted' }),
    });
    assert(restrictedCommentRes.status === 403, 'Temporarily restricted student blocked (403) from commenting');

    // Admin lifts restriction -> student immediately regains posting access
    const liftRes = await fetch(`${baseUrl}/api/admin/users/${validRegBody.user.id}/lift-restriction`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Restriction lifted after review' }),
    });
    assert(liftRes.status === 200, 'Admin lifts temporary restriction on student account');

    const postAfterLiftRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validRegBody.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Posting restored after Admin lifted restriction' }),
    });
    assert(postAfterLiftRes.status === 201, 'Student regains posting access immediately after restriction lift');

    // Moderator escalates report to Admin & Admin receives escalation notification
    const modEscalateRes = await fetch(`${baseUrl}/api/mod/reports/${reportCreatedBody.id}/escalate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${modToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Coordinated harassment requiring full Admin review' }),
    });
    const modEscalateBody = (await modEscalateRes.json()) as any;
    assert(modEscalateRes.status === 200 && modEscalateBody.escalatedToAdmin === true, 'Moderator escalates serious case to Admin');

    // Admin revokes canWarnUsers permission dynamically -> backend rejects next Moderator warning (403)
    const patchPermRes = await fetch(`${baseUrl}/api/admin/moderators/${assignedMod.id}/permissions`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ canWarnUsers: false }),
    });
    assert(patchPermRes.status === 200, 'Admin updates Moderator permission matrix dynamically');

    const revokedWarnRes = await fetch(`${baseUrl}/api/mod/users/${validRegBody.user.id}/warn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${modToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Warning after capability disabled' }),
    });
    assert(revokedWarnRes.status === 403, 'Backend enforces disabled canWarnUsers Moderator permission (403)');

    // Admin revokes Moderator role cleanly -> Moderator loses /api/mod/* access (403)
    const revokeModRes = await fetch(`${baseUrl}/api/admin/moderators/${assignedMod.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(revokeModRes.status === 200, 'Admin revokes Moderator status cleanly');

    const postRevokeModRes = await fetch(`${baseUrl}/api/mod/dashboard`, {
      headers: { Authorization: `Bearer ${modToken}` },
    });
    assert(postRevokeModRes.status === 403, 'Revoked Moderator loses /api/mod/dashboard access immediately (403)');

    // =========================================================================
    // 32. APP STORE READINESS, DUAL-TOKEN REFRESH, MULTI-DEVICE, ACL & SECURITY
    // =========================================================================
    console.log('\n--- 32. Testing Dual-Token Refresh, Multi-Device Limits, Moderator MFA, Chat Media ACL, Group Blocks, ToS Gating & Admin Security ---');

    // 32a: Register without acceptTerms rejected (400 TERMS_ACCEPTANCE_REQUIRED)
    const noTosRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@notos_${Date.now().toString().slice(-5)}`,
        password: 'StrongPassword2026!',
        confirmPassword: 'StrongPassword2026!',
        name: 'No ToS',
      }),
    });
    const noTosBody = (await noTosRes.json()) as any;
    assert(
      noTosRes.status === 400 && noTosBody.code === 'TERMS_ACCEPTANCE_REQUIRED',
      'POST /api/auth/register rejects signup without acceptTerms=true (400 TERMS_ACCEPTANCE_REQUIRED)'
    );

    // 32b: Valid signup issues BOTH sb_session (15m) + sb_refresh (30d) HttpOnly SameSite=Strict cookies
    const secUniq = Date.now().toString().slice(-6);
    const secHandle = `@sec32_${secUniq}`;
    const secPassword = 'Sec32Password!2026';
    const secRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: secHandle,
        password: secPassword,
        confirmPassword: secPassword,
        acceptTerms: true,
        name: 'Security Audit Student',
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    const secRegBody = (await secRegRes.json()) as any;
    const getSetCookies = (res: Response): string[] => {
      const anyHeaders = res.headers as any;
      if (typeof anyHeaders.getSetCookie === 'function') {
        return anyHeaders.getSetCookie();
      }
      const single = res.headers.get('set-cookie');
      return single ? [single] : [];
    };
    const secRegCookies = getSetCookies(secRegRes).join('; ');
    const extractCookieValue = (cookies: string[], name: string) => {
      for (const part of cookies) {
        const seg = part.split(';')[0]?.trim() || '';
        if (seg.startsWith(`${name}=`)) return seg.slice(name.length + 1);
      }
      return '';
    };
    const initialSetCookies = getSetCookies(secRegRes);
    const refreshVal1 = extractCookieValue(initialSetCookies, 'sb_refresh');
    assert(
      secRegRes.status === 201 &&
        Boolean(secRegBody.token) &&
        secRegBody.refreshToken === undefined &&
        secRegCookies.includes('sb_session=') &&
        secRegCookies.includes('sb_refresh=') &&
        Boolean(refreshVal1),
      'Signup sets dual sb_session + sb_refresh HttpOnly cookies without exposing refreshToken in JSON'
    );

    // 32c: Refresh rotation + reuse detection
    const refreshRes1 = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `sb_refresh=${refreshVal1}` },
    });
    const refreshBody1 = (await refreshRes1.json()) as any;
    const refreshSetCookies1 = getSetCookies(refreshRes1);
    const refreshVal2 = extractCookieValue(refreshSetCookies1, 'sb_refresh');
    assert(
      refreshRes1.status === 200 &&
        Boolean(refreshBody1.token) &&
        refreshBody1.token !== secRegBody.token &&
        Boolean(refreshVal2) &&
        refreshVal2 !== refreshVal1,
      'POST /api/auth/refresh rotates both access token and refresh cookie cleanly'
    );

    // Replaying old refreshVal1 triggers REFRESH_TOKEN_REUSE & revokes all sessions for the user
    const reuseRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `sb_refresh=${refreshVal1}` },
    });
    const reuseBody = (await reuseRes.json()) as any;
    const activeAfterReuse = db
      .prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
      .get(secRegBody.user.id) as { cnt: number };
    const reuseEvent = db
      .prepare("SELECT * FROM security_events WHERE user_id = ? AND event_type = 'REFRESH_TOKEN_REUSE' ORDER BY created_at DESC LIMIT 1")
      .get(secRegBody.user.id) as any;
    assert(
      reuseRes.status === 401 &&
        reuseBody.code === 'REFRESH_TOKEN_REUSE' &&
        activeAfterReuse.cnt === 0 &&
        reuseEvent?.severity === 'critical',
      'Replaying rotated refresh token detects reuse, revokes all user sessions, and logs critical security event'
    );

    // 32d: Multi-device concurrency (5 allowed, 6th evicts oldest) + Device management API
    const uas = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/128.0.0.0',
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Chrome/128.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/130.0',
      'Mozilla/5.0 (X11; Linux x86_64) Chrome/129.0.0.0',
    ];
    const deviceTokens: string[] = [];
    for (const ua of uas.slice(0, 5)) {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({ identifier: secHandle, password: secPassword }),
      });
      const b = (await r.json()) as any;
      assert(r.status === 200 && Boolean(b.token), `Concurrent device login succeeded (${ua.slice(0, 28)}...)`);
      deviceTokens.push(b.token);
    }

    const sessionsList5 = await fetch(`${baseUrl}/api/me/sessions`, {
      headers: { Authorization: `Bearer ${deviceTokens[4]}` },
    });
    const sessionsBody5 = (await sessionsList5.json()) as any;
    assert(
      sessionsList5.status === 200 && Array.isArray(sessionsBody5.sessions) && sessionsBody5.sessions.length === 5,
      `User maintains 5 concurrent device sessions (got ${sessionsBody5.sessions?.length})`
    );

    // 6th device evicts oldest (deviceTokens[0])
    const sixthRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': uas[5] },
      body: JSON.stringify({ identifier: secHandle, password: secPassword }),
    });
    const sixthBody = (await sixthRes.json()) as any;
    const oldestCheckRes = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${deviceTokens[0]}` },
    });
    const sessionsListAfter6 = await fetch(`${baseUrl}/api/me/sessions`, {
      headers: { Authorization: `Bearer ${sixthBody.token}` },
    });
    const sessionsBodyAfter6 = (await sessionsListAfter6.json()) as any;
    const newDeviceNotif = db
      .prepare("SELECT * FROM notifications WHERE user_id = ? AND title LIKE 'New Device Sign-In%' LIMIT 1")
      .get(secRegBody.user.id) as any;
    assert(
      sixthRes.status === 200 &&
        oldestCheckRes.status === 401 &&
        sessionsBodyAfter6.sessions.length === 5 &&
        Boolean(newDeviceNotif),
      '6th concurrent login evicts oldest device cleanly, preserves 5 active sessions, and notifies user of new device'
    );

    // Revoke single device & revoke others
    const targetOtherSession = sessionsBodyAfter6.sessions.find((s: any) => !s.isCurrent);
    const revokeSingleRes = await fetch(`${baseUrl}/api/me/sessions/${targetOtherSession.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sixthBody.token}` },
    });
    const revokeOthersRes = await fetch(`${baseUrl}/api/me/sessions/revoke-others`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sixthBody.token}` },
    });
    const revokeOthersBody = (await revokeOthersRes.json()) as any;
    const finalSelfCheck = await fetch(`${baseUrl}/api/me/sessions`, {
      headers: { Authorization: `Bearer ${sixthBody.token}` },
    });
    const finalSelfBody = (await finalSelfCheck.json()) as any;
    assert(
      revokeSingleRes.status === 200 &&
        revokeOthersRes.status === 200 &&
        revokeOthersBody.revokedCount >= 3 &&
        finalSelfBody.sessions.length === 1,
      'User can sign out individual device and all other devices while keeping current session'
    );

    // 32e: Change password revokes other sessions & reauthentication gates stale delete-account
    const extraLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': uas[0] },
      body: JSON.stringify({ identifier: secHandle, password: secPassword }),
    });
    const extraLoginBody = (await extraLogin.json()) as any;
    const newSecPassword = 'Sec32UpdatedPass!2026';
    const changePwdRes = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sixthBody.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: secPassword, newPassword: newSecPassword }),
    });
    const changePwdBody = (await changePwdRes.json()) as any;
    const extraAfterPwdCheck = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${extraLoginBody.token}` },
    });
    assert(
      changePwdRes.status === 200 && changePwdBody.revokedOtherSessions >= 1 && extraAfterPwdCheck.status === 401,
      'POST /api/auth/change-password updates credentials and revokes other active sessions'
    );

    // Force stale reauthentication (>15m ago) -> delete-account without password fails 403 -> reauthenticate -> succeeds 200
    db.prepare("UPDATE users SET last_reauthenticated_at = datetime('now', '-30 minutes') WHERE id = ?").run(secRegBody.user.id);
    const staleDelRes = await fetch(`${baseUrl}/api/user/delete-account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sixthBody.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'PERMANENTLY_DELETE', reason: 'Testing stale reauth' }),
    });
    const staleDelBody = (await staleDelRes.json()) as any;
    assert(
      staleDelRes.status === 403 && staleDelBody.code === 'REAUTH_REQUIRED',
      'POST /api/user/delete-account requires password or fresh reauth after 15 minutes (403 REAUTH_REQUIRED)'
    );

    const reauthRes = await fetch(`${baseUrl}/api/auth/reauthenticate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sixthBody.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newSecPassword }),
    });
    const delOkRes = await fetch(`${baseUrl}/api/user/delete-account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sixthBody.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'PERMANENTLY_DELETE', reason: 'Testing verified deletion' }),
    });
    const loginDeletedRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: secHandle, password: newSecPassword }),
    });
    assert(
      reauthRes.status === 200 && delOkRes.status === 200 && loginDeletedRes.status === 401,
      'POST /api/auth/reauthenticate unlocks self-service permanent deletion and wipes credentials immediately'
    );
    db.prepare('DELETE FROM login_attempts').run();

    // 32f: Moderator TOTP MFA & Student MFA Denial
    const modMfaUser = authService.register({
      username: `@modmfa_${secUniq}`,
      password: 'ModMfaPassword!2026',
      confirmPassword: 'ModMfaPassword!2026',
      acceptTerms: true,
      name: 'MFA Moderator',
    });
    const studentMfaDeny = await fetch(`${baseUrl}/api/auth/mfa/setup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert(studentMfaDeny.status === 403, 'Regular student denied privileged TOTP MFA setup (403)');

    const { moderatorService } = await import('../services/moderatorService.js');
    moderatorService.assignModerator(adminRow.id, { userId: modMfaUser.user.id });
    const modMfaSessionToken = authService.createSession(modMfaUser.user.id, '127.0.0.1', 'ModTest').token;
    const modSetupRes = await fetch(`${baseUrl}/api/auth/mfa/setup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${modMfaSessionToken}` },
    });
    const modSetupBody = (await modSetupRes.json()) as any;
    const modTotp = computeTotpCode(modSetupBody.secret);
    const modVerifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${modMfaSessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: modTotp }),
    });
    const modLoginNoCode = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: modMfaUser.user.username, password: 'ModMfaPassword!2026' }),
    });
    const modLoginNoCodeBody = (await modLoginNoCode.json()) as any;
    const modLoginWithCode = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: modMfaUser.user.username,
        password: 'ModMfaPassword!2026',
        mfaCode: computeTotpCode(modSetupBody.secret),
      }),
    });
    assert(
      modSetupRes.status === 200 &&
        modVerifyRes.status === 200 &&
        modLoginNoCode.status === 403 &&
        modLoginNoCodeBody.mfaRequired === true &&
        modLoginWithCode.status === 200,
      'Moderator TOTP MFA setup/verification enforced on login (403 mfaRequired -> 200 with valid code)'
    );

    // 32g: Escalating login cooldown (never permanent lockout) + security_events burst logging
    const lockUser = authService.register({
      username: `@lock32_${secUniq}`,
      password: 'LockPassword!2026',
      confirmPassword: 'LockPassword!2026',
      acceptTerms: true,
    });
    let hit429 = false;
    let burstRetryAfter = 0;
    for (let i = 0; i < 6; i++) {
      const failRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: lockUser.user.username, password: 'WrongPassword!99' }),
      });
      if (failRes.status === 429) {
        hit429 = true;
        burstRetryAfter = Number(failRes.headers.get('retry-after') || 0);
        break;
      }
    }
    const lockUserStatus = db.prepare('SELECT status FROM users WHERE id = ?').get(lockUser.user.id) as { status: string };
    const burstEvent = db
      .prepare("SELECT * FROM security_events WHERE event_type = 'FAILED_LOGIN_BURST' ORDER BY created_at DESC LIMIT 1")
      .get() as any;
    assert(
      hit429 && burstRetryAfter > 0 && lockUserStatus.status === 'active' && Boolean(burstEvent),
      `Escalating cooldown returns 429 + Retry-After (${burstRetryAfter}s), logs FAILED_LOGIN_BURST, and avoids permanent lockout`
    );
    db.prepare('DELETE FROM login_attempts').run();
    db.prepare('DELETE FROM account_lockouts').run();

    // 32h: Private chat media access control (/api/uploads/:filename)
    const aliceReg = authService.register({
      username: `@alice32_${secUniq}`,
      password: 'AlicePassword!2026',
      confirmPassword: 'AlicePassword!2026',
      acceptTerms: true,
    });
    const bobReg = authService.register({
      username: `@bob32_${secUniq}`,
      password: 'BobPassword!2026',
      confirmPassword: 'BobPassword!2026',
      acceptTerms: true,
    });
    const carolReg = authService.register({
      username: `@carol32_${secUniq}`,
      password: 'CarolPassword!2026',
      confirmPassword: 'CarolPassword!2026',
      acceptTerms: true,
    });
    const aliceToken = authService.createSession(aliceReg.user.id, '127.0.0.1', 'AliceDev').token;
    const bobToken = authService.createSession(bobReg.user.id, '127.0.0.1', 'BobDev').token;
    const carolToken = authService.createSession(carolReg.user.id, '127.0.0.1', 'CarolDev').token;

    const tinyPngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
    const dmUploadRes = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: tinyPngDataUrl }),
    });
    const dmUploadBody = (await dmUploadRes.json()) as any;
    const abChat = chatService.createDirectChat(aliceReg.user.id, bobReg.user.id);
    const dmMsgRes = await fetch(`${baseUrl}/api/chats/${abChat.chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Private DM photo', images: [dmUploadBody.url] }),
    });

    const uploadAnonRes = await fetch(`${baseUrl}${dmUploadBody.url}`);
    const uploadCarolRes = await fetch(`${baseUrl}${dmUploadBody.url}`, {
      headers: { Authorization: `Bearer ${carolToken}` },
    });
    const uploadBobRes = await fetch(`${baseUrl}${dmUploadBody.url}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    const uploadAdminRes = await fetch(`${baseUrl}${dmUploadBody.url}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const bobCache = String(uploadBobRes.headers.get('cache-control') || '');
    assert(
      dmUploadRes.status === 201 &&
        dmMsgRes.status === 201 &&
        uploadAnonRes.status === 401 &&
        uploadCarolRes.status === 403 &&
        uploadBobRes.status === 200 &&
        bobCache.includes('no-store') &&
        uploadAdminRes.status === 200,
      `Chat-only media enforces participant-only ACL (upload=${dmUploadRes.status}, msg=${dmMsgRes.status}, anon=${uploadAnonRes.status}, carol=${uploadCarolRes.status}, bob=${uploadBobRes.status}, cache=${bobCache}, admin=${uploadAdminRes.status})`
    );

    // 32i: Group chat blocked-user message filtering
    const groupChatId = `grp-32-${secUniq}`;
    db.prepare(`
      INSERT INTO chats (id, type, title, handle, subtitle, avatar_initials, avatar_bg)
      VALUES (?, 'group', 'Study Group 32', ?, 'Members', 'SG', 'bg-stone-800 text-stone-100')
    `).run(groupChatId, `@grp32_${secUniq}`);
    db.prepare(`
      INSERT INTO chat_participants (id, chat_id, user_id, role)
      VALUES (?, ?, ?, 'admin'), (?, ?, ?, 'member'), (?, ?, ?, 'member')
    `).run(
      `cp-a-${secUniq}`, groupChatId, aliceReg.user.id,
      `cp-b-${secUniq}`, groupChatId, bobReg.user.id,
      `cp-c-${secUniq}`, groupChatId, carolReg.user.id
    );
    chatService.sendMessage(groupChatId, bobReg.user.id, { text: 'Hello group from Bob' });
    blockService.blockUser(aliceReg.user.id, bobReg.user.id);

    const aliceChatsRes = await fetch(`${baseUrl}/api/chats`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const aliceChats = (await aliceChatsRes.json()) as any[];
    const aliceGroup = aliceChats.find((c) => c.id === groupChatId);

    const carolChatsRes = await fetch(`${baseUrl}/api/chats`, {
      headers: { Authorization: `Bearer ${carolToken}` },
    });
    const carolChats = (await carolChatsRes.json()) as any[];
    const carolGroup = carolChats.find((c) => c.id === groupChatId);
    assert(
      aliceGroup &&
        aliceGroup.messages.every((m: any) => !String(m.text).includes('Hello group from Bob')) &&
        carolGroup &&
        carolGroup.messages.some((m: any) => String(m.text).includes('Hello group from Bob')),
      'Group chat filters messages from blocked users cleanly for blocker while preserving view for other members'
    );

    // 32j: Existing/unaccepted user blocked from UGC until accepting Terms via POST /api/me/accept-terms
    const unacceptedReg = authService.register({
      username: `@noacc_${secUniq}`,
      password: 'NoAcceptPassword!2026',
      confirmPassword: 'NoAcceptPassword!2026',
      acceptTerms: false,
    });
    const unacceptedToken = authService.createSession(unacceptedReg.user.id, '127.0.0.1', 'NoAcceptDev').token;
    const blockedPostNoTos = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unacceptedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Blocked before ToS acceptance' }),
    });
    const blockedPostNoTosBody = (await blockedPostNoTos.json()) as any;
    const acceptTosRes = await fetch(`${baseUrl}/api/me/accept-terms`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unacceptedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    });
    const allowedPostAfterTos = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unacceptedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Allowed immediately after ToS acceptance' }),
    });
    assert(
      blockedPostNoTos.status === 403 &&
        blockedPostNoTosBody.code === 'TERMS_ACCEPTANCE_REQUIRED' &&
        acceptTosRes.status === 200 &&
        allowedPostAfterTos.status === 201,
      'UGC endpoints enforce Terms acceptance (403 TERMS_ACCEPTANCE_REQUIRED) and unlock upon POST /api/me/accept-terms'
    );

    // 32k: Admin Security Session & Event Monitoring Endpoints (Admin 200, Mod/Student 403)
    const modSecDeny = await fetch(`${baseUrl}/api/admin/security/sessions`, {
      headers: { Authorization: `Bearer ${modMfaSessionToken}` },
    });
    const adminSecOverviewRes = await fetch(`${baseUrl}/api/admin/security`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminSecOverviewBody = (await adminSecOverviewRes.json()) as any;
    const adminSecEventsRes = await fetch(`${baseUrl}/api/admin/security/events?severity=critical`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminSecEventsBody = (await adminSecEventsRes.json()) as any;
    const adminRevokeAliceRes = await fetch(`${baseUrl}/api/admin/security/users/${aliceReg.user.id}/revoke-sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const alicePostRevokeCheck = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert(
      modSecDeny.status === 403 &&
        adminSecOverviewRes.status === 200 &&
        Array.isArray(adminSecOverviewBody.activeSessions) &&
        adminSecEventsRes.status === 200 &&
        Array.isArray(adminSecEventsBody.events) &&
        adminRevokeAliceRes.status === 200 &&
        alicePostRevokeCheck.status === 401,
      'Admin security endpoints monitor sessions/events cleanly, enforce Admin-only RBAC (403 for Mod), and remotely revoke user sessions'
    );

    // =========================================================================
    // 33. STRICT 20MB IMAGE LIMIT, FORMATS, PROFILE PICTURES & COMMENT MEDIA
    // =========================================================================
    console.log('\n--- 33. Testing 20MB Image Upload Limit, JPEG/PNG/WebP Formats, Profile Pictures & Comment/Reply Media ---');
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const mediaUniq = Date.now().toString().slice(-6);

    const makeValidJpeg = (tag = 'jpg0') =>
      `data:image/jpeg;base64,${Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]),
        Buffer.from(tag),
      ]).toString('base64')}`;
    const makeValidPng = (tag = 'png0') =>
      `data:image/png;base64,${Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
        Buffer.from(tag),
      ]).toString('base64')}`;
    const makeValidWebp = (tag = 'webp0') => {
      const b = Buffer.alloc(24, 0);
      b.write('RIFF', 0, 'ascii');
      b.writeUInt32LE(16, 4);
      b.write('WEBP', 8, 'ascii');
      b.write('VP8 ', 12, 'ascii');
      return `data:image/webp;base64,${Buffer.concat([b, Buffer.from(tag)]).toString('base64')}`;
    };

    const over20MbBuf = Buffer.alloc(20 * 1024 * 1024 + 1024);
    over20MbBuf[0] = 0xff;
    over20MbBuf[1] = 0xd8;
    over20MbBuf[2] = 0xff;
    const over20MbDataUrl = `data:image/jpeg;base64,${over20MbBuf.toString('base64')}`;

    // 33a: Registration with valid JPEG avatar + thumb + direct oversized (>20MB) API bypass rejection
    const overRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@overreg_${mediaUniq}`,
        password: 'MediaPassword!2026',
        confirmPassword: 'MediaPassword!2026',
        acceptTerms: true,
        avatarDataUrl: over20MbDataUrl,
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    const overRegBody = (await overRegRes.json()) as any;
    assert(
      overRegRes.status === 413 && overRegBody.code === 'IMAGE_TOO_LARGE',
      `POST /api/auth/register rejects >20MB avatar bypass (status=${overRegRes.status}, code=${overRegBody.code})`
    );

    const mediaRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@mediauser_${mediaUniq}`,
        password: 'MediaPassword!2026',
        confirmPassword: 'MediaPassword!2026',
        name: 'Media Tester',
        acceptTerms: true,
        avatarDataUrl: makeValidJpeg(),
        avatarThumbnailDataUrl: makeValidWebp(),
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    const mediaRegBody = (await mediaRegRes.json()) as any;
    const mediaToken = mediaRegBody.token;
    const mediaUserId = mediaRegBody.user.id;
    const initialAvatarUrl = mediaRegBody.profile?.avatarUrl;
    const initialAvatarThumbUrl = mediaRegBody.profile?.avatarThumbUrl;
    assert(
      mediaRegRes.status === 201 &&
        Boolean(initialAvatarUrl) &&
        Boolean(initialAvatarThumbUrl) &&
        String(initialAvatarUrl).startsWith('/api/uploads/'),
      'POST /api/auth/register persists both avatarUrl and avatarThumbUrl for new accounts'
    );

    const peerReg = authService.register({
      username: `@mediapeer_${mediaUniq}`,
      password: 'MediaPeerPassword!2026',
      confirmPassword: 'MediaPeerPassword!2026',
      name: 'Media Peer',
      acceptTerms: true,
    });
    const peerToken = authService.createSession(peerReg.user.id, '127.0.0.1', 'MediaPeerDev').token;

    // 33b: Format checks (JPEG, PNG, WebP accepted; unsupported SVG/GIF rejected; unrelated text payloads unaffected)
    const upJpeg = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: makeValidJpeg() }),
    });
    const upPng = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: makeValidPng() }),
    });
    const upWebp = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: makeValidWebp() }),
    });
    const upBadSvg = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }),
    });
    assert(
      upJpeg.status === 201 && upPng.status === 201 && upWebp.status === 201 && upBadSvg.status === 400,
      'POST /api/files/upload accepts JPEG, PNG, WebP and rejects unsupported formats (SVG -> 400)'
    );

    // 33c: Direct API bypass checks (>20MB) across /files/upload, /posts, /posts/:id/comments, /chats/:id/messages, /me/profile
    const upOverRes = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: over20MbDataUrl }),
    });
    const upOverBody = (await upOverRes.json()) as any;

    const postOverRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Oversized bypass test', images: [over20MbDataUrl] }),
    });
    const postOverBody = (await postOverRes.json()) as any;

    const validPostRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Post with valid PNG + WebP photos',
        images: [makeValidPng(), makeValidWebp()],
      }),
    });
    const validPost = (await validPostRes.json()) as any;

    const commentOverRes = await fetch(`${baseUrl}/api/posts/${validPost.id}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Oversized comment bypass', images: [over20MbDataUrl] }),
    });
    const commentOverBody = (await commentOverRes.json()) as any;

    const dmRes = await fetch(`${baseUrl}/api/chats/direct`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: peerReg.user.id }),
    });
    const dmBody = (await dmRes.json()) as any;

    const chatOverRes = await fetch(`${baseUrl}/api/chats/${dmBody.chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Oversized DM bypass', images: [over20MbDataUrl] }),
    });
    const chatOverBody = (await chatOverRes.json()) as any;

    const profOverRes = await fetch(`${baseUrl}/api/me/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarDataUrl: over20MbDataUrl }),
    });
    const profOverBody = (await profOverRes.json()) as any;

    assert(
      upOverRes.status === 413 && upOverBody.code === 'IMAGE_TOO_LARGE' &&
        postOverRes.status === 413 && postOverBody.code === 'IMAGE_TOO_LARGE' &&
        commentOverRes.status === 413 && commentOverBody.code === 'IMAGE_TOO_LARGE' &&
        chatOverRes.status === 413 && chatOverBody.code === 'IMAGE_TOO_LARGE' &&
        profOverRes.status === 413 && profOverBody.code === 'IMAGE_TOO_LARGE',
      'Direct API bypasses >20MB rejected with 413 IMAGE_TOO_LARGE across upload, post, comment, chat, and profile endpoints'
    );

    // 33d: Profile picture replace + old file unlink + removeAvatar cleanup
    const uploadsDir = getUploadsDir();
    const initialAvatarFilename = pathMod.basename(initialAvatarUrl);
    const initialThumbFilename = pathMod.basename(initialAvatarThumbUrl);
    assert(
      fsMod.existsSync(pathMod.join(uploadsDir, initialAvatarFilename)) &&
        fsMod.existsSync(pathMod.join(uploadsDir, initialThumbFilename)),
      'Initial registration avatar & thumbnail files exist on disk'
    );

    const replaceAvatarRes = await fetch(`${baseUrl}/api/me/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        avatarDataUrl: makeValidPng('replaced-avatar'),
        avatarThumbnailDataUrl: makeValidPng('replaced-thumb'),
        bio: 'Updated bio & avatar',
      }),
    });
    const replacedProfile = (await replaceAvatarRes.json()) as any;
    assert(
      replaceAvatarRes.status === 200 &&
        replacedProfile.avatarUrl !== initialAvatarUrl &&
        !fsMod.existsSync(pathMod.join(uploadsDir, initialAvatarFilename)) &&
        !fsMod.existsSync(pathMod.join(uploadsDir, initialThumbFilename)),
      'Replacing profile avatar updates URL and unlinks previous avatar & thumbnail files from disk'
    );

    // Anonymous post must NOT expose author avatar even when author has an active avatar
    const anonPostRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Anonymous whisper with active profile photo', is_anonymous: true }),
    });
    const anonPostCreated = (await anonPostRes.json()) as any;
    const anonFeedView = await fetch(`${baseUrl}/api/posts/${anonPostCreated.id}`, {
      headers: { Authorization: `Bearer ${peerToken}` },
    });
    const anonFeedObj = (await anonFeedView.json()) as any;
    assert(
      anonPostRes.status === 201 &&
        !anonFeedObj.avatarUrl &&
        !anonFeedObj.avatarThumbUrl &&
        anonFeedObj.avatarInitials === 'AN',
      'Anonymous posts strictly hide author avatarUrl and avatarThumbUrl while keeping AN badge'
    );

    // Remove avatar deletes files & clears DB columns
    const replacedFilename = pathMod.basename(replacedProfile.avatarUrl);
    const removeAvatarRes = await fetch(`${baseUrl}/api/me/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeAvatar: true }),
    });
    const removedProfile = (await removeAvatarRes.json()) as any;
    const publicAfterRemove = await (await fetch(`${baseUrl}/api/users/${mediaUserId}/profile`)).json() as any;
    assert(
      removeAvatarRes.status === 200 &&
        !removedProfile.avatarUrl &&
        !removedProfile.avatarThumbUrl &&
        !publicAfterRemove.avatarUrl &&
        !fsMod.existsSync(pathMod.join(uploadsDir, replacedFilename)),
      'Removing profile picture clears avatar columns in DB & public profile and unlinks disk file'
    );

    // Restore avatar to verify avatar propagation onto comments/replies
    await fetch(`${baseUrl}/api/me/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        avatarDataUrl: makeValidWebp(),
        avatarThumbnailDataUrl: makeValidWebp(),
      }),
    });

    // 33e: Comment & Reply images persist, hydrate with author avatars, and unlink on delete
    const mediaTopCommentRes = await fetch(`${baseUrl}/api/posts/${validPost.id}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Top comment with photo',
        images: [makeValidJpeg('comment-top-unique')],
      }),
    });
    const topCommentBody = (await mediaTopCommentRes.json()) as any;
    const topCommentImgFilename = pathMod.basename(topCommentBody.images?.[0] || '');

    const mediaReplyCommentRes = await fetch(`${baseUrl}/api/posts/${validPost.id}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '',
        parentCommentId: topCommentBody.id,
        images: [makeValidPng()],
      }),
    });
    const replyCommentBody = (await mediaReplyCommentRes.json()) as any;

    const hydratedPost = (await (
      await fetch(`${baseUrl}/api/posts/${validPost.id}`, { headers: { Authorization: `Bearer ${peerToken}` } })
    ).json()) as any;
    const hydratedTop = (hydratedPost.comments || []).find((c: any) => c.id === topCommentBody.id);
    const hydratedReply = (hydratedPost.comments || []).find((c: any) => c.id === replyCommentBody.id);

    assert(
      mediaTopCommentRes.status === 201 &&
        mediaReplyCommentRes.status === 201 &&
        Array.isArray(hydratedTop?.images) &&
        hydratedTop.images.length === 1 &&
        Boolean(hydratedTop.avatarUrl) &&
        Array.isArray(hydratedReply?.images) &&
        hydratedReply.images.length === 1 &&
        fsMod.existsSync(pathMod.join(uploadsDir, topCommentImgFilename)),
      'Comment and reply image attachments persist, hydrate with author avatars in post detail, and write to disk'
    );

    // Deleting comment removes attached image file from disk
    const delCommentRes = await fetch(`${baseUrl}/api/comments/${topCommentBody.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${mediaToken}` },
    });
    assert(
      delCommentRes.status === 200 && !fsMod.existsSync(pathMod.join(uploadsDir, topCommentImgFilename)),
      'Deleting a comment cleans up its uploaded image files from disk'
    );

    // =========================================================================
    // 34. SAVED & PINNED LOCATIONS, SEARCH HISTORY, AUTO-PIN & PRIVACY ISOLATION
    // =========================================================================
    console.log('\n--- 34. Testing Saved & Pinned Locations, Search History, Auto-Pinning & Ownership Isolation ---');

    // 34a: Strict authentication guard (explicit unauthenticated/invalid token skips dev fallback)
    const unauthHeaders = { Authorization: 'Bearer unauthenticated-invalid-token' };
    const unauthSavedRes = await fetch(`${baseUrl}/api/locations/saved`, { headers: unauthHeaders });
    const unauthSavePostRes = await fetch(`${baseUrl}/api/locations/saved`, {
      method: 'POST',
      headers: { ...unauthHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unauthorized Spot', coordinates: [7.3025, 5.1342] }),
    });
    const unauthHistRes = await fetch(`${baseUrl}/api/locations/history`, { headers: unauthHeaders });
    assert(
      unauthSavedRes.status === 401 && unauthSavePostRes.status === 401 && unauthHistRes.status === 401,
      'Saved locations and search history endpoints strictly require authentication (401)'
    );

    // 34b: Save a searched location + deduplication (same landmark & same 4-decimal coords)
    const saveSearchRes = await fetch(`${baseUrl}/api/locations/saved`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        landmarkId: 'south-gate',
        name: 'South Gate',
        category: 'gate',
        campusZone: 'South Axis',
        coordinates: [7.2981, 5.1489],
        isOffCampus: false,
        isPinned: false,
        source: 'search',
      }),
    });
    const savedGate = (await saveSearchRes.json()) as any;

    const dedupeRes = await fetch(`${baseUrl}/api/locations/saved`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        landmarkId: 'south-gate',
        name: 'South Gate',
        coordinates: [7.2981, 5.1489],
        notes: 'Meetup spot near shuttle park',
        isPinned: false,
        source: 'landmark',
      }),
    });
    const dedupedGate = (await dedupeRes.json()) as any;
    const overviewAfterDedupe = (await (
      await fetch(`${baseUrl}/api/locations/saved`, {
        headers: { Authorization: `Bearer ${mediaToken}` },
      })
    ).json()) as any;
    assert(
      saveSearchRes.status === 201 &&
        dedupeRes.status === 201 &&
        dedupedGate.id === savedGate.id &&
        dedupedGate.notes === 'Meetup spot near shuttle park' &&
        (overviewAfterDedupe.savedLocations || []).filter((s: any) => s.landmarkId === 'south-gate').length === 1,
      'Saving an already saved/searched landmark deduplicates cleanly and enriches existing entry'
    );

    // 34c: Search history recording, deduplication, query filtering, delete & clear
    const hist1Res = await fetch(`${baseUrl}/api/locations/history`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queryText: 'Apatapiti Junction',
        location: {
          name: 'Apatapiti Junction',
          category: 'off_campus',
          address: 'Apatapiti Road, Outside North Gate',
          coordinates: [7.3112, 5.1308],
          isOffCampus: true,
        },
      }),
    });
    const hist1 = (await hist1Res.json()) as any;
    const hist1RepeatRes = await fetch(`${baseUrl}/api/locations/history`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queryText: 'Apatapiti Junction',
        location: {
          name: 'Apatapiti Junction',
          category: 'off_campus',
          coordinates: [7.3112, 5.1308],
          isOffCampus: true,
        },
      }),
    });
    const hist1Repeat = (await hist1RepeatRes.json()) as any;
    const hist2Res = await fetch(`${baseUrl}/api/locations/history`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryText: 'SEET Auditorium' }),
    });
    const hist2 = (await hist2Res.json()) as any;
    const filteredHist = (await (
      await fetch(`${baseUrl}/api/locations/history?search=Apatapiti`, {
        headers: { Authorization: `Bearer ${mediaToken}` },
      })
    ).json()) as any[];
    const delHistRes = await fetch(`${baseUrl}/api/locations/history/${hist2.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${mediaToken}` },
    });
    assert(
      hist1Res.status === 201 &&
        hist1Repeat.id === hist1.id &&
        hist1Repeat.searchCount >= 2 &&
        filteredHist.length === 1 &&
        filteredHist[0].id === hist1.id &&
        delHistRes.status === 200,
      'Search history records queries/selections, increments count without duplicates, filters cleanly, and supports single-item delete'
    );

    // 34d: Posting & Chatting with an attached location automatically saves & pins it in backend
    const locPostRes = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Study group forming at SOC Lecture Theatre!',
        category: 'general',
        location: {
          id: 'custom-soc-pin',
          name: 'SOC Lecture Theatre 2',
          category: 'academic',
          campusZone: 'Obanla Core',
          coordinates: [7.3026, 5.1349],
          isOffCampus: false,
        },
      }),
    });
    const locChatRes = await fetch(`${baseUrl}/api/chats/${dmBody.chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Meet me outside South Gate Lounge',
        location: {
          id: 'custom-sgl-pin',
          name: 'South Gate Lounge',
          category: 'off_campus',
          coordinates: [7.2918, 5.1495],
          isOffCampus: true,
        },
      }),
    });
    const pinnedOnlyList = (await (
      await fetch(`${baseUrl}/api/locations/saved?filter=pinned`, {
        headers: { Authorization: `Bearer ${mediaToken}` },
      })
    ).json()) as any;
    const pinnedNames = (pinnedOnlyList.savedLocations || []).map((l: any) => l.name);
    assert(
      locPostRes.status === 201 &&
        locChatRes.status === 201 &&
        pinnedNames.includes('SOC Lecture Theatre 2') &&
        pinnedNames.includes('South Gate Lounge'),
      'Attaching a location to a post or chat message automatically saves and pins it in saved_locations'
    );

    // 34e: Rename, edit notes, toggle pin, cross-session persistence, and cross-user isolation
    const socPinRecord = (pinnedOnlyList.savedLocations || []).find((l: any) => l.name === 'SOC Lecture Theatre 2');
    const patchPinRes = await fetch(`${baseUrl}/api/locations/saved/${socPinRecord.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${mediaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customLabel: 'My CSC 301 Hall',
        notes: 'Front row power outlets',
        isPinned: false,
      }),
    });
    const patchedPin = (await patchPinRes.json()) as any;

    // Cross-user isolation: peer must NOT see, edit, or delete mediaUser's saved spot or history
    const peerSavedView = (await (
      await fetch(`${baseUrl}/api/locations/saved`, {
        headers: { Authorization: `Bearer ${peerToken}` },
      })
    ).json()) as any;
    const peerPatchDeny = await fetch(`${baseUrl}/api/locations/saved/${socPinRecord.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customLabel: 'Hijacked Spot' }),
    });
    const peerDeleteDeny = await fetch(`${baseUrl}/api/locations/saved/${socPinRecord.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${peerToken}` },
    });
    const peerHistDelDeny = await fetch(`${baseUrl}/api/locations/history/${hist1.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${peerToken}` },
    });
    assert(
      patchPinRes.status === 200 &&
        patchedPin.customLabel === 'My CSC 301 Hall' &&
        patchedPin.displayName === 'My CSC 301 Hall' &&
        patchedPin.isPinned === false &&
        (peerSavedView.savedLocations || []).length === 0 &&
        peerPatchDeny.status === 404 &&
        peerDeleteDeny.status === 404 &&
        peerHistDelDeny.status === 404,
      'Saved locations support rename/notes/unpin and strictly isolate user ownership (cross-user PATCH/DELETE rejected)'
    );

    // Fresh session check (simulates logout -> login across sessions/devices) + 72h purge preservation
    const freshMediaSession = authService.createSession(mediaUserId, '10.0.0.5', 'SecondDevice');
    deletionService.run72HourExpirySweep();
    const freshDeviceOverview = (await (
      await fetch(`${baseUrl}/api/locations/saved`, {
        headers: { Authorization: `Bearer ${freshMediaSession.token}` },
      })
    ).json()) as any;
    assert(
      (freshDeviceOverview.savedLocations || []).some((l: any) => l.id === socPinRecord.id && l.customLabel === 'My CSC 301 Hall'),
      'Saved locations survive 72h feed sweeps and sync cleanly on a new device session'
    );

    // 34f: Clear search history, remove single saved spot, and permanent account erasure removes all location rows
    const clearHistRes = await fetch(`${baseUrl}/api/locations/history`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${mediaToken}` },
    });
    const deleteSavedRes = await fetch(`${baseUrl}/api/locations/saved/${savedGate.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${mediaToken}` },
    });
    const permEraseRes = await fetch(`${baseUrl}/api/user/delete-account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshMediaSession.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'PERMANENTLY_DELETE', password: 'MediaPassword!2026' }),
    });
    const leftoverSavedCnt = (
      db.prepare('SELECT COUNT(*) as cnt FROM saved_locations WHERE user_id = ?').get(mediaUserId) as any
    )?.cnt;
    const leftoverHistCnt = (
      db.prepare('SELECT COUNT(*) as cnt FROM location_search_history WHERE user_id = ?').get(mediaUserId) as any
    )?.cnt;
    assert(
      clearHistRes.status === 200 &&
        deleteSavedRes.status === 200 &&
        permEraseRes.status === 200 &&
        leftoverSavedCnt === 0 &&
        leftoverHistCnt === 0,
      'History clear, saved location delete, and permanent account erasure purge all user saved_locations and search history rows'
    );

    // =========================================================================
    // 35. STAGE 3B: USERNAME/PASSWORD (ARGON2ID), POW, RECOVERY CODES & LOCKOUT
    // =========================================================================
    console.log('\n--- 35. Testing Stage 3B Auth, Argon2id Rehash, PoW Bot Protection, Recovery Codes & Lockout ---');
    db.prepare("DELETE FROM login_attempts WHERE identifier LIKE 'reg%' OR identifier LIKE 'rec%'").run();
    const s3Uniq = Date.now().toString().slice(-6);
    const s3Handle = `@stage3b_${s3Uniq}`;
    const s3Pass = 'Stage3bHardened!2026';
    const s3IdemKey = `idem-stage3b-${s3Uniq}`;

    // 35a: PoW challenge + Argon2id hash + 10 recovery codes returned ONCE + replay/honeypot/double-submit blocked
    const s3Pow = await fetchSolvedChallenge(baseUrl);
    const s3Reg1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': s3IdemKey },
      body: JSON.stringify({
        username: s3Handle,
        password: s3Pass,
        confirmPassword: s3Pass,
        acceptTerms: true,
        name: 'Stage ThreeB Student',
        ...s3Pow,
      }),
    });
    const s3Reg1Body = (await s3Reg1.json()) as any;

    // Replay same PoW challenge must fail
    const powReplayRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@replay_${s3Uniq}`,
        password: s3Pass,
        confirmPassword: s3Pass,
        acceptTerms: true,
        ...s3Pow,
      }),
    });

    // Honeypot must fail
    const honeypotRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@honeypot_${s3Uniq}`,
        password: s3Pass,
        confirmPassword: s3Pass,
        acceptTerms: true,
        honeypot: 'http://spam-bot.invalid',
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });

    // Duplicate Idempotency-Key must return 409 DUPLICATE_SUBMISSION
    const s3DupSubmit = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': s3IdemKey },
      body: JSON.stringify({
        username: `@other_${s3Uniq}`,
        password: s3Pass,
        confirmPassword: s3Pass,
        acceptTerms: true,
        ...(await fetchSolvedChallenge(baseUrl)),
      }),
    });
    const s3DupBody = (await s3DupSubmit.json()) as any;

    const s3UserDb = db
      .prepare('SELECT id, email, phone_number, verification_code, password_hash, recovery_codes_remaining FROM users WHERE id = ?')
      .get(s3Reg1Body.user?.id) as any;
    const s3RcRows = db
      .prepare('SELECT code_salt, code_hash, used_at, invalidated_at FROM recovery_codes WHERE user_id = ?')
      .all(s3Reg1Body.user?.id) as any[];
    const allCodesUnique =
      Array.isArray(s3Reg1Body.recoveryCodes) &&
      new Set(s3Reg1Body.recoveryCodes).size === 10 &&
      s3Reg1Body.recoveryCodes.every((c: string) => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c));
    const noPlaintextStored =
      s3RcRows.length === 10 &&
      s3RcRows.every(
        (r) =>
          /^[a-f0-9]{32}$/.test(String(r.code_salt || '')) &&
          /^[a-f0-9]{64}$/.test(String(r.code_hash || '')) &&
          !s3Reg1Body.recoveryCodes.includes(r.code_hash)
      );
    assert(
      s3Reg1.status === 201 &&
        allCodesUnique &&
        noPlaintextStored &&
        s3UserDb?.email === null &&
        s3UserDb?.phone_number === null &&
        s3UserDb?.verification_code === null &&
        String(s3UserDb?.password_hash || '').startsWith('$argon2id$v=19$') &&
        s3UserDb?.recovery_codes_remaining === 10 &&
        powReplayRes.status === 400 &&
        honeypotRes.status === 400 &&
        s3DupSubmit.status === 409 &&
        s3DupBody.code === 'DUPLICATE_SUBMISSION',
      'Stage 3B registration enforces PoW/honeypot/idempotency, hashes passwords with Argon2id, and persists 10 salted SHA-256 recovery codes'
    );

    // 35b: Legacy scrypt v3 hash verifies cleanly and transparently rehashes to Argon2id on login
    const legacySalt = crypto.randomBytes(16).toString('hex');
    const legacyScryptHash = `v3:${legacySalt}:${crypto.scryptSync(s3Pass, legacySalt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(legacyScryptHash, s3Reg1Body.user.id);
    const rehashLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: s3Handle, password: s3Pass }),
    });
    const rehashLoginBody = (await rehashLoginRes.json()) as any;
    const upgradedHashRow = db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(s3Reg1Body.user.id) as { password_hash: string };
    const rehashSecEvent = db
      .prepare("SELECT event_type FROM security_events WHERE user_id = ? AND event_type = 'PASSWORD_REHASHED_ARGON2ID' LIMIT 1")
      .get(s3Reg1Body.user.id) as any;
    assert(
      rehashLoginRes.status === 200 &&
        rehashLoginBody.recoveryCodes === undefined &&
        upgradedHashRow.password_hash.startsWith('$argon2id$v=19$') &&
        Boolean(rehashSecEvent),
      'Legacy scrypt v3 password transparently verifies and upgrades to Argon2id on next login'
    );

    // 35c: Recovery codes never exposed via /api/me or /api/auth/recovery-codes/status + Method A reset & zero enumeration
    const meNoRc = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${s3Reg1Body.token}` },
    });
    const meNoRcBody = (await meNoRc.json()) as any;
    const statusRes9 = await fetch(`${baseUrl}/api/auth/recovery-codes/status`, {
      headers: { Authorization: `Bearer ${s3Reg1Body.token}` },
    });
    const statusBody9 = (await statusRes9.json()) as any;

    const unknownRecReset = await fetch(`${baseUrl}/api/auth/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: '@does_not_exist_3b',
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
        newPassword: 'Stage3bResetPass!2026',
        confirmPassword: 'Stage3bResetPass!2026',
      }),
    });
    const unknownRecBody = (await unknownRecReset.json()) as any;
    const wrongCodeReset = await fetch(`${baseUrl}/api/auth/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: s3Handle,
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
        newPassword: 'Stage3bResetPass!2026',
        confirmPassword: 'Stage3bResetPass!2026',
      }),
    });
    const wrongCodeBody = (await wrongCodeReset.json()) as any;

    const s3NewPass = 'Stage3bResetPass!2026';
    const validRecReset = await fetch(`${baseUrl}/api/auth/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: s3Handle,
        recoveryCode: s3Reg1Body.recoveryCodes[0],
        newPassword: s3NewPass,
        confirmPassword: s3NewPass,
      }),
    });
    const oldSessionAfterReset = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${s3Reg1Body.token}` },
    });
    const replayUsedCodeRes = await fetch(`${baseUrl}/api/auth/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: s3Handle,
        recoveryCode: s3Reg1Body.recoveryCodes[0],
        newPassword: 'AnotherResetPass!2026',
        confirmPassword: 'AnotherResetPass!2026',
      }),
    });
    const resetNotif = db
      .prepare("SELECT title FROM notifications WHERE user_id = ? AND title = 'Password Changed via Recovery Code' LIMIT 1")
      .get(s3Reg1Body.user.id) as any;

    assert(
      meNoRc.status === 200 &&
        meNoRcBody.recoveryCodes === undefined &&
        statusRes9.status === 200 &&
        statusBody9.remainingCount === 10 &&
        statusBody9.recoveryCodes === undefined &&
        unknownRecReset.status === 400 &&
        wrongCodeReset.status === 400 &&
        unknownRecBody.error === wrongCodeBody.error &&
        validRecReset.status === 200 &&
        oldSessionAfterReset.status === 401 &&
        replayUsedCodeRes.status === 400 &&
        Boolean(resetNotif),
      'Method A recovery reset prevents user enumeration, burns single-use code, revokes all sessions, and writes in-app notification'
    );

    // 35d: Authenticated recovery code status (9 left) & regeneration (invalidates prior unused codes)
    const s3LoginA = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'DeviceA/1.0' },
      body: JSON.stringify({ username: s3Handle, password: s3NewPass }),
    });
    const s3LoginABody = (await s3LoginA.json()) as any;
    const statusAfterUse = await fetch(`${baseUrl}/api/auth/recovery-codes/status`, {
      headers: { Authorization: `Bearer ${s3LoginABody.token}` },
    });
    const statusAfterUseBody = (await statusAfterUse.json()) as any;

    const badRegenRes = await fetch(`${baseUrl}/api/auth/recovery-codes/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s3LoginABody.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'WrongCurrentPassword!1' }),
    });
    const goodRegenRes = await fetch(`${baseUrl}/api/auth/recovery-codes/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s3LoginABody.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: s3NewPass }),
    });
    const goodRegenBody = (await goodRegenRes.json()) as any;

    const invalidatedOldCodeRes = await fetch(`${baseUrl}/api/auth/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: s3Handle,
        recoveryCode: s3Reg1Body.recoveryCodes[1],
        newPassword: 'ShouldNotWork!2026',
        confirmPassword: 'ShouldNotWork!2026',
      }),
    });
    assert(
      s3LoginA.status === 200 &&
        statusAfterUseBody.remainingCount === 9 &&
        badRegenRes.status === 400 &&
        goodRegenRes.status === 200 &&
        Array.isArray(goodRegenBody.recoveryCodes) &&
        goodRegenBody.recoveryCodes.length === 10 &&
        goodRegenBody.remainingCount === 10 &&
        invalidatedOldCodeRes.status === 400,
      'Recovery code regeneration requires current password, issues 10 new codes once, and invalidates prior unused codes'
    );
    db.prepare("DELETE FROM login_attempts WHERE identifier LIKE 'rec%'").run();

    // 35e: Anti-victim-DoS lockout (attacker IP locked after 5 failures while victim's trusted IP still logs in)
    const victimIp = '198.51.100.42';
    const attackerIp = '203.0.113.77';
    const victimTrustedLogin = authService.login(s3Handle, s3NewPass, victimIp, 'Mozilla/5.0 VictimBrowser');
    assert(Boolean(victimTrustedLogin.token), 'Victim establishes trusted-IP login baseline');

    let attackerLocked = false;
    for (let i = 0; i < 6; i++) {
      try {
        authService.login(s3Handle, 'WrongAttackerPass!1', attackerIp, 'Mozilla/5.0 Attacker');
      } catch (err: any) {
        if (err instanceof AuthRateLimitError || err?.status === 429) {
          attackerLocked = true;
          break;
        }
      }
    }
    const victimAfterAttack = authService.login(s3Handle, s3NewPass, victimIp, 'Mozilla/5.0 VictimBrowser');
    assert(
      attackerLocked && Boolean(victimAfterAttack.token),
      'Per-(account, IP) lockout blocks attacker IP after 5 failures without locking out victim on trusted IP'
    );
    db.prepare('DELETE FROM login_attempts').run();
    db.prepare('DELETE FROM account_lockouts').run();

    // 35f: Self-session revoke + revoke-all (Sign Out Everywhere) + no secrets in security_events
    const s3LoginB = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'DeviceB/1.0' },
      body: JSON.stringify({ username: s3Handle, password: s3NewPass }),
    });
    const s3LoginBBody = (await s3LoginB.json()) as any;

    const revokeSelfRes = await fetch(`${baseUrl}/api/me/sessions/${s3LoginABody.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${s3LoginABody.token}` },
    });
    const revokeSelfBody = (await revokeSelfRes.json()) as any;
    const checkSelfAfterRevoke = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${s3LoginABody.token}` },
    });

    const revokeAllRes = await fetch(`${baseUrl}/api/me/sessions/revoke-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s3LoginBBody.token}` },
    });
    const revokeAllBody = (await revokeAllRes.json()) as any;
    const checkBAfterAll = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${s3LoginBBody.token}` },
    });

    const leakedSecLog = db
      .prepare('SELECT details_json, identifier FROM security_events WHERE user_id = ?')
      .all(s3Reg1Body.user.id)
      .some((r: any) => {
        const blob = `${r.details_json || ''} ${r.identifier || ''}`;
        return (
          blob.includes(s3Pass) ||
          blob.includes(s3NewPass) ||
          s3Reg1Body.recoveryCodes.some((c: string) => blob.includes(c)) ||
          goodRegenBody.recoveryCodes.some((c: string) => blob.includes(c))
        );
      });

    assert(
      revokeSelfRes.status === 200 &&
        revokeSelfBody.revokedSelf === true &&
        checkSelfAfterRevoke.status === 401 &&
        revokeAllRes.status === 200 &&
        revokeAllBody.signedOutEverywhere === true &&
        checkBAfterAll.status === 401 &&
        !leakedSecLog,
      'Self-session revoke & sign-out-everywhere invalidate sessions immediately and security_events never logs secrets/recovery codes'
    );

    // =========================================================================
    // 36. STAGE 3C: PASSKEYS (WEBAUTHN) REGISTRATION, LOGIN, COUNTER & RECOVERY
    // =========================================================================
    console.log('\n--- 36. Testing Stage 3C Passkeys (WebAuthn) Ceremonies, Counter Protection, Re-Auth & Method B Recovery ---');

    const cborBytes = (buf: Buffer): Buffer => {
      if (buf.length < 24) return Buffer.concat([Buffer.from([0x40 | buf.length]), buf]);
      if (buf.length < 256) return Buffer.concat([Buffer.from([0x58, buf.length]), buf]);
      const hdr = Buffer.alloc(3);
      hdr[0] = 0x59;
      hdr.writeUInt16BE(buf.length, 1);
      return Buffer.concat([hdr, buf]);
    };
    const cborText = (str: string): Buffer => {
      const buf = Buffer.from(str, 'utf8');
      return Buffer.concat([Buffer.from([0x60 | buf.length]), buf]);
    };
    const buildCoseP256Key = (pubKey: crypto.KeyObject): Buffer => {
      const jwk = pubKey.export({ format: 'jwk' }) as { x: string; y: string };
      const xBuf = Buffer.from(jwk.x, 'base64url');
      const yBuf = Buffer.from(jwk.y, 'base64url');
      return Buffer.concat([
        Buffer.from([0xa5]), // map(5)
        Buffer.from([0x01, 0x02]), // kty: EC2
        Buffer.from([0x03, 0x26]), // alg: ES256 (-7)
        Buffer.from([0x20, 0x01]), // crv: P-256 (1)
        Buffer.from([0x21]),
        cborBytes(xBuf),
        Buffer.from([0x22]),
        cborBytes(yBuf),
      ]);
    };

    const { getWebAuthnConfig } = await import('../services/passkeyService.js');
    const webAuthnCfg = getWebAuthnConfig();
    const expectedOrigin = webAuthnCfg.allowedOrigins[0] || 'http://localhost:3000';
    const expectedRpId = webAuthnCfg.rpID;

    const createVirtualAuthenticator = () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const credIdBuf = crypto.randomBytes(16);
      const credId = credIdBuf.toString('base64url');
      const cosePubKey = buildCoseP256Key(publicKey);

      const buildRegistration = (
        challenge: string,
        opts: { origin?: string; rpId?: string; counter?: number } = {}
      ) => {
        const origin = opts.origin || expectedOrigin;
        const rpId = opts.rpId || expectedRpId;
        const counter = opts.counter ?? 1;
        const clientDataBuf = Buffer.from(
          JSON.stringify({ type: 'webauthn.create', challenge, origin }),
          'utf8'
        );
        const rpIdHash = crypto.createHash('sha256').update(rpId, 'utf8').digest();
        const flagsAndCounter = Buffer.alloc(5);
        flagsAndCounter[0] = 0x5d; // UP(0x01) + UV(0x04) + BE(0x08) + BS(0x10) + AT(0x40)
        flagsAndCounter.writeUInt32BE(counter, 1);
        const aaguid = Buffer.alloc(16);
        const idLenBuf = Buffer.alloc(2);
        idLenBuf.writeUInt16BE(credIdBuf.length, 0);
        const authData = Buffer.concat([rpIdHash, flagsAndCounter, aaguid, idLenBuf, credIdBuf, cosePubKey]);
        const attestationObject = Buffer.concat([
          Buffer.from([0xa3]),
          cborText('fmt'),
          cborText('none'),
          cborText('attStmt'),
          Buffer.from([0xa0]),
          cborText('authData'),
          cborBytes(authData),
        ]);
        return {
          id: credId,
          rawId: credId,
          type: 'public-key',
          authenticatorAttachment: 'platform',
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataBuf.toString('base64url'),
            attestationObject: attestationObject.toString('base64url'),
            transports: ['internal', 'hybrid'],
          },
        };
      };

      const buildAssertion = (
        challenge: string,
        opts: { origin?: string; rpId?: string; counter?: number; corruptSignature?: boolean } = {}
      ) => {
        const origin = opts.origin || expectedOrigin;
        const rpId = opts.rpId || expectedRpId;
        const counter = opts.counter ?? 2;
        const clientDataBuf = Buffer.from(
          JSON.stringify({ type: 'webauthn.get', challenge, origin }),
          'utf8'
        );
        const rpIdHash = crypto.createHash('sha256').update(rpId, 'utf8').digest();
        const flagsAndCounter = Buffer.alloc(5);
        flagsAndCounter[0] = 0x1d; // UP(0x01) + UV(0x04) + BE(0x08) + BS(0x10)
        flagsAndCounter.writeUInt32BE(counter, 1);
        const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
        const sigBuf = Buffer.from(crypto.sign('sha256', Buffer.concat([rpIdHash, flagsAndCounter, clientDataHash]), privateKey));
        if (opts.corruptSignature) {
          sigBuf[sigBuf.length - 1] ^= 0xff;
        }
        return {
          id: credId,
          rawId: credId,
          type: 'public-key',
          authenticatorAttachment: 'platform',
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientDataBuf.toString('base64url'),
            authenticatorData: Buffer.concat([rpIdHash, flagsAndCounter]).toString('base64url'),
            signature: sigBuf.toString('base64url'),
          },
        };
      };

      return { credId, buildRegistration, buildAssertion };
    };

    const pkLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PasskeyOwner/1.0' },
      body: JSON.stringify({ username: s3Handle, password: s3NewPass }),
    });
    const pkLoginBody = (await pkLoginRes.json()) as any;
    const pkToken = pkLoginBody.token;
    const pkUserId = s3Reg1Body.user.id;

    // 36a: Register two passkeys, verify single-use challenge deletion & replay block
    const auth1 = createVirtualAuthenticator();
    const auth2 = createVirtualAuthenticator();

    const regOpts1Res = await fetch(`${baseUrl}/api/auth/passkeys/register/options`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pkToken}`, 'Content-Type': 'application/json' },
    });
    const regOpts1 = (await regOpts1Res.json()) as any;
    const regPayload1 = auth1.buildRegistration(regOpts1.challenge, { counter: 1 });

    const regVerify1Res = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pkToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Primary MacBook Touch ID', response: regPayload1 }),
    });
    const regVerify1Body = (await regVerify1Res.json()) as any;

    const leftoverRegChallenge = db
      .prepare('SELECT id FROM webauthn_challenges WHERE challenge = ?')
      .get(regOpts1.challenge);
    const replayRegRes = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pkToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Replay Attack', response: regPayload1 }),
    });

    const regOpts2Res = await fetch(`${baseUrl}/api/auth/passkeys/register/options`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pkToken}`, 'Content-Type': 'application/json' },
    });
    const regOpts2 = (await regOpts2Res.json()) as any;
    const regVerify2Res = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pkToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Backup YubiKey', response: auth2.buildRegistration(regOpts2.challenge, { counter: 1 }) }),
    });
    const regVerify2Body = (await regVerify2Res.json()) as any;

    const listPasskeysRes = await fetch(`${baseUrl}/api/auth/passkeys`, {
      headers: { Authorization: `Bearer ${pkToken}` },
    });
    const listPasskeysBody = (await listPasskeysRes.json()) as any;
    const storedCredRow = db
      .prepare('SELECT credential_id, public_key, counter, label FROM webauthn_credentials WHERE id = ?')
      .get(regVerify1Body.passkey?.id ?? '__missing__') as any;

    assert(
      regOpts1Res.status === 200 &&
        regOpts1.rp?.id === expectedRpId &&
        regVerify1Res.status === 201 &&
        regVerify1Body.verified === true &&
        !leftoverRegChallenge &&
        replayRegRes.status === 400 &&
        regVerify2Res.status === 201 &&
        Array.isArray(listPasskeysBody.passkeys) &&
        listPasskeysBody.passkeys.length === 2 &&
        listPasskeysBody.passkeys.every((p: any) => p.publicKey === undefined && p.public_key === undefined) &&
        storedCredRow?.credential_id === auth1.credId &&
        typeof storedCredRow?.public_key === 'string' &&
        storedCredRow?.counter === 1,
      'Stage 3C passkey registration verifies ES256 attestation, deletes single-use challenge, prevents replay, and supports multiple passkeys without exposing public keys'
    );

    // 36b: Reject wrong origin, wrong rpID, and bad signature
    const badOriginOpts = (await (
      await fetch(`${baseUrl}/api/auth/passkeys/register/options`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pkToken}`, 'Content-Type': 'application/json' },
      })
    ).json()) as any;
    const authBadOrigin = createVirtualAuthenticator();
    const badOriginRes = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pkToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Evil Origin Key',
        response: authBadOrigin.buildRegistration(badOriginOpts.challenge, { origin: 'https://evil.example' }),
      }),
    });

    const badRpOpts = (await (
      await fetch(`${baseUrl}/api/auth/passkeys/login/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as any;
    const badRpLoginRes = await fetch(`${baseUrl}/api/auth/passkeys/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: auth1.buildAssertion(badRpOpts.challenge, { rpId: 'evil.example', counter: 2 }),
      }),
    });
    const badSigLoginRes = await fetch(`${baseUrl}/api/auth/passkeys/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: auth1.buildAssertion(badRpOpts.challenge, { counter: 2, corruptSignature: true }),
      }),
    });

    assert(
      badOriginRes.status === 400 && badRpLoginRes.status === 401 && badSigLoginRes.status === 401,
      'WebAuthn rejects mismatched origin, mismatched rpID, and tampered assertion signatures'
    );

    // 36c: Discoverable username-less login creates session + cookies + security log + deletes challenge + enforces 5-device limit + purpose isolation
    const loginOptsRes = await fetch(`${baseUrl}/api/auth/passkeys/login/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const loginOpts = (await loginOptsRes.json()) as any;

    // Purpose isolation: a login challenge cannot be redeemed on the recovery endpoint
    const crossPurposeRes = await fetch(`${baseUrl}/api/auth/passkeys/recovery/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: auth1.buildAssertion(loginOpts.challenge, { counter: 2 }) }),
    });

    const loginAssertion = auth1.buildAssertion(loginOpts.challenge, { counter: 2 });
    const pkSignInRes = await fetch(`${baseUrl}/api/auth/passkeys/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PasskeySafari/17.0' },
      body: JSON.stringify({ response: loginAssertion }),
    });
    const pkSignInBody = (await pkSignInRes.json()) as any;
    const setCookieHeader = pkSignInRes.headers.get('set-cookie') || '';
    const replayLoginRes = await fetch(`${baseUrl}/api/auth/passkeys/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: loginAssertion }),
    });

    const updatedCounterRow = db
      .prepare('SELECT counter, last_used_at FROM webauthn_credentials WHERE id = ?')
      .get(regVerify1Body.passkey.id) as any;
    const pkSessionRow = db
      .prepare('SELECT auth_method FROM sessions WHERE id = ?')
      .get(pkSignInBody.sessionId) as any;
    const pkLoginEvent = db
      .prepare("SELECT details_json FROM security_events WHERE user_id = ? AND event_type = 'LOGIN_SUCCESS' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(pkUserId) as any;

    // Create 5 extra passkey/password sessions to confirm MAX_ACTIVE_DEVICES = 5 still caps total active sessions
    for (let i = 0; i < 5; i++) {
      const extraOpts = (await (
        await fetch(`${baseUrl}/api/auth/passkeys/login/options`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: s3Handle }),
        })
      ).json()) as any;
      await fetch(`${baseUrl}/api/auth/passkeys/login/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': `PasskeyDev-${i}/1.0` },
        body: JSON.stringify({ response: auth1.buildAssertion(extraOpts.challenge, { counter: 3 + i }) }),
      });
    }
    const activeSessionsAfterPk = (
      db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ? AND revoked_at IS NULL').get(pkUserId) as any
    )?.c;

    const ok36c =
      loginOptsRes.status === 200 &&
      !loginOpts.allowCredentials &&
      crossPurposeRes.status === 400 &&
      pkSignInRes.status === 200 &&
      Boolean(pkSignInBody.token) &&
      setCookieHeader.includes('sb_session=') &&
      setCookieHeader.includes('HttpOnly') &&
      setCookieHeader.includes('SameSite=Strict') &&
      replayLoginRes.status === 400 &&
      updatedCounterRow?.counter === 2 &&
      Boolean(updatedCounterRow?.last_used_at) &&
      pkSessionRow?.auth_method === 'passkey' &&
      String(pkLoginEvent?.details_json || '').includes('passkey') &&
      activeSessionsAfterPk === 5;

    if (!ok36c) {
      console.error('36c debug:', {
        loginOptsStatus: loginOptsRes.status,
        hasAllowCreds: Boolean(loginOpts.allowCredentials),
        crossPurposeStatus: crossPurposeRes.status,
        pkSignInStatus: pkSignInRes.status,
        hasToken: Boolean(pkSignInBody.token),
        setCookieHeader,
        replayStatus: replayLoginRes.status,
        updatedCounterRow,
        pkSessionRow,
        pkLoginEvent,
        activeSessionsAfterPk,
      });
    }

    assert(
      ok36c,
      'Discoverable passkey login issues HttpOnly session cookies, blocks cross-purpose & replay attacks, updates counter, logs LOGIN_SUCCESS, and enforces 5-device limit'
    );

    // 36d: Signature counter regression anomaly detection
    const staleOpts = (await (
      await fetch(`${baseUrl}/api/auth/passkeys/login/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: s3Handle }),
      })
    ).json()) as any;
    const staleCounterRes = await fetch(`${baseUrl}/api/auth/passkeys/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: auth1.buildAssertion(staleOpts.challenge, { counter: 4 }) }), // stored counter is 7 (>4)
    });
    const anomalyEvent = db
      .prepare("SELECT event_type FROM security_events WHERE user_id = ? AND event_type = 'PASSKEY_COUNTER_ANOMALY' LIMIT 1")
      .get(pkUserId) as any;
    const anomalyNotif = db
      .prepare("SELECT title FROM notifications WHERE user_id = ? AND title = 'Security Alert: Passkey Sign-In Blocked' LIMIT 1")
      .get(pkUserId) as any;
    assert(
      staleCounterRes.status === 401 && Boolean(anomalyEvent) && Boolean(anomalyNotif),
      'Out-of-order passkey signature counter is rejected (401) and triggers PASSKEY_COUNTER_ANOMALY alert'
    );

    // 36e: Passkey removal requires re-authentication (and cannot delete another user's passkey)
    const freshLoginForDelete = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'DeleteCheck/1.0' },
      body: JSON.stringify({ username: s3Handle, password: s3NewPass }),
    });
    const freshLoginDeleteBody = (await freshLoginForDelete.json()) as any;
    const freshDeleteTok = freshLoginDeleteBody.token;
    db.prepare("UPDATE users SET last_reauthenticated_at = datetime('now', '-2 hours') WHERE id = ?").run(pkUserId);

    const noReauthDeleteRes = await fetch(`${baseUrl}/api/auth/passkeys/${regVerify2Body.passkey.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${freshDeleteTok}` },
    });
    const noReauthDeleteBody = (await noReauthDeleteRes.json()) as any;

    // Cross-user passkey deletion check
    const intruderSession = authService.createSession('u-ayodele', '127.0.0.1', 'Intruder/1.0');
    const crossUserDeleteRes = await fetch(`${baseUrl}/api/auth/passkeys/${regVerify2Body.passkey.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${intruderSession.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'ignored' }),
    });

    // Step-up re-authentication via passkey then delete passkey #2
    const reauthOpts = (await (
      await fetch(`${baseUrl}/api/auth/passkeys/reauth/options`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${freshDeleteTok}`, 'Content-Type': 'application/json' },
      })
    ).json()) as any;
    const reauthVerifyRes = await fetch(`${baseUrl}/api/auth/passkeys/reauth/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshDeleteTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: auth1.buildAssertion(reauthOpts.challenge, { counter: 8 }) }),
    });
    const reauthVerifyBody = (await reauthVerifyRes.json()) as any;
    const afterReauthDeleteRes = await fetch(`${baseUrl}/api/auth/passkeys/${regVerify2Body.passkey.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${freshDeleteTok}` },
    });
    const afterReauthDeleteBody = (await afterReauthDeleteRes.json()) as any;
    const removedEvent = db
      .prepare("SELECT event_type FROM security_events WHERE user_id = ? AND event_type = 'PASSKEY_REMOVED' LIMIT 1")
      .get(pkUserId) as any;

    const ok36e =
      noReauthDeleteRes.status === 403 &&
      noReauthDeleteBody.code === 'REAUTH_REQUIRED' &&
      crossUserDeleteRes.status !== 200 &&
      reauthVerifyRes.status === 200 &&
      afterReauthDeleteRes.status === 200 &&
      Boolean(removedEvent);
    if (!ok36e) {
      console.error('36e debug:', {
        freshLoginStatus: freshLoginForDelete.status,
        freshLoginDeleteBody,
        noReauthStatus: noReauthDeleteRes.status,
        noReauthDeleteBody,
        crossUserStatus: crossUserDeleteRes.status,
        reauthOpts,
        reauthVerifyStatus: reauthVerifyRes.status,
        reauthVerifyBody,
        afterReauthStatus: afterReauthDeleteRes.status,
        afterReauthDeleteBody,
        removedEvent,
      });
    }
    assert(
      ok36e,
      'Removing a passkey blocks stale sessions (403 REAUTH_REQUIRED), isolates cross-user ownership, succeeds after passkey re-auth, and logs PASSKEY_REMOVED'
    );

    // 36f: Method B Password Recovery via Passkey revokes all prior sessions & upgrades password to Argon2id
    const recOptsRes = await fetch(`${baseUrl}/api/auth/passkeys/recovery/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: s3Handle }),
    });
    const recOpts = (await recOptsRes.json()) as any;
    const recVerifyRes = await fetch(`${baseUrl}/api/auth/passkeys/recovery/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: auth1.buildAssertion(recOpts.challenge, { counter: 9 }) }),
    });
    const recVerifyBody = (await recVerifyRes.json()) as any;

    const s3FinalPass = 'Stage3cPasskeyReset!2026';
    const recResetRes = await fetch(`${baseUrl}/api/auth/passkeys/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'RecoveredBrowser/1.0' },
      body: JSON.stringify({
        recoveryToken: recVerifyBody.recoveryToken,
        newPassword: s3FinalPass,
        confirmPassword: s3FinalPass,
      }),
    });
    const recResetBody = (await recResetRes.json()) as any;

    const oldSessionCheck = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${freshDeleteTok}` },
    });
    const newSessionCheck = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${recResetBody.token}` },
    });
    const replayResetTokenRes = await fetch(`${baseUrl}/api/auth/passkeys/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recoveryToken: recVerifyBody.recoveryToken,
        newPassword: 'AnotherPasskeyReset!2026',
        confirmPassword: 'AnotherPasskeyReset!2026',
      }),
    });
    const newPwdLoginCheck = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: s3Handle, password: s3FinalPass }),
    });
    const finalHashRow = db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(pkUserId) as { password_hash: string };

    const ok36f =
      recOptsRes.status === 200 &&
      recVerifyRes.status === 200 &&
      Boolean(recVerifyBody.recoveryToken) &&
      recResetRes.status === 200 &&
      Boolean(recResetBody.token) &&
      oldSessionCheck.status === 401 &&
      newSessionCheck.status === 200 &&
      replayResetTokenRes.status === 400 &&
      newPwdLoginCheck.status === 200 &&
      finalHashRow.password_hash.startsWith('$argon2id$v=19$');
    if (!ok36f) {
      console.error('36f debug:', {
        recOptsStatus: recOptsRes.status,
        recVerifyStatus: recVerifyRes.status,
        recVerifyBody,
        recResetStatus: recResetRes.status,
        recResetBody,
        oldStatus: oldSessionCheck.status,
        newStatus: newSessionCheck.status,
        replayStatus: replayResetTokenRes.status,
        newPwdStatus: newPwdLoginCheck.status,
        hashPrefix: finalHashRow.password_hash?.slice(0, 20),
      });
    }
    assert(
      ok36f,
      'Method B passkey password recovery verifies assertion, consumes single-use reset token, revokes all prior sessions, and accepts new Argon2id password'
    );

    // =========================================================================
    // 37. STAGE 3D: LEGACY ACCOUNTS, SECURITY ACTIVITY FEED & PERMISSION CHECKS
    // =========================================================================
    console.log('\n--- 37. Testing Stage 3D Legacy Account Flow, User Security Activity Feed & Permission Boundaries ---');

    // 37a: Legacy pre-Stage-3B user (v3 scrypt hash, optional legacy email, zero recovery codes yet)
    const legacyId = `u-legacy3d-${Date.now()}`;
    const legacyHandle = `@legacy3d_${String(Date.now()).slice(-4)}`;
    const legacyPass = 'LegacyAccountPass!2026';
    const legacy3dSalt = crypto.randomBytes(16).toString('hex');
    const legacy3dScryptHex = crypto
      .scryptSync(legacyPass, legacy3dSalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
      .toString('hex');
    const legacyV3Hash = `v3:${legacy3dSalt}:${legacy3dScryptHex}`;

    db.prepare(`
      INSERT INTO users (id, matric_number, email, username, password_hash, role, status, is_verified, recovery_codes_generated_at, recovery_codes_remaining)
      VALUES (?, ?, ?, ?, ?, 'student', 'active', 0, NULL, 0)
    `).run(legacyId, 'LEGACY/3D/001', 'legacy-optional@example.com', legacyHandle, legacyV3Hash);
    db.prepare(`
      INSERT INTO user_profiles (id, user_id, name, handle, department, school, level, hall_of_residence, avatar_initials, avatar_bg)
      VALUES (?, ?, 'Legacy User', ?, 'CSC', 'Independent Student Community', '200L', 'Off-Campus', 'LU', '#E8DDCC')
    `).run(`p-${legacyId}`, legacyId, legacyHandle);

    const legacyLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'LegacyDevice/1.0' },
      body: JSON.stringify({ username: legacyHandle, password: legacyPass }),
    });
    const legacyLoginBody = (await legacyLoginRes.json()) as any;
    const legacyToken = legacyLoginBody.token;
    const upgradedLegacyRow = db
      .prepare('SELECT password_hash, email FROM users WHERE id = ?')
      .get(legacyId) as { password_hash: string; email: string | null };

    const legacyRcBeforeRes = await fetch(`${baseUrl}/api/auth/recovery-codes/status`, {
      headers: { Authorization: `Bearer ${legacyToken}` },
    });
    const legacyRcBefore = (await legacyRcBeforeRes.json()) as any;

    // Legacy user adds a passkey
    const legacyAuth = createVirtualAuthenticator();
    const legacyPkOpts = (await (
      await fetch(`${baseUrl}/api/auth/passkeys/register/options`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
      })
    ).json()) as any;
    const legacyPkVerifyRes = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Legacy Phone Passkey',
        response: legacyAuth.buildRegistration(legacyPkOpts.challenge, { counter: 1 }),
      }),
    });

    // Attempting passwordless recovery-code generation without recent reauth fails with 403 REAUTH_REQUIRED
    db.prepare("UPDATE users SET last_reauthenticated_at = datetime('now', '-2 hours') WHERE id = ?").run(legacyId);
    const blockedInitialGenRes = await fetch(`${baseUrl}/api/auth/recovery-codes/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usePasskeyReauth: true }),
    });
    const blockedInitialGenBody = (await blockedInitialGenRes.json()) as any;

    // Step-up passkey reauth then generate initial 10 recovery codes
    const legacyReauthOpts = (await (
      await fetch(`${baseUrl}/api/auth/passkeys/reauth/options`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
      })
    ).json()) as any;
    const legacyReauthRes = await fetch(`${baseUrl}/api/auth/passkeys/reauth/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: legacyAuth.buildAssertion(legacyReauthOpts.challenge, { counter: 2 }) }),
    });
    const initialGenRes = await fetch(`${baseUrl}/api/auth/recovery-codes/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usePasskeyReauth: true }),
    });
    const initialGenBody = (await initialGenRes.json()) as any;

    const legacyRcAfterRes = await fetch(`${baseUrl}/api/auth/recovery-codes/status`, {
      headers: { Authorization: `Bearer ${legacyToken}` },
    });
    const legacyRcAfter = (await legacyRcAfterRes.json()) as any;

    assert(
      legacyLoginRes.status === 200 &&
        upgradedLegacyRow.password_hash.startsWith('$argon2id$v=19$') &&
        upgradedLegacyRow.email === 'legacy-optional@example.com' &&
        legacyRcBeforeRes.status === 200 &&
        legacyRcBefore.needsInitialSetup === true &&
        legacyRcBefore.remainingCount === 0 &&
        legacyRcBefore.generatedAt === null &&
        legacyPkVerifyRes.status === 201 &&
        blockedInitialGenRes.status === 403 &&
        blockedInitialGenBody.code === 'REAUTH_REQUIRED' &&
        legacyReauthRes.status === 200 &&
        initialGenRes.status === 200 &&
        Array.isArray(initialGenBody.recoveryCodes) &&
        initialGenBody.recoveryCodes.length === 10 &&
        legacyRcAfter.needsInitialSetup === false &&
        legacyRcAfter.remainingCount === 10 &&
        Boolean(legacyRcAfter.generatedAt),
      'Legacy account logs in with v3 scrypt, upgrades to Argon2id, reports needsInitialSetup until generating 10 codes (with passkey re-auth), and preserves optional legacy email'
    );

    // 37b: User-scoped security activity endpoint (self-only, zero credential/secret leaks)
    const secEventsRes = await fetch(`${baseUrl}/api/me/security-events?limit=25`, {
      headers: { Authorization: `Bearer ${legacyToken}` },
    });
    const secEventsBody = (await secEventsRes.json()) as any;
    const eventsArr: any[] = Array.isArray(secEventsBody.events) ? secEventsBody.events : [];
    const serializedEvents = JSON.stringify(eventsArr);
    const hasExpectedTypes =
      eventsArr.some((e) => e.eventType === 'LOGIN_SUCCESS') &&
      eventsArr.some((e) => e.eventType === 'PASSKEY_REGISTERED' || e.eventType === 'PASSKEY_ADDED') &&
      eventsArr.some((e) => e.eventType === 'RECOVERY_CODES_REGENERATED');
    const leaksSensitive =
      serializedEvents.includes(legacyPass) ||
      serializedEvents.includes(legacy3dScryptHex) ||
      serializedEvents.includes(legacyToken) ||
      initialGenBody.recoveryCodes.some((c: string) => serializedEvents.includes(c));
    const foreignEventRow = db
      .prepare('SELECT id FROM security_events WHERE user_id != ? LIMIT 1')
      .get(legacyId) as { id: string } | undefined;
    const leakedForeignEvent = Boolean(foreignEventRow && eventsArr.some((e) => e.id === foreignEventRow.id));

    assert(
      secEventsRes.status === 200 &&
        hasExpectedTypes &&
        !leaksSensitive &&
        !leakedForeignEvent,
      'GET /api/me/security-events returns user-scoped sanitized security events with zero credential leaks or cross-user data'
    );

    // 37c: Permission boundaries & unauthenticated rejection
    const unauthEventsRes = await fetch(`${baseUrl}/api/me/security-events`);
    const unauthRcRes = await fetch(`${baseUrl}/api/auth/recovery-codes/status`);
    const studentAdminSecRes = await fetch(`${baseUrl}/api/admin/security/overview`, {
      headers: { Authorization: `Bearer ${legacyToken}` },
    });
    const crossSessionRevokeRes = await fetch(`${baseUrl}/api/me/sessions/${encodeURIComponent(legacyLoginBody.sessionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${intruderSession.token}` },
    });

    assert(
      unauthEventsRes.status === 401 &&
        unauthRcRes.status === 401 &&
        studentAdminSecRes.status === 403 &&
        crossSessionRevokeRes.status === 404,
      'Permission checks enforce 401 for anonymous callers, 403 for student access to admin security routes, and 404 for cross-user session revocation'
    );

    // =========================================================================
    // 38. STAGE 4 AUDIT: AUTHORISATION, STEP-UP RE-AUTH, REALTIME, PII & HARDENING
    // =========================================================================
    console.log('\n--- 38. Stage 4 Audit: Credential Provisioning, Step-Up Re-Auth, Moderator Scope & Response Minimization ---');

    // 38a: Unconfigured fresh privileged accounts reject login until claimed/provisioned once
    const setupBeforeRes = await fetch(`${baseUrl}/api/auth/setup-status`);
    const setupBefore = (await setupBeforeRes.json()) as any;
    assert(
      setupBeforeRes.status === 200 && setupBefore.adminNeedsSetup === true,
      'Fresh unconfigured installation reports adminNeedsSetup=true without seeding hardcoded passwords'
    );

    const unclaimedAdminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '@THEBACKDOOR', password: 'InvalidLegacyAttempt1!' }),
    });
    const unclaimedModLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '@campus_mod', password: 'InvalidLegacyAttempt1!' }),
    });
    assert(
      unclaimedAdminLogin.status === 401 && unclaimedModLogin.status === 401,
      'Unclaimed privileged accounts reject arbitrary password logins (401)'
    );

    const claimedAdminPw = 'Stage4ClaimedAdmin#2026!';
    const firstClaimRes = await fetch(`${baseUrl}/api/auth/setup-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: claimedAdminPw, confirmPassword: claimedAdminPw }),
    });
    const firstClaimBody = (await firstClaimRes.json()) as any;

    const secondClaimRes = await fetch(`${baseUrl}/api/auth/setup-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'AnotherAdminPassword#9!', confirmPassword: 'AnotherAdminPassword#9!' }),
    });
    const setupAfterRes = await fetch(`${baseUrl}/api/auth/setup-status`);
    const setupAfter = (await setupAfterRes.json()) as any;

    assert(
      firstClaimRes.status === 201 &&
        Array.isArray(firstClaimBody.recoveryCodes) &&
        firstClaimBody.recoveryCodes.length === 10 &&
        secondClaimRes.status === 409 &&
        setupAfter.adminNeedsSetup === false,
      'First-run @THEBACKDOOR claim succeeds once with 10 recovery codes, then permanently locks (409)'
    );

    // 38b: Raw session tokens in query params (?token=) no longer authenticate SSE stream; signed ?ticket= does
    const sseAnonController = new AbortController();
    const sseRawTokenRes = await fetch(
      `${baseUrl}/api/realtime/stream?token=${encodeURIComponent(adminToken)}&clientId=stage4-raw-token`,
      { signal: sseAnonController.signal }
    );
    const readerRaw = sseRawTokenRes.body!.getReader();
    const firstChunkRaw = new TextDecoder().decode((await readerRaw.read()).value || new Uint8Array());
    sseAnonController.abort();

    const ticketRes = await fetch(`${baseUrl}/api/realtime/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const ticketBody = (await ticketRes.json()) as any;
    const sseTicketController = new AbortController();
    const sseTicketRes = await fetch(
      `${baseUrl}/api/realtime/stream?ticket=${encodeURIComponent(ticketBody.ticket)}&clientId=stage4-ticket`,
      { signal: sseTicketController.signal }
    );
    const readerTicket = sseTicketRes.body!.getReader();
    const firstChunkTicket = new TextDecoder().decode((await readerTicket.read()).value || new Uint8Array());
    sseTicketController.abort();

    assert(
      sseRawTokenRes.status === 200 &&
        !firstChunkRaw.includes(adminRow.id) &&
        ticketRes.status === 200 &&
        Boolean(ticketBody.ticket) &&
        firstChunkTicket.includes(adminRow.id),
      'SSE rejects ?token= query-string authentication (subscribes as anonymous) and accepts short-lived ?ticket='
    );

    // 38c: Step-up re-authentication required on sensitive Admin endpoints & Admin delete audit logging
    db.prepare("UPDATE users SET last_reauthenticated_at = datetime('now', '-30 minutes') WHERE id = ?").run(adminRow.id);
    const freshAdminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '@THEBACKDOOR', password: claimedAdminPw }),
    });
    const freshAdminBody = (await freshAdminLogin.json()) as any;
    const claimedAdminToken = freshAdminBody.token as string;
    // Simulate stale re-auth timestamp after login window expires
    db.prepare("UPDATE users SET last_reauthenticated_at = datetime('now', '-30 minutes') WHERE id = ?").run(adminRow.id);

    const staleSettingsRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campus_zone: 'Should Require Reauth' }),
    });
    const staleSettingsBody = (await staleSettingsRes.json()) as any;

    const staleRoleRes = await fetch(`${baseUrl}/api/admin/staff/role`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: studentUser.id, role: 'staff' }),
    });
    const staleRevokeSessionsRes = await fetch(`${baseUrl}/api/admin/security/sessions/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const stepUpRes = await fetch(`${baseUrl}/api/auth/reauthenticate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: claimedAdminPw }),
    });
    const allowedSettingsRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_tagline: 'Verified Stage 4 Settings Update' }),
    });

    const auditPost = postService.createPost(studentUser.id, { content: 'Post to test Admin delete audit logging' })!;
    const adminDeletePostRes = await fetch(`${baseUrl}/api/admin/posts/${auditPost.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${claimedAdminToken}` },
    });
    const deleteAuditRow = db
      .prepare("SELECT * FROM admin_audit_logs WHERE action = 'ADMIN_DELETE_POST' AND target_id = ?")
      .get(auditPost.id) as any;

    assert(
      staleSettingsRes.status === 403 &&
        staleSettingsBody.code === 'REAUTH_REQUIRED' &&
        staleRoleRes.status === 403 &&
        staleRevokeSessionsRes.status === 403 &&
        stepUpRes.status === 200 &&
        allowedSettingsRes.status === 200 &&
        adminDeletePostRes.status === 200 &&
        Boolean(deleteAuditRow),
      'Sensitive Admin endpoints enforce step-up re-auth (403 REAUTH_REQUIRED -> 200 after re-auth) and log ADMIN_DELETE_POST'
    );

    // 38d: Moderator RBAC hardening: permission-gated poll reports, anonymous masking, peer-mod protection, invalid type validation
    const scopedModRes = await fetch(`${baseUrl}/api/admin/moderators`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@mod_s4_${Date.now().toString().slice(-4)}`,
        password: 'ModStrongPassword4!',
        name: 'Scoped Mod',
        permissions: {
          canReviewReports: false,
          canHideContent: true,
          canWarnUsers: false,
          canRestrictUsers: false,
          maxRestrictionHours: 12,
          canReviewCommunities: false,
          canEscalate: false,
        },
      }),
    });
    const scopedModBody = (await scopedModRes.json()) as any;
    const scopedModSession = authService.createSession(scopedModBody.id, '127.0.0.1', 'ModBrowser').token;

    const modPollDeniedReports = await fetch(`${baseUrl}/api/realtime/poll?clientId=mod-no-reports`, {
      headers: { Authorization: `Bearer ${scopedModSession}` },
    });
    const modPollBody = (await modPollDeniedReports.json()) as any;

    const peerModRes = await fetch(`${baseUrl}/api/admin/moderators`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `@mod_peer_${Date.now().toString().slice(-4)}`,
        password: 'ModStrongPassword4!',
        name: 'Peer Mod',
        permissions: { canReviewReports: true },
      }),
    });
    const peerModBody = (await peerModRes.json()) as any;
    const peerModPost = postService.createPost(peerModBody.id, { content: 'Moderator safety notice' })!;

    const modCrossTargetRes = await fetch(`${baseUrl}/api/mod/content/post/${peerModPost.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${scopedModSession}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hide', reason: 'Attempt to hide peer moderator post' }),
    });
    const modInvalidTypeRes = await fetch(`${baseUrl}/api/mod/content/users/${peerModPost.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${scopedModSession}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hide', reason: 'Invalid content type test' }),
    });

    // Anonymous post author identity stays masked in moderator report queue
    const anonPost = postService.createPost(studentUser.id, {
      content: 'Anonymous campus confession for moderator report check',
      is_anonymous: true,
    })!;
    const anonReportRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'post',
        targetId: anonPost.id,
        reason: 'Needs moderator review while preserving anonymity',
      }),
    });
    const peerModToken = authService.createSession(peerModBody.id, '127.0.0.1', 'PeerMod').token;
    const modReportsQueueRes = await fetch(`${baseUrl}/api/mod/reports`, {
      headers: { Authorization: `Bearer ${peerModToken}` },
    });
    const modReportsQueue = (await modReportsQueueRes.json()) as any[];
    const anonReportEntry = modReportsQueue.find((r) => r.target_id === anonPost.id);

    assert(
      scopedModRes.status === 201 &&
        modPollDeniedReports.status === 200 &&
        modPollBody.adminReports === undefined &&
        modCrossTargetRes.status === 403 &&
        modInvalidTypeRes.status === 400 &&
        anonReportRes.status === 201 &&
        Boolean(anonReportEntry) &&
        anonReportEntry.authorHandle === '@anonymous' &&
        anonReportEntry.targetUserId === null,
      'Moderator controls enforce canReviewReports in /realtime/poll, block peer-mod tampering (403), validate type (400), and mask anonymous authors'
    );

    // 38e: Hidden post media protection, suspend duration bounds, and PII removal across profile & admin APIs
    const hiddenUploadName = `hidden-test-${Date.now()}.png`;
    fs.writeFileSync(path.join(getUploadsDir(), hiddenUploadName), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const hiddenMediaPost = postService.createPost(studentUser.id, {
      content: 'Post with image that gets hidden',
      images: [`/api/uploads/${hiddenUploadName}`],
    })!;
    db.prepare('UPDATE posts SET is_hidden = 1 WHERE id = ?').run(hiddenMediaPost.id);
    const hiddenMediaFetch = await fetch(`${baseUrl}/api/uploads/${hiddenUploadName}`);

    const badSuspendRes = await fetch(`${baseUrl}/api/admin/users/${studentUser.id}/suspend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claimedAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationDays: -5, reason: 'Invalid negative days' }),
    });

    const [meRes, pubProfRes, admUsersRes, admModsRes, admStaffRes, admAppealsRes] = await Promise.all([
      fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${studentToken}` } }),
      fetch(`${baseUrl}/api/users/${studentUser.id}/profile`),
      fetch(`${baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${claimedAdminToken}` } }),
      fetch(`${baseUrl}/api/admin/moderators`, { headers: { Authorization: `Bearer ${claimedAdminToken}` } }),
      fetch(`${baseUrl}/api/admin/staff`, { headers: { Authorization: `Bearer ${claimedAdminToken}` } }),
      fetch(`${baseUrl}/api/admin/appeals`, { headers: { Authorization: `Bearer ${claimedAdminToken}` } }),
    ]);
    const serializedPiiCheck = JSON.stringify({
      me: await meRes.json(),
      pubProf: await pubProfRes.json(),
      admUsers: await admUsersRes.json(),
      admMods: await admModsRes.json(),
      admStaff: await admStaffRes.json(),
      admAppeals: await admAppealsRes.json(),
    });

    assert(
      hiddenMediaFetch.status === 404 &&
        badSuspendRes.status === 400 &&
        !serializedPiiCheck.includes('"email"') &&
        !serializedPiiCheck.includes('"phoneNumber"') &&
        !serializedPiiCheck.includes('"password_hash"') &&
        !serializedPiiCheck.includes('"mfa_secret"') &&
        !serializedPiiCheck.includes('"recovery_codes"'),
      'Hidden post media returns 404, suspend validates duration bounds (400), and API responses omit email/phone/credential secrets'
    );
  } finally {
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  }

  // Cleanup presence test rows and temp DB
  presenceService.removeClientPresence('u-ayodele');
  checkpointDatabase();
  cleanupTempDir();

  console.log('\n======================================================');
  console.log('🎉 ALL BACKEND & DATABASE TESTS (STAGES 1-10 + SINGLE ADMIN + STORAGE OPT + 100% FREE ACCESS + PERFORMANCE & CACHING) PASSED WITH 100% SUCCESS!');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test suite encountered an error:', err);
  cleanupTempDir();
  process.exit(1);
});




/**
 * Automated end-to-end test suite for Schoolbackdoor @username mention & tagging system
 * Covers parsing, autocomplete scoping, multi-mentions, privacy/anonymity,
 * notification preferences, deduplication, and edit/delete lifecycles.
 * Runs with `npx tsx server/test/mentions.test.ts`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolbackdoor-mentions-test-'));
process.env.SCHOOLBACKDOOR_DB_PATH = path.join(TMP_DIR, 'mentions.db');
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
  }
  console.log(`✅ PASSED: ${message}`);
}

async function runMentionTests() {
  const { initDatabase, db } = await import('../db/database');
  const { seedInitialData, hashPassword } = await import('../db/seed');
  const { extractMentionHandles } = await import('../utils/mentions');
  const { mentionService } = await import('../services/mentionService');
  const { userService } = await import('../services/userService');
  const { postService } = await import('../services/postService');
  const { commentReactionService } = await import('../services/commentReactionService');
  const { chatService } = await import('../services/chatService');
  const { communityService } = await import('../services/communityService');
  const { blockService } = await import('../services/blockService');
  const { notificationService } = await import('../services/notificationService');

  console.log('\n======================================================');
  console.log('🏷️  SCHOOLBACKDOOR MENTIONS & TAGGING TEST SUITE');
  console.log('======================================================\n');

  initDatabase();
  seedInitialData();

  // Create extra test users (User D, Suspended User E, Opted-out User F)
  const mkStudent = (id: string, handle: string, name: string, status: 'active' | 'suspended' = 'active') => {
    db.prepare(`
      INSERT INTO users (id, matric_number, username, email, password_hash, role, status)
      VALUES (?, ?, ?, ?, ?, 'student', ?)
    `).run(id, `CSC/22/${id}`, handle, `${id}@gmail.com`, hashPassword('Secret123!'), status);

    db.prepare(`
      INSERT INTO user_profiles (id, user_id, name, handle, department, school, level, hall_of_residence, avatar_initials, avatar_bg)
      VALUES (?, ?, ?, ?, 'Computer Science', 'SOC', '300L', 'Akindeko', 'TS', 'bg-stone-700 text-white')
    `).run(`p-${id}`, id, name, handle);
  };

  mkStudent('u-tobi', '@tobi_dev', 'Tobi Adeyemi', 'active');
  mkStudent('u-susp-mention', '@suspended_guy', 'Suspended User', 'suspended');
  mkStudent('u-quiet', '@quiet_scholar', 'Quiet Scholar', 'active');

  // --- 1. Strict Token Parsing & False-Mention Rejection ---
  console.log('--- 1. Testing Regex Boundaries & Email Rejection ---');
  const parsed = extractMentionHandles(
    'Reach me at student@gmail.com or @gmail.com or foo@ayodele_ao. Valid tags: @ayodele_ao, (@kemi_b), @dami_soc. End @tobi_dev! Dupes @kemi_b @KEMI_B @anonymous'
  );
  assert(
    parsed.length === 4 &&
      parsed[0] === '@ayodele_ao' &&
      parsed[1] === '@kemi_b' &&
      parsed[2] === '@dami_soc' &&
      parsed[3] === '@tobi_dev',
    'Rejected emails (student@gmail.com, @gmail.com) and mid-word @, excluded @anonymous, deduplicated case-insensitively, kept punctuation-bounded @handles'
  );

  // --- 2. Autocomplete Scoping & Security ---
  console.log('\n--- 2. Testing Context-Aware Autocomplete Candidates ---');
  // Seed DM chat between Ayodele & Kemi
  const dm = chatService.createDirectChat('u-ayodele', 'u-kemi');
  const dmCandidates = mentionService.getCandidates({
    viewerId: 'u-ayodele',
    query: '',
    chatId: dm.chatId,
  });
  assert(
    dmCandidates.length === 1 && dmCandidates[0].userId === 'u-kemi',
    'DM autocomplete returns strictly the DM partner (Kemi) and excludes self/others'
  );

  // Create private community with Ayodele & Tobi (not Dami)
  const privComm = communityService.createCommunity('u-ayodele', {
    name: 'Private Research Circle',
    acronym: `PRIV${Date.now().toString().slice(-4)}`,
    category: 'tech',
    description: 'Invite-only research discussions',
    location: 'Obanla Campus',
    settings: { isPrivate: true },
  });
  if (!privComm) throw new Error('Failed to create private community');
  communityService.toggleMembership(privComm.id, 'u-tobi');

  const privCandidates = mentionService.getCandidates({
    viewerId: 'u-ayodele',
    query: '',
    communityId: privComm.id,
  });
  assert(
    privCandidates.some((c) => c.userId === 'u-tobi') &&
      !privCandidates.some((c) => c.userId === 'u-dami'),
    'Private community autocomplete restricts candidates strictly to community members'
  );

  // Linked group chat only suggests group participants
  const groupCandidates = mentionService.getCandidates({
    viewerId: 'u-ayodele',
    query: '',
    chatId: privComm.chatId,
  });
  assert(
    groupCandidates.length === 1 && groupCandidates[0].userId === 'u-tobi',
    'Group chat autocomplete restricts candidates strictly to group participants'
  );

  // Suspended users never show up in global autocomplete
  const globalSuspSearch = mentionService.getCandidates({
    viewerId: 'u-ayodele',
    query: 'suspended',
  });
  assert(globalSuspSearch.length === 0, 'Suspended users never appear in mention autocomplete');

  // --- 3. Multi-Mention Post, Nonexistent/Suspended Filtering & Duplicate Prevention ---
  console.log('\n--- 3. Testing Post Multi-Mentions, Verification & Dedup ---');
  // Clear prior notifications for clean counts
  db.prepare('DELETE FROM notifications').run();

  const createdPost = postService.createPost('u-ayodele', {
    content:
      'Big shoutout to @kemi_b @KEMI_B and @tobi_dev! Email support@gmail.com or ask @nonexistent_user and @suspended_guy.',
    school_tag: 'SOC',
  });
  if (!createdPost) throw new Error('Failed to create post');

  const syncRes = mentionService.syncMentionsOnContent({
    text: createdPost.content,
    sourceType: 'post',
    sourceId: createdPost.id,
    actorId: 'u-ayodele',
    targetLink: `/home?post=${createdPost.id}`,
    contextTitle: 'Campus Commons dispatch',
  });

  assert(
    syncRes.mentions.length === 2 &&
      syncRes.mentions.some((m) => m.userId === 'u-kemi') &&
      syncRes.mentions.some((m) => m.userId === 'u-tobi'),
    'Post resolved only existing active mentions (@kemi_b, @tobi_dev) and ignored nonexistent/suspended/email tokens'
  );
  assert(
    !syncRes.mentions.some((m) => m.handle.toLowerCase() === '@suspended_guy'),
    'Suspended user not linkified as mention'
  );

  const kemiPostNotifs = notificationService
    .getUserNotifications('u-kemi')
    .filter((n) => n.sourceRef === `post:${createdPost.id}:u-kemi`);
  assert(kemiPostNotifs.length === 1 && kemiPostNotifs[0].type === 'mention', 'Repeated @kemi_b @KEMI produced exactly 1 mention notification');

  // Hydrated post includes resolved mentions
  const fetchedPost = postService.getPostById(createdPost.id, 'u-tobi');
  assert(
    fetchedPost !== null &&
      Array.isArray(fetchedPost.mentions) &&
      fetchedPost.mentions.length === 2 &&
      fetchedPost.isEdited === false,
    'getPostById hydrates verified mentions array and sets isEdited=false'
  );

  // --- 4. Post Editing (No Duplicate Notifications + Stale Cleanup + New Notification) ---
  console.log('\n--- 4. Testing Post Edit Mention Diffing ---');
  // Edit 1: Add text without changing mentions -> 0 new notifications for Kemi/Tobi
  const editedPost1 = postService.editPost(createdPost.id, 'u-ayodele', 'student', {
    content: 'Big shoutout to @kemi_b and @tobi_dev! Updated room details: ETF 3.',
  });
  if (!editedPost1) throw new Error('Edited post 1 was null');
  assert(editedPost1.isEdited === true, 'Post edit marks isEdited=true');
  const kemiNotifsAfterEdit1 = notificationService
    .getUserNotifications('u-kemi')
    .filter((n) => n.sourceRef === `post:${createdPost.id}:u-kemi`);
  assert(kemiNotifsAfterEdit1.length === 1, 'Editing post without adding handles causes zero duplicate notifications');

  // Edit 2: Remove @kemi_b and add @dami_soc -> Kemi stale notification deleted, Dami notified
  const editedPost2 = postService.editPost(createdPost.id, 'u-ayodele', 'student', {
    content: 'Updated crew: @tobi_dev and @dami_soc at ETF 3.',
  });
  if (!editedPost2) throw new Error('Edited post 2 was null');
  assert(
    editedPost2.mentions?.length === 2 &&
      editedPost2.mentions.some((m) => m.userId === 'u-dami') &&
      !editedPost2.mentions.some((m) => m.userId === 'u-kemi'),
    'Edited post updates hydrated mentions to match new content'
  );
  const kemiNotifsAfterRemoval = db
    .prepare('SELECT 1 FROM notifications WHERE source_ref = ?')
    .get(`post:${createdPost.id}:u-kemi`);
  assert(kemiNotifsAfterRemoval === undefined, 'Removed @kemi_b notification cleaned up on post edit');
  const damiNotifsAfterAdd = notificationService
    .getUserNotifications('u-dami')
    .filter((n) => n.sourceRef === `post:${createdPost.id}:u-dami`);
  assert(damiNotifsAfterAdd.length === 1, 'Newly added @dami_soc received mention notification on edit');

  // Unauthorized edit blocked
  let unauthorizedPostEdit = false;
  try {
    postService.editPost(createdPost.id, 'u-kemi', 'student', { content: 'Tamper attempt' });
  } catch (err: any) {
    unauthorizedPostEdit = err.message.includes('Only the author');
  }
  assert(unauthorizedPostEdit, 'Non-author blocked from editing another user post');

  // --- 5. Comments & Replies Deduplication & Cascade Delete ---
  console.log('\n--- 5. Testing Comment & Reply Mentions + No Double Notifications ---');
  db.prepare('DELETE FROM notifications').run();

  // Tobi comments on Ayodele's post while explicitly mentioning @ayodele_ao and @kemi_b
  const commentWithAuthorMention = commentReactionService.addComment(
    createdPost.id,
    'u-tobi',
    'Hey @ayodele_ao and @kemi_b, see you at ETF!'
  );
  assert(
    commentWithAuthorMention.mentions?.length === 2,
    'Comment resolves both @ayodele_ao and @kemi_b'
  );

  // Ayodele should receive ONE notification (mention), NOT both 'comment' and 'mention'
  const ayodeleCommentNotifs = notificationService.getUserNotifications('u-ayodele');
  assert(
    ayodeleCommentNotifs.length === 1 && ayodeleCommentNotifs[0].type === 'mention',
    'Commenting on post author while @mentioning them sends single mention notification (no double notification)'
  );

  // Dami replies to Tobi's comment and mentions @tobi_dev -> Tobi gets 1 'mention', not 'reply' + 'mention'
  db.prepare('DELETE FROM notifications').run();
  const reply = commentReactionService.addComment(
    createdPost.id,
    'u-dami',
    '@tobi_dev agreed! Count me in.',
    commentWithAuthorMention.id
  );
  const tobiReplyNotifs = notificationService.getUserNotifications('u-tobi');
  assert(
    tobiReplyNotifs.length === 1 && tobiReplyNotifs[0].type === 'mention' && reply.mentions?.length === 1,
    'Replying to parent comment author while @mentioning them sends single mention notification'
  );

  // Edit reply to mention @kemi_b too
  const editedReply = commentReactionService.editComment(reply.id, 'u-dami', '@tobi_dev @kemi_b count us all in!');
  assert(editedReply.isEdited === true && editedReply.mentions?.length === 2, 'Edited reply hydrates updated mentions and isEdited=true');

  // Delete comment deletes comment + reply + their source_ref mention notifications
  commentReactionService.deleteComment(commentWithAuthorMention.id, 'u-tobi', 'student');
  const orphanedReplyNotif = db
    .prepare('SELECT 1 FROM notifications WHERE source_ref LIKE ?')
    .get(`comment:${reply.id}:%`);
  assert(orphanedReplyNotif === undefined, 'Deleting parent comment cascades cleanup of child reply notifications');

  // --- 6. Direct & Group Chat Mentions ---
  console.log('\n--- 6. Testing DM & Group Chat Mentions, Edit & Delete ---');
  db.prepare('DELETE FROM notifications').run();

  // Ayodele sends DM to Kemi mentioning @kemi_b AND outsider @dami_soc
  const dmMsg = chatService.sendMessage(dm.chatId, 'u-ayodele', {
    text: 'Hey @kemi_b, ignore outsider @dami_soc in this DM.',
  });
  assert(
    dmMsg.mentions?.length === 1 && dmMsg.mentions[0].userId === 'u-kemi',
    'DM message links participant @kemi_b and ignores non-participant @dami_soc'
  );

  // Kemi should get ONE 'mention' notification (not both 'message' and 'mention'), Dami gets 0
  const kemiDmNotifs = notificationService.getUserNotifications('u-kemi');
  const damiDmNotifs = notificationService.getUserNotifications('u-dami');
  assert(
    kemiDmNotifs.length === 1 && kemiDmNotifs[0].type === 'mention' && damiDmNotifs.length === 0,
    'DM upgrades recipient notification from message to mention cleanly without notifying outsider'
  );

  // Edit DM message
  const editedDm = chatService.editMessage(dm.chatId, dmMsg.id, 'u-ayodele', 'Hey @kemi_b, updated meeting time to 4 PM.');
  assert(editedDm.isEdited === true && editedDm.text.includes('4 PM'), 'Chat message edit updates text and sets isEdited=true');

  // Delete DM message cleans up notification
  chatService.deleteMessage(dm.chatId, dmMsg.id, 'u-ayodele', 'student');
  const staleMsgNotif = db
    .prepare('SELECT 1 FROM notifications WHERE source_ref LIKE ?')
    .get(`msg:${dmMsg.id}:%`);
  assert(staleMsgNotif === undefined, 'Deleting chat message cleans up its source_ref notifications');

  // --- 7. Anonymous Post Privacy, Notification Preferences & Blocking ---
  console.log('\n--- 7. Testing Anonymous Masking, Preferences Opt-Out & Blocks ---');
  db.prepare('DELETE FROM notifications').run();

  // Disable mention notifications for u-quiet
  userService.updateProfile('u-quiet', { notify_mentions: false });
  const quietProfile = userService.getProfileByUserId('u-quiet', 'u-quiet');
  assert(quietProfile?.notifyMentions === false, 'Persisted notify_mentions=false preference');

  // Create anonymous post mentioning @quiet_scholar and @kemi_b
  const anonPost = postService.createPost('u-ayodele', {
    content: 'Anonymous appreciation for @quiet_scholar and @kemi_b!',
    is_anonymous: true,
  });
  if (!anonPost) throw new Error('Failed to create anonymous post');

  mentionService.syncMentionsOnContent({
    text: anonPost.content,
    sourceType: 'post',
    sourceId: anonPost.id,
    actorId: 'u-ayodele',
    targetLink: `/home?post=${anonPost.id}`,
    contextTitle: 'Campus Commons dispatch',
    isAnonymous: true,
  });

  const quietNotifs = notificationService.getUserNotifications('u-quiet');
  const kemiAnonNotifs = notificationService.getUserNotifications('u-kemi');
  assert(quietNotifs.length === 0, 'User with notify_mentions=false receives zero mention notifications');
  assert(
    kemiAnonNotifs.length === 1 &&
      kemiAnonNotifs[0].body.includes('Someone (Anonymous)') &&
      !kemiAnonNotifs[0].body.includes('Ayodele'),
    'Anonymous post mention notification hides poster real name'
  );

  // Hydrated post still has clickable mentions even for @quiet_scholar
  const hydratedAnon = postService.getPostById(anonPost.id, 'u-tobi');
  assert(hydratedAnon?.mentions?.length === 2, 'Opted-out users still get clickable @username profile link');

  // Blocking hides mutual mentions from feed & prevents notifications
  blockService.blockUser('u-kemi', 'u-tobi');
  const anonForKemiAfterBlock = postService.getPostById(anonPost.id, 'u-kemi');
  const postWithBlockedMention = postService.createPost('u-tobi', {
    content: 'Tagging @kemi_b while blocked',
  });
  const blockedSync = mentionService.syncMentionsOnContent({
    text: postWithBlockedMention!.content,
    sourceType: 'post',
    sourceId: postWithBlockedMention!.id,
    actorId: 'u-tobi',
    targetLink: `/home?post=${postWithBlockedMention!.id}`,
    contextTitle: 'Campus Commons dispatch',
  });
  assert(
    blockedSync.mentions.length === 0 && blockedSync.notifiedUserIds.length === 0,
    'Blocked user cannot mention or notify blocker'
  );
  assert(anonForKemiAfterBlock !== null, 'Viewer profile check succeeded after block');

  blockService.unblockUser('u-kemi', 'u-tobi');

  // Deleting post cleans up all post notifications
  postService.deletePost(anonPost.id, 'u-ayodele', 'student');
  const staleAnonPostNotif = db
    .prepare('SELECT 1 FROM notifications WHERE source_ref LIKE ?')
    .get(`post:${anonPost.id}:%`);
  assert(staleAnonPostNotif === undefined, 'Deleting post removes all source_ref mention notifications');

  console.log('\n======================================================');
  console.log('🎉 ALL MENTION & TAGGING SYSTEM TESTS PASSED!');
  console.log('======================================================\n');

  cleanupTempDir();
}

runMentionTests().catch((err) => {
  console.error('❌ Mention test suite crashed:', err);
  cleanupTempDir();
  process.exit(1);
});

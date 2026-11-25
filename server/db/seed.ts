import { db, runInTransaction, syncTheBackdoorAdminIdentity, syncDefaultModeratorAccount } from './database.js';
import crypto from 'node:crypto';
import { hashPassword } from '../utils/security.js';

export { hashPassword };

export function seedInitialData() {
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (existingUsers && existingUsers.count > 0) {
    syncTheBackdoorAdminIdentity();
    syncDefaultModeratorAccount();
    return; // Already seeded
  }

  runInTransaction(() => {
    // 1. Seed Users (students/staff use dev sample hash; Admin uses ADMIN_PASSWORD env secret or ephemeral lock hash)
    const defaultStudentPassword = hashPassword(crypto.randomBytes(16).toString('hex'));
    const configuredAdminSecret = (
      process.env.ADMIN_PASSWORD ||
      process.env.SCHOOLBACKDOOR_ADMIN_PASSWORD ||
      ''
    ).trim();
    const adminPasswordHash = configuredAdminSecret
      ? hashPassword(configuredAdminSecret)
      : hashPassword(crypto.randomBytes(32).toString('hex'));

    const insertUser = db.prepare(`
      INSERT INTO users (id, matric_number, email, username, password_hash, role, status, is_verified)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 0)
    `);

    insertUser.run('u-ayodele', 'CSC/20/8901', '@ayodele_ao', defaultStudentPassword, 'student', 'active');
    insertUser.run('u-kemi', 'CYS/21/3042', '@kemi_b', defaultStudentPassword, 'student', 'active');
    insertUser.run('u-dami', 'SWE/21/5012', '@dami_soc', defaultStudentPassword, 'student', 'active');
    insertUser.run('u-chronicle', 'STAFF/SUG/004', '@futachronicle', defaultStudentPassword, 'staff', 'active');
    insertUser.run('u-admin', 'ADMIN/001', '@THEBACKDOOR', adminPasswordHash, 'admin', 'active');

    // 2. Seed User Profiles
    const insertProfile = db.prepare(`
      INSERT INTO user_profiles (
        id, user_id, name, handle, department, school, level, hall_of_residence, campus,
        bio, avatar_initials, avatar_bg, verified, badges_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProfile.run(
      'p-ayodele',
      'u-ayodele',
      'Ayodele Balogun',
      '@ayodele_ao',
      'Computer Science',
      'School of Computing (SOC)',
      '400L',
      'Titans Hostel (South Gate)',
      'Obanla',
      'Final year CS student interested in distributed systems, offline-first networks, and campus tech infrastructure. General Secretary, NACOS FUTA Chapter.',
      'AO',
      'bg-stone-900 text-stone-100',
      1,
      JSON.stringify(['NACOS Exec', 'Verified FUTA Student', 'Open Source Contributor'])
    );

    insertProfile.run(
      'p-kemi',
      'u-kemi',
      'Kemi Balogun',
      '@kemi_b',
      'Cyber Security',
      'School of Computing (SOC)',
      '300L',
      'Jibowu Hall of Residence',
      'Obanla',
      'Network defense researcher & CTF player. Always hunting for quiet study rooms in SEET.',
      'KB',
      'bg-stone-800 text-stone-100',
      1,
      JSON.stringify(['Cyber Security Guild', 'Jibowu Resident'])
    );

    insertProfile.run(
      'p-dami',
      'u-dami',
      'Damilola Fashola',
      '@dami_soc',
      'Software Engineering',
      'School of Computing (SOC)',
      '300L',
      'Akindeko Hall',
      'Obanla',
      'Frontend craftsperson, open web advocate, TypeScript enthusiast.',
      'DF',
      'bg-stone-700 text-stone-100',
      1,
      JSON.stringify(['SWE Lead', 'Tech Builder'])
    );

    insertProfile.run(
      'p-chronicle',
      'u-chronicle',
      'FUTA Campus Chronicle',
      '@futachronicle',
      'Campus Press Guild',
      'SUG Accredited Press',
      'SUG Media',
      'SUG Secretariat Building',
      'Obanla',
      'Independent student journalism covering academic calendar revisions, SUG resolutions, hostel reports, and collegiate sports.',
      'FC',
      'bg-stone-900 text-stone-100',
      1,
      JSON.stringify(['Accredited Press', 'Senate Press Correspondent'])
    );

    insertProfile.run(
      'p-admin',
      'u-admin',
      'THEBACKDOOR',
      '@THEBACKDOOR',
      'Platform Governance & Safety',
      'Independent Platform',
      'Admin',
      'Platform Desk',
      'Main Platform Desk',
      'Official Platform Governance, Safety & Announcements for Schoolbackdoor.',
      'TB',
      'bg-stone-950 text-stone-50',
      1,
      JSON.stringify(['Admin', 'Official Platform'])
    );

    // 3. Seed Communities
    const insertCommunity = db.prepare(`
      INSERT INTO communities (id, name, acronym, category, member_count, description, location, leaders, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertCommunity.run('comm-1', 'School of Computing (SOC)', 'SOC', 'school', 2450, 'Computer Science, Software Engineering, Cybersecurity & Information Technology students.', 'SOC Complex, Obanla', 'Student Moderators: K. Adeleke & Peers', 1);
    insertCommunity.run('comm-2', 'School of Engineering & Engineering Tech', 'SEET', 'school', 3820, 'Electrical, Mechanical, Civil, Agricultural, Metallurgical, and Mining Engineers.', 'SEET Building & Workshop', 'Community Leads: O. Davies & Study Peers', 1);
    insertCommunity.run('comm-3', 'Titans & South Gate Residents Guild', 'TITANS', 'hostel', 1290, 'Student residents, everyday living tips, power watches, and neighborhood coordination for South Gate.', 'South Gate Perimeter', 'Hall Rep: T. Folarin', 1);
    insertCommunity.run('comm-4', 'Jibowu Hall of Residence', 'JBW', 'hostel', 960, 'Student community for Jibowu Hall residents on the main campus.', 'Inner Obanla Campus', 'Community Host: D. Olanrewaju', 1);
    insertCommunity.run('comm-5', 'FUTA Tech Developers & Builders', 'FTD', 'tech', 1640, 'Hackathons, open source contributors, software dev, AI research, and founder teams.', 'Akure & Virtual', 'Community Leads: S. Adebayo & Peers', 1);
    insertCommunity.run('comm-6', 'Campus Memes, Culture & Everyday Vibes', 'VIBES', 'social', 2190, 'Jokes, memes, music drops, weekend hangout spots, food reviews, and everyday student conversations.', 'South Gate & Obanla', 'Community Hosts: D. Fashola & Friends', 1);

    // 4. Seed Memberships
    const insertMember = db.prepare(`
      INSERT INTO community_memberships (id, community_id, user_id, role)
      VALUES (?, ?, ?, ?)
    `);
    insertMember.run('cm-1', 'comm-1', 'u-ayodele', 'lead');
    insertMember.run('cm-2', 'comm-3', 'u-ayodele', 'member');
    insertMember.run('cm-3', 'comm-5', 'u-ayodele', 'member');
    insertMember.run('cm-4', 'comm-1', 'u-kemi', 'member');
    insertMember.run('cm-5', 'comm-1', 'u-dami', 'member');

    // 5. Seed Announcements
    const insertAnnouncement = db.prepare(`
      INSERT INTO announcements (id, title, source, category, date_str, summary, full_body, is_verified, urgency, read_time, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertAnnouncement.run(
      'notice-1',
      'Campus Study Week & Exam Prep Spots Shared by Students',
      'Student Community Digest',
      'academic',
      'Nov 7, 2026',
      'Summary of popular night reading venues, generator hours, and crowd-sourced exam schedules shared by students.',
      'Disclaimer: Schoolbackdoor is an independent student social network and is not affiliated with university administration. Please verify official exam timetables directly with your department noticeboard. Students report quiet reading sessions active at ETF 3 and Ilemobade Library.',
      1,
      'high',
      '2 min read',
      'u-admin'
    );

    insertAnnouncement.run(
      'notice-2',
      'Weekend Water & Power Advisory around South Gate & Hostels',
      'Student Hostel Watch',
      'hostel',
      'Nov 6, 2026',
      'Student residents report scheduled borehole servicing across Akindeko, Jibowu, and nearby South Gate lodges.',
      'Community tip from fellow students: store water ahead of Saturday morning maintenance between 08:00 AM and 02:00 PM. Feel free to post live water/light updates in the Hostels & Living feed.',
      1,
      'normal',
      '2 min read',
      'u-admin'
    );

    insertAnnouncement.run(
      'notice-3',
      'Campus Shuttle Rates & Evening Hangout Spots Guide',
      'Student Transport Watch',
      'administrative',
      'Nov 5, 2026',
      'Student-crowdsourced shuttle fare guide between South Gate, Obanla, and Obakekere.',
      'Based on student reports, standard intra-campus shuttle fares remain ₦100. Share live route updates or traffic tips on Campus Commons anytime.',
      1,
      'normal',
      '2 min read',
      'u-chronicle'
    );

    // 6. Seed Posts
    const insertPost = db.prepare(`
      INSERT INTO posts (
        id, author_id, content, school_tag, hostel_tag, location_json, images_json,
        likes_count, comments_count, reposts_count, is_pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertPost.run(
      'post-1',
      'u-ayodele',
      'Night reading session + vibes at ETF 3 Basement Hall: Starting around 8:30 PM. Inverters are hooked up, bring your notes or just come chill and grab suya after with the squad.',
      'SEET',
      'South Gate',
      JSON.stringify({
        id: 'spot-etf3',
        name: 'ETF 3 Lecture Theatre',
        category: 'academic',
        coordinates: [7.3048, 5.136],
        description: 'Central multi-level lecture hall complex, Obanla Campus',
      }),
      JSON.stringify([
        'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=800&q=80',
      ]),
      42,
      2,
      6,
      0
    );

    insertPost.run(
      'post-2',
      'u-dami',
      'Me telling myself I will start my CSC assignment early vs me at 11:48 PM praying South Gate MTN network stays strong 😂💀 Who else is awake right now?',
      'Memes & Fun',
      null,
      JSON.stringify({
        id: 'spot-soc',
        name: 'School of Computing (SOC Complex)',
        category: 'academic',
        coordinates: [7.3041, 5.1352],
        description: 'Computer Science & Software Engineering faculty building',
      }),
      null,
      88,
      1,
      23,
      0
    );

    insertPost.run(
      'post-3',
      'u-chronicle',
      'Inter-departmental football kicks off this Friday at the Sports Complex! SEET Spartans face SOC Cyber Knights at 3:30 PM — bring vuvuzelas, cold drinks, and good energy.',
      'Discussions',
      null,
      JSON.stringify({
        id: 'spot-sports',
        name: 'University Sports Complex',
        category: 'sports',
        coordinates: [7.306, 5.141],
        description: 'Football stadium, tennis courts & student sports pavilion',
      }),
      JSON.stringify([
        'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=800&q=80',
      ]),
      156,
      0,
      45,
      1
    );

    // 7. Seed Comments (including a nested reply example!)
    const insertComment = db.prepare(`
      INSERT INTO comments (id, post_id, author_id, content, parent_comment_id)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertComment.run('c-1', 'post-1', 'u-kemi', 'Is the inverter setup strong enough for laptops tonight?', null);
    insertComment.run('c-2', 'post-1', 'u-ayodele', 'Yes! Plugged in at the front row and sockets are working.', 'c-1');
    insertComment.run('c-3', 'post-2', 'u-kemi', 'Literally me every single week 😭 sending strength!', null);

    // 8. Seed Likes
    const insertLike = db.prepare(`
      INSERT INTO likes (id, post_id, user_id)
      VALUES (?, ?, ?)
    `);
    insertLike.run('l-1', 'post-1', 'u-kemi');
    insertLike.run('l-2', 'post-1', 'u-dami');
    insertLike.run('l-3', 'post-2', 'u-ayodele');

    // 9. Seed Chats
    const insertChat = db.prepare(`
      INSERT INTO chats (id, type, title, handle, subtitle, avatar_initials, avatar_bg, last_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertChat.run(
      'conv-1',
      'group',
      'CSC 401: Distributed Systems Group',
      '@csc401_study',
      '6 active members',
      'DS',
      'bg-stone-800 text-stone-100',
      'Let us compare our Raft consensus diagrams tomorrow at the library.'
    );

    insertChat.run(
      'conv-2',
      'group',
      'Titans Hostel Room 14 (South Gate)',
      '@titans_r14',
      'Roommates',
      'TH',
      'bg-stone-700 text-stone-100',
      'Whoever is coming back from North Gate, please buy extra water sachet bags.'
    );

    // 10. Seed Chat Participants
    const insertParticipant = db.prepare(`
      INSERT INTO chat_participants (id, chat_id, user_id, role)
      VALUES (?, ?, ?, ?)
    `);
    insertParticipant.run('cp-1', 'conv-1', 'u-ayodele', 'admin');
    insertParticipant.run('cp-2', 'conv-1', 'u-kemi', 'member');
    insertParticipant.run('cp-3', 'conv-2', 'u-ayodele', 'admin');

    // 11. Seed Messages
    const insertMessage = db.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, text, location_json, images_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertMessage.run('m-1', 'conv-1', 'u-kemi', 'Did everyone finish question 3 from last year’s mid-term?', null, null);
    insertMessage.run(
      'm-2',
      'conv-1',
      'u-ayodele',
      'Yes! It’s based on Byzantine Fault Tolerance. Here are the summary notes.',
      null,
      JSON.stringify(['https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?auto=format&fit=crop&w=800&q=80'])
    );
    insertMessage.run(
      'm-3',
      'conv-1',
      'u-kemi',
      'Let us compare our Raft consensus diagrams tomorrow at the library.',
      JSON.stringify({
        id: 'spot-library',
        name: 'Albert Ilemobade University Library',
        category: 'academic',
        coordinates: [7.3028, 5.1392],
        description: 'Main campus research library and 24h reading halls',
      }),
      null
    );

    // 12. Seed Notifications
    const insertNotification = db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertNotification.run('n-1', 'u-ayodele', 'like', 'New reaction', 'Kemi Balogun liked your dispatch at ETF 3', '/home', 0);
    insertNotification.run('n-2', 'u-ayodele', 'comment', 'New study reply', 'Kemi Balogun replied to your dispatch', '/home', 0);
    insertNotification.run('n-3', 'u-ayodele', 'announcement', 'Senate Bulletin Released', 'First Semester Examination Schedule approved', '/updates', 0);

    // 13. Seed Initial Real Campus Advertisement Campaign
    try {
      db.prepare(`
        INSERT OR IGNORE INTO advertisements (
          id, title, sponsor_name, body, target_url, placement, target_area, status,
          budget_kobo, impressions_count, clicks_count, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'ad-dev-week-2026',
        'Student Builders Demo Day 2026',
        'Campus Open Tech Collective',
        'Submit your semester project prototype for weekend peer demos and mentorship.',
        '/communities',
        'feed',
        'all',
        'active',
        0,
        1,
        0,
        'u-admin'
      );
    } catch {
      // ignore if table absent
    }
  });

  syncDefaultModeratorAccount();
}

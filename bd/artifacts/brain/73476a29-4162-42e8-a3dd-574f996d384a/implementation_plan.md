# Schoolbackdoor — Development Stage 1 Foundation

Schoolbackdoor is a private, minimalist social networking platform tailored for students of the Federal University of Technology, Akure (FUTA). Stage 1 establishes the foundational architecture, paper-inspired visual design system, responsive dual-mode navigation, and six core interactive pages without external server dependencies or billing requirements.

### User Review & Critical Decisions

> [!IMPORTANT]
> The following directions have been confirmed and will anchor the design and implementation of Stage 1:

- **Aesthetic Tone**: Warm Newsprint with ink-black typography, alabaster/paper-white cards, and whisper hairline dividers (`border-stone-200/80`), avoiding generic tech SaaS gradients or plastic card pills.
- **FUTA Campus Life Blend**: Balanced mix of academic departments/schools (SOC, SEET, SAAT, SOS, SET, SMAT), popular student hostels (Titans, Jibowu, Akindeko, South Gate, North Gate), and campus social buzz.
- **Mobile Navigation & Compose**: Five-item fixed bottom navigation bar with an ergonomic floating action button (FAB) for instant thought/post composition.
- **Desktop Adaptation**: Persistent left-hand editorial sidebar with brand typography, quick links, active section counters, and an expanded right-hand campus trends rail.

---

## 1. Overview & Core Concept

- **What It Does**: Provides FUTA students with a private, collegiate social hub to share thoughts, check verified campus updates, message peers, browse departmental & hostel communities, view student profile cards, and customize reading preferences.
- **Target Audience**: Undergraduates, postgraduates, and student leaders across FUTA campuses (Obakekere and Obanla).
- **Core Value**: Fast, distraction-free campus communication styled like a thoughtful student journal or broadsheet rather than an ad-heavy algorithmic feed.

---

## 2. User Experience & Visual Design

### Aesthetic Direction & Material Tokens
- **Canvas (`60%`)**: Archival warm off-white (`#FBF9F5` / `bg-stone-50`), evoking high-grade newsprint and physical campus journals.
- **Structural Surfaces (`30%`)**: Pure white and warm ivory cards (`#FFFFFF` / `bg-white`), bordered by subtle hairline dividers (`border-stone-200` or `border-stone-300/70`).
- **Accent Budget (`10%`)**: Deep ink-black (`#1C1917` / `#0C0A09`) for primary CTAs and active states, paired with muted terracotta/forest accent highlights for verified campus badges.
- **Zero-Pill Metadata**: Metadata (dates, level, department, read-time) uses unboxed text with typographic separators (`·`, `•`), with interactive filters styled as clean segmented buttons.

### Typography System
- **Headlines & Masthead**: Editorial Serif (`Newsreader` / `Playfair Display` serif fallback via Google Fonts) for mastheads, article titles, and campus proclamations.
- **Body & UI**: Clean, high-legibility geometric sans (`Plus Jakarta Sans` or system sans) for navigation labels, chat bubbles, form fields, and body paragraphs.
- **Accession & Identifiers**: Tabular figures (`tabular-nums`) for matriculation masks, level numbers (e.g., `400L`), timestamps, and upvote counters.

### Responsive Navigation Framework
- **Mobile (< 768px)**:
  - Top Compact Masthead: Schoolbackdoor brand wordmark in serif, search trigger, and unread notification counter.
  - Sticky Bottom Tab Bar: 5 primary destinations (`Home`, `Updates`, `Chats`, `Communities`, `Profile`) with active icon indicators and 10px text labels.
  - Floating Compose Button: Ergonomic circular FAB positioned just above the bottom nav bar for quick posting.
- **Desktop (≥ 768px)**:
  - Left Editorial Sidebar (260px): Brand masthead, student identity chip, 6 navigation links (including `Settings`), and a prominent "Write Dispatch / Post" button.
  - Center Reading Well (640px–740px): Uncluttered feed, updates board, community directory, chat console, or profile overview.
  - Right Campus Rail (300px): "FUTA Noticeboard", "Trending at South Gate", and active student discussions.

### Pages & Flows to Build

1. **Home (The Campus Commons)**:
   - Interactive post feed (academic notices, hostel banter, tech hub meetups, campus memes).
   - Interaction bar: Heart/like, comment drawer toggle, repost/cite, and share.
   - Quick filter tabs: `All Posts`, `My School (SEET/SOC)`, `Hostel Buzz`, `Anonymous Wall`.
   - Compose Modal: Student can draft a post with title/thought, tag a school/hostel, and publish instantly to client state.

2. **Updates (The Official Noticeboard)**:
   - Categorized campus updates: Senate bulletins, SUG press releases, exam timetables, power/water hostel updates, and departmental deadlines.
   - Verified stamp indicators and filter by source (SUG, Dean of Students, Library, FUTA Sports).

3. **Chats (Student Messenger & Threads)**:
   - Split/drawer layout: Conversation list on left (Study Groups, Course Reps, Roommates) and active chat thread on right.
   - Interactive message composer: Real-time chat bubble appending with timestamps and delivery checks.

4. **Communities (Schools & Clubs Directory)**:
   - FUTA Schools: SOC (Computing), SEET (Engineering), SAAT (Agriculture), SOS (Sciences), SET (Earth & Mineral Sciences), SMAT (Management).
   - Campus Hubs & Hostels: Jibowu Hall, Titans Hall, Akindeko, South Gate Tech Guild, FUTA Debate Society, Developers Circle.
   - Join/Leave toggle and community statistics.

5. **Profile (Student ID & Dossier)**:
   - Physical student ID card inspired header: Student photo/avatar, Department (e.g., Computer Science · 400L), Matric ID mask (`CSC/20/xxxx`), campus badges, and bio.
   - Tabbed student content: `Dispatches`, `Saved Notices`, `Joined Communities`.

6. **Settings (Preferences & Controls)**:
   - Account preferences, campus notification toggles, privacy visibility (Show Department, Anonymous posting permissions), and font scale/reading contrast toggle.

---

## 3. Key Product Decisions & Trade-Offs

- **Client-Side Reactive Store (No Database Yet)**:
  - *Decision*: Use an in-memory/localStorage-backed reactive state store initialized with authentic FUTA seed data.
  - *Why*: Conforms strictly to Stage 1 constraints (no external databases, zero paid billing). Provides instantaneous UI responsiveness and preserves added posts/messages across page refreshes.
- **Typography Delivery**:
  - *Decision*: Import `Newsreader` and `Plus Jakarta Sans` via Google Fonts in `index.html` with robust fallback font-stacks in Tailwind.
  - *Why*: Delivers the requested paper-inspired, literary collegiate feel right out of the box without bloating `package.json` with font binaries.
- **Unified Navigation Controller**:
  - *Decision*: Centralize current route and modal state in the main application layout, synchronizing the mobile bottom bar and desktop sidebar.
  - *Why*: Eliminates page reload latency and keeps interactions lightweight, fluid, and mobile-friendly.

---

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        index.html (Newsreader & Fonts)                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                         App.tsx (Root Controller)                      │
│      • Active Tab State: 'home' | 'updates' | 'chats' | 'communities'  │
│                          | 'profile' | 'settings'                      │
│      • Compose Modal State & Notification Banner                       │
└─────────┬─────────────────────────┬──────────────────────────┬─────────┘
          │                         │                          │
┌─────────▼───────────┐   ┌─────────▼───────────┐   ┌──────────▼─────────┐
│ Desktop Sidebar Nav │   │ Mobile Top & Bottom │   │ Quick Compose FAB  │
│ (Brand, Links, CTA) │   │ Nav Bars (5 Tabs)   │   │ & Compose Modal    │
└─────────┬───────────┘   └─────────┬───────────┘   └──────────┬─────────┘
          │                         │                          │
┌─────────▼─────────────────────────▼──────────────────────────▼─────────┐
│                           Active Page View                             │
├─────────────┬─────────────┬─────────────┬─────────────┬────────────────┤
│    Home     │   Updates   │    Chats    │ Communities │ Profile & Sett │
│ (Feed & Tab)│(Noticeboard)│(Messenger)  │ (Directory) │ (ID & Prefs)   │
└─────────────┴─────────────┴─────────────┴─────────────┴────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                   Campus Seed & State Store (data.ts)                  │
│ • Initial FUTA posts, notices, student profiles, chats, communities    │
│ • Helpers for adding posts, liking, sending messages, toggling joins   │
└────────────────────────────────────────────────────────────────────────┘
```

### Component Structure
- `src/types/index.ts`: TypeScript interfaces for `Post`, `Notice`, `Community`, `ChatMessage`, `StudentProfile`.
- `src/data/futaData.ts`: Realistic FUTA campus seed data (Obanla & Obakekere campuses, South Gate, SEET, SOC, Jibowu Hall, SUG announcements).
- `src/components/layout/Navbar.tsx`: Responsive desktop sidebar and top header.
- `src/components/layout/BottomNav.tsx`: Mobile fixed bottom bar with 5 destinations + active tab states.
- `src/components/common/ComposeModal.tsx`: Clean paper-styled compose modal.
- `src/pages/HomePage.tsx`: Main campus feed with filters, like/comment actions, and compose prompt.
- `src/pages/UpdatesPage.tsx`: FUTA official and departmental noticeboard.
- `src/pages/ChatsPage.tsx`: Interactive student messaging and study group threads.
- `src/pages/CommunitiesPage.tsx`: FUTA schools, hostel hubs, and student associations.
- `src/pages/ProfilePage.tsx`: Student ID card dossier, bio, and personal activity tabs.
- `src/pages/SettingsPage.tsx`: Preferences, privacy, and display settings.

---

## 5. Verification Plan

1. **Build & Lint Verification**:
   - Run `compile_applet` and `lint_applet` to ensure strict TypeScript types and zero bundle errors.
2. **Desktop & Mobile Responsive Verification**:
   - Test bottom navigation visibility on screens `< 768px`.
   - Test sidebar layout on screens `≥ 768px`.
   - Verify minimum 44px touch targets on mobile triggers.
3. **Interactive Flow Testing**:
   - Navigation across all 6 pages (`Home`, `Updates`, `Chats`, `Communities`, `Profile`, `Settings`).
   - Create a new dispatch via the compose modal and verify immediate addition to the feed.
   - Send a chat message in `Chats` and confirm instant thread appending.
   - Toggle join/leave in `Communities` and like/heart in `Home`.
4. **Completion Report**:
   - Compile comprehensive Stage 1 summary detailing technologies, files created, server status, and build checks.

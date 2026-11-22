/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { INITIAL_STUDENT_PROFILE } from './data/futaData';
import { DesktopSidebar } from './components/layout/DesktopSidebar';
import { MobileBottomNav } from './components/layout/MobileBottomNav';
import { MobileTopBar } from './components/layout/MobileTopBar';
import { HomePage } from './pages/HomePage';
import { WelcomeScreen } from './components/auth/WelcomeScreen';
import { FeedSkeleton } from './components/common/Skeletons';
import { GlassButton, GlassCard, GlassNotification } from './components/glass';
import {
  AdminReport,
  AppNotification,
  CampusLocation,
  Community,
  Conversation,
  FeedCategory,
  FeedFilter,
  LocationFilterKey,
  Message,
  NavigationTab,
  Notice,
  PlatformConfig,
  Post,
  PresenceSummary,
  StudentProfile,
  UpdatesView,
} from './types';
import { api } from './api/client';
import { triggerHaptic } from './utils/haptics';
import { SavedLocationsProvider } from './utils/useSavedLocations';

const ChatsPage = lazy(() => import('./pages/ChatsPage').then((m) => ({ default: m.ChatsPage })));
const CommunitiesPage = lazy(() =>
  import('./pages/CommunitiesPage').then((m) => ({ default: m.CommunitiesPage }))
);
const UpdatesPage = lazy(() =>
  import('./pages/UpdatesPage').then((m) => ({ default: m.UpdatesPage }))
);
const ProfilePage = lazy(() =>
  import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage }))
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage }))
);
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));
const ModeratorPage = lazy(() =>
  import('./pages/ModeratorPage').then((m) => ({ default: m.ModeratorPage }))
);
const PoliciesPage = lazy(() =>
  import('./pages/PoliciesPage').then((m) => ({ default: m.PoliciesPage }))
);
const ComposeModal = lazy(() =>
  import('./components/common/ComposeModal').then((m) => ({ default: m.ComposeModal }))
);
const AuthModal = lazy(() =>
  import('./components/auth/AuthModal').then((m) => ({ default: m.AuthModal }))
);
const UserProfileModal = lazy(() =>
  import('./components/profile/UserProfileModal').then((m) => ({ default: m.UserProfileModal }))
);

const FEED_PAGE_SIZE = 15;
const VALID_TABS: NavigationTab[] = [
  'home',
  'updates',
  'chats',
  'communities',
  'profile',
  'settings',
  'admin',
  'mod',
  'policies',
];

type ToastTone = 'default' | 'success' | 'error';
type AdminSection =
  | 'overview'
  | 'users'
  | 'posts'
  | 'reports'
  | 'moderators'
  | 'analytics'
  | 'advertisements'
  | 'payments'
  | 'storage'
  | 'settings'
  | 'content'
  | 'communities'
  | 'moderation'
  | 'performance'
  | 'security'
  | 'features';

interface RouteState {
  tab: NavigationTab;
  viewingUserId: string | null;
  communityId: string | null;
  chatId: string | null;
  updatesView: UpdatesView;
  adminSection: AdminSection | null;
  postId: string | null;
}

function parseUrlRouteState(): RouteState {
  if (typeof window === 'undefined') {
    return {
      tab: 'home',
      viewingUserId: null,
      communityId: null,
      chatId: null,
      updatesView: 'notifications',
      adminSection: null,
      postId: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get('tab') as NavigationTab | null;
  const tab: NavigationTab = rawTab && VALID_TABS.includes(rawTab) ? rawTab : 'home';
  const rawUpdates = params.get('updates') as UpdatesView | null;
  const updatesView: UpdatesView =
    rawUpdates && ['notifications', 'bulletins', 'landmarks', 'saved'].includes(rawUpdates)
      ? rawUpdates
      : 'notifications';
  const rawSection = params.get('section') as AdminSection | null;
  const validAdminSections: AdminSection[] = [
    'overview',
    'users',
    'posts',
    'reports',
    'moderators',
    'analytics',
    'advertisements',
    'payments',
    'storage',
    'settings',
    'content',
    'communities',
    'moderation',
    'performance',
    'security',
    'features',
  ];
  const adminSection = rawSection && validAdminSections.includes(rawSection) ? rawSection : null;
  return {
    tab,
    viewingUserId: params.get('user'),
    communityId: params.get('community'),
    chatId: params.get('chat'),
    updatesView,
    adminSection,
    postId: params.get('post'),
  };
}

function buildUrlFromRoute(state: RouteState): string {
  const params = new URLSearchParams();
  if (state.tab !== 'home') params.set('tab', state.tab);
  if (state.viewingUserId) params.set('user', state.viewingUserId);
  if (state.tab === 'communities' && state.communityId) params.set('community', state.communityId);
  if (state.tab === 'chats' && state.chatId) params.set('chat', state.chatId);
  if (state.tab === 'updates' && state.updatesView !== 'notifications') {
    params.set('updates', state.updatesView);
  }
  if (state.tab === 'admin' && state.adminSection && state.adminSection !== 'overview') {
    params.set('section', state.adminSection);
  }
  if (state.postId) params.set('post', state.postId);
  const qs = params.toString();
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
}

const TabFallback = () => (
  <div className="w-full max-w-4xl mx-auto px-4 py-8">
    <FeedSkeleton count={3} />
  </div>
);

export default function App() {
  const initialRoute = useRef<RouteState | null>(null);
  if (!initialRoute.current) {
    initialRoute.current = parseUrlRouteState();
  }

  const [currentTab, setCurrentTab] = useState<NavigationTab>(initialRoute.current.tab);
  const currentTabRef = useRef<NavigationTab>(initialRoute.current.tab);
  currentTabRef.current = currentTab;

  const [posts, setPosts] = useState<Post[]>([]);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('all');
  const [feedCategory, setFeedCategory] = useState<FeedCategory>('for_you');
  const [feedLocation, setFeedLocation] = useState<LocationFilterKey>('all');
  const [hasMorePosts, setHasMorePosts] = useState(false);
  const [nextPostsOffset, setNextPostsOffset] = useState(0);
  const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const loadMoreLockRef = useRef(false);

  const [viewingUserId, setViewingUserId] = useState<string | null>(initialRoute.current.viewingUserId);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(
    initialRoute.current.communityId
  );
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialRoute.current.chatId);
  const [mobileShowChatThread, setMobileShowChatThread] = useState<boolean>(
    Boolean(initialRoute.current.chatId)
  );
  const [updatesView, setUpdatesView] = useState<UpdatesView>(initialRoute.current.updatesView);
  const [adminRequestedSection, setAdminRequestedSection] = useState<AdminSection | null>(
    initialRoute.current.adminSection
  );
  const [requestedCommunityTab, setRequestedCommunityTab] = useState<
    'discussions' | 'announcements' | null
  >(null);
  const [focusedPostId, setFocusedPostId] = useState<string | null>(initialRoute.current.postId);

  const [notices, setNotices] = useState<Notice[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [profile, setProfile] = useState<StudentProfile>(INITIAL_STUDENT_PROFILE);
  const [onlinePresence, setOnlinePresence] = useState<PresenceSummary>({
    onlineCount: 0,
    message: '0 students online now.',
    updatedAt: new Date().toISOString(),
  });
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);

  const [hasLoadedSession, setHasLoadedSession] = useState(false);
  const [dismissedWelcome, setDismissedWelcome] = useState(
    Boolean(
      initialRoute.current.postId ||
        initialRoute.current.tab !== 'home' ||
        initialRoute.current.viewingUserId
    )
  );

  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeInitialLocation, setComposeInitialLocation] = useState<CampusLocation | null>(null);
  const [toastState, setToastState] = useState<{ message: string; tone: ToastTone } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('login');
  const [latestAdminReport, setLatestAdminReport] = useState<AdminReport | null>(null);

  // Per-tab scroll position cache + in-flight duplicate-submission locks
  const scrollPositionsRef = useRef<Partial<Record<NavigationTab, number>>>({});
  const inFlightLikesRef = useRef<Set<string>>(new Set());
  const inFlightRepostsRef = useRef<Set<string>>(new Set());
  const inFlightJoinsRef = useRef<Set<string>>(new Set());
  const inFlightCommentsRef = useRef<Set<string>>(new Set());
  const isPoppingHistoryRef = useRef(false);

  const routeStateRef = useRef<RouteState>(initialRoute.current);
  routeStateRef.current = {
    tab: currentTab,
    viewingUserId,
    communityId: selectedCommunityId,
    chatId: selectedChatId,
    updatesView,
    adminSection: adminRequestedSection,
    postId: focusedPostId,
  };

  const showToast = useCallback((message: string, tone: ToastTone = 'default') => {
    if (tone === 'error') triggerHaptic('error');
    else if (tone === 'success') triggerHaptic('success');
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastState({ message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToastState(null);
      toastTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const navigate = useCallback(
    (
      patch: Partial<RouteState> & { replace?: boolean; clearPost?: boolean }
    ) => {
      const prev = routeStateRef.current;
      const nextTab = patch.tab ?? prev.tab;

      if (nextTab !== prev.tab && typeof window !== 'undefined') {
        scrollPositionsRef.current[prev.tab] = window.scrollY;
      }

      const nextState: RouteState = {
        tab: nextTab,
        viewingUserId:
          patch.viewingUserId !== undefined ? patch.viewingUserId : prev.viewingUserId,
        communityId:
          patch.communityId !== undefined
            ? patch.communityId
            : nextTab === prev.tab
            ? prev.communityId
            : null,
        chatId:
          patch.chatId !== undefined
            ? patch.chatId
            : nextTab === prev.tab
            ? prev.chatId
            : null,
        updatesView: patch.updatesView ?? prev.updatesView,
        adminSection:
          patch.adminSection !== undefined ? patch.adminSection : prev.adminSection,
        postId: patch.clearPost
          ? null
          : patch.postId !== undefined
          ? patch.postId
          : nextTab === 'home'
          ? prev.postId
          : null,
      };

      setCurrentTab(nextState.tab);
      setViewingUserId(nextState.viewingUserId);
      setSelectedCommunityId(nextState.communityId);
      setSelectedChatId(nextState.chatId);
      setUpdatesView(nextState.updatesView);
      setAdminRequestedSection(nextState.adminSection);
      setFocusedPostId(nextState.postId);

      if (nextTab === 'chats' && patch.chatId) {
        setMobileShowChatThread(true);
      } else if (nextTab !== 'chats') {
        setMobileShowChatThread(false);
      }

      if (typeof window !== 'undefined' && !isPoppingHistoryRef.current) {
        const nextUrl = buildUrlFromRoute(nextState);
        const currentUrl = `${window.location.pathname}${window.location.search}`;
        if (nextUrl !== currentUrl) {
          if (patch.replace) {
            window.history.replaceState(nextState, '', nextUrl);
          } else {
            window.history.pushState(nextState, '', nextUrl);
          }
        }
      }

      if (nextTab !== prev.tab && typeof window !== 'undefined') {
        const savedScroll = scrollPositionsRef.current[nextTab] ?? 0;
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: savedScroll, behavior: 'auto' });
        });
      }
    },
    []
  );

  // Sync Browser Back / Forward via popstate
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const initial = parseUrlRouteState();
    window.history.replaceState(initial, '', buildUrlFromRoute(initial));

    const handlePopState = (event: PopStateEvent) => {
      isPoppingHistoryRef.current = true;
      const prevTab = currentTabRef.current;
      scrollPositionsRef.current[prevTab] = window.scrollY;
      const target: RouteState = event.state?.tab ? event.state : parseUrlRouteState();

      setCurrentTab(target.tab);
      setViewingUserId(target.viewingUserId);
      setSelectedCommunityId(target.communityId);
      setSelectedChatId(target.chatId);
      setMobileShowChatThread(Boolean(target.tab === 'chats' && target.chatId));
      setUpdatesView(target.updatesView);
      setAdminRequestedSection(target.adminSection);
      setFocusedPostId(target.postId);

      const savedScroll = scrollPositionsRef.current[target.tab] ?? 0;
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: savedScroll, behavior: 'auto' });
        isPoppingHistoryRef.current = false;
      });
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleOpenCompose = useCallback((location?: CampusLocation | null) => {
    setComposeInitialLocation(location || null);
    setIsComposeOpen(true);
  }, []);

  const loadData = useCallback(
    async (
      activeFilter: FeedFilter = 'all',
      activeCategory: FeedCategory = 'for_you',
      activeLocation: LocationFilterKey = 'all'
    ) => {
      setFeedError(null);
      try {
        const [
          paginatedPosts,
          liveNotices,
          liveCommunities,
          liveChats,
          liveProfile,
          liveNotifs,
          livePresence,
          liveConfig,
        ] = await Promise.all([
          api
            .getPostsPaginated({
              limit: FEED_PAGE_SIZE,
              offset: 0,
              filter: activeFilter,
              category: activeCategory,
              location: activeLocation,
            })
            .catch((err) => {
              setFeedError(err?.message || 'Unable to load posts right now.');
              return null;
            }),
          api.getNotices(),
          api.getCommunities(),
          api.getChats(),
          api.getProfile(),
          api.getNotifications(),
          api.getOnlinePresence(),
          api.getPlatformConfig(),
        ]);

        if (paginatedPosts) {
          setPosts(paginatedPosts.posts);
          setHasMorePosts(paginatedPosts.hasMore);
          setNextPostsOffset(paginatedPosts.nextOffset);
          setFeedError(null);
        }
        if (liveNotices && liveNotices.length > 0) setNotices(liveNotices);
        if (liveCommunities && liveCommunities.length > 0) setCommunities(liveCommunities);
        if (liveChats && liveChats.length > 0) setConversations(liveChats);
        if (liveProfile) {
          setProfile(liveProfile);
        } else {
          setProfile(INITIAL_STUDENT_PROFILE);
        }
        if (liveNotifs) setNotifications(liveNotifs);
        if (livePresence) setOnlinePresence(livePresence);
        if (liveConfig) setPlatformConfig(liveConfig);
      } catch (err) {
        console.warn('Backend load deferred to local cache:', err);
      } finally {
        setHasLoadedSession(true);
      }
    },
    []
  );

  useEffect(() => {
    loadData(feedFilter, feedCategory, feedLocation);
  }, [loadData]);

  // Fetch deep-linked post (?post=...) if not already present in feed
  useEffect(() => {
    if (!focusedPostId) return;
    let active = true;
    api.getPostById(focusedPostId).then((shared) => {
      if (!active || !shared) return;
      setPosts((prev) => (prev.some((p) => p.id === shared.id) ? prev : [shared, ...prev]));
    });
    return () => {
      active = false;
    };
  }, [focusedPostId]);

  const fetchFirstFeedPage = useCallback(
    async (
      filter: FeedFilter,
      category: FeedCategory,
      location: LocationFilterKey,
      errorFallback = 'Unable to load posts right now.'
    ) => {
      setFeedError(null);
      loadMoreLockRef.current = false;
      try {
        const page = await api.getPostsPaginated({
          limit: FEED_PAGE_SIZE,
          offset: 0,
          filter,
          category,
          location,
        });
        setPosts(page.posts);
        setHasMorePosts(page.hasMore);
        setNextPostsOffset(page.nextOffset);
      } catch (err: any) {
        setFeedError(err?.message || errorFallback);
      }
    },
    []
  );

  const handleFeedFilterChange = useCallback(
    async (filter: FeedFilter) => {
      setFeedFilter(filter);
      await fetchFirstFeedPage(filter, feedCategory, feedLocation, 'Unable to load posts for this channel.');
    },
    [feedCategory, feedLocation, fetchFirstFeedPage]
  );

  const handleFeedCategoryChange = useCallback(
    async (category: FeedCategory) => {
      setFeedCategory(category);
      await fetchFirstFeedPage(feedFilter, category, feedLocation, 'Unable to load this feed section.');
    },
    [feedFilter, feedLocation, fetchFirstFeedPage]
  );

  const handleFeedLocationChange = useCallback(
    async (location: LocationFilterKey) => {
      setFeedLocation(location);
      await fetchFirstFeedPage(feedFilter, feedCategory, location, 'Unable to load posts for this area.');
    },
    [feedCategory, feedFilter, fetchFirstFeedPage]
  );

  const handleLoadMorePosts = useCallback(async () => {
    if (loadMoreLockRef.current || isLoadingMorePosts || !hasMorePosts) return;
    loadMoreLockRef.current = true;
    setIsLoadingMorePosts(true);
    setFeedError(null);
    try {
      const page = await api.getPostsPaginated({
        limit: FEED_PAGE_SIZE,
        offset: nextPostsOffset,
        filter: feedFilter,
        category: feedCategory,
        location: feedLocation,
      });
      if (page && page.posts.length > 0) {
        setPosts((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const merged = [...prev];
          for (const item of page.posts) {
            if (!seen.has(item.id)) merged.push(item);
          }
          return merged;
        });
        setHasMorePosts(page.hasMore);
        setNextPostsOffset(page.nextOffset);
      } else {
        setHasMorePosts(false);
      }
    } catch (err: any) {
      setFeedError(err?.message || 'Network error while loading more posts.');
    } finally {
      loadMoreLockRef.current = false;
      setIsLoadingMorePosts(false);
    }
  }, [feedCategory, feedFilter, feedLocation, hasMorePosts, isLoadingMorePosts, nextPostsOffset]);

  const handleRetryFeedPage = useCallback(() => {
    if (posts.length === 0) {
      fetchFirstFeedPage(feedFilter, feedCategory, feedLocation);
    } else {
      handleLoadMorePosts();
    }
  }, [feedCategory, feedFilter, feedLocation, fetchFirstFeedPage, handleLoadMorePosts, posts.length]);

  useEffect(() => {
    const disconnect = api.connectRealtime({
      onMessage: (incoming: any) => {
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id === incoming.chatId) {
              const alreadyExists = c.messages.some(
                (m) =>
                  m.id === incoming.id ||
                  (incoming.clientId && m.clientId === incoming.clientId)
              );
              if (alreadyExists) return c;

              const newMsg: Message = {
                id: incoming.id,
                clientId: incoming.clientId,
                senderId: incoming.senderId,
                senderName: incoming.senderName,
                senderAvatarInitials: incoming.senderAvatarInitials,
                senderAvatarBg: incoming.senderAvatarBg,
                senderAvatarUrl: incoming.senderAvatarUrl,
                senderAvatarThumbUrl: incoming.senderAvatarThumbUrl,
                text: incoming.text,
                mentions: incoming.mentions,
                isEdited: Boolean(incoming.isEdited),
                timestamp: 'Just now',
                isMe: false,
                status: 'sent',
                location: incoming.location,
                images: incoming.images,
              };

              return {
                ...c,
                lastMessage:
                  incoming.text ||
                  (incoming.location ? `Spot: ${incoming.location.name}` : 'Photo'),
                timestamp: 'Just now',
                unreadCount: c.unreadCount + 1,
                messages: [...c.messages, newMsg],
              };
            }
            return c;
          })
        );
      },
      onMessageUpdated: (updated: any) => {
        if (!updated?.chatId || !updated?.id) return;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== updated.chatId) return c;
            const nextMsgs = c.messages.map((m) =>
              m.id === updated.id
                ? {
                    ...m,
                    text: updated.text,
                    mentions: updated.mentions,
                    isEdited: true,
                  }
                : m
            );
            const lastMsg = nextMsgs[nextMsgs.length - 1];
            return {
              ...c,
              lastMessage:
                lastMsg?.id === updated.id ? updated.text || c.lastMessage : c.lastMessage,
              messages: nextMsgs,
            };
          })
        );
      },
      onMessageDeleted: (deleted: any) => {
        if (!deleted?.chatId || !deleted?.deletedMessageId) return;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== deleted.chatId) return c;
            const nextMsgs = c.messages.filter((m) => m.id !== deleted.deletedMessageId);
            const newest = nextMsgs[nextMsgs.length - 1];
            return {
              ...c,
              lastMessage: newest
                ? newest.text || (newest.location ? `Spot: ${newest.location.name}` : 'Photo')
                : 'No messages yet',
              messages: nextMsgs,
            };
          })
        );
      },
      onMessageRead: (payload: any) => {
        const chatId = payload?.chatId;
        if (!chatId) return;
        const readByUserId = payload?.readByUserId || payload?.userId;
        const messageIds: string[] = Array.isArray(payload?.messageIds) ? payload.messageIds : [];
        const readAt: string | undefined = payload?.readAt;

        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== chatId) return c;

            // Current user (or another open tab of current user) read this chat -> clear unread badge
            if (!readByUserId || readByUserId === profile.userId) {
              return { ...c, unreadCount: 0 };
            }

            // Direct chat partner opened the conversation -> mark outgoing messages as 'read'
            if (c.type !== 'direct') return c;
            const idSet = new Set(messageIds);
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (!m.isMe || m.status === 'read' || m.status === 'sending' || m.status === 'failed') {
                  return m;
                }
                if (idSet.size === 0 || idSet.has(m.id)) {
                  return {
                    ...m,
                    status: 'read',
                    readAt: readAt || m.readAt,
                  };
                }
                return m;
              }),
            };
          })
        );
      },
      onNotification: (notif: AppNotification) => {
        setNotifications((prev) => [notif, ...prev]);
        showToast(notif.title);
      },
      onNotificationRead: ({ notificationId }: any) => {
        setNotifications((prev) =>
          prev.map((n) => (n.id === notificationId ? { ...n, isRead: true } : n))
        );
      },
      onPresenceUpdate: (summary: PresenceSummary) => {
        setOnlinePresence(summary);
      },
      onConfigUpdated: (cfg: PlatformConfig) => {
        setPlatformConfig(cfg);
      },
      onAdminReport: (report: AdminReport) => {
        setLatestAdminReport(report);
        showToast(`New flagged post report: ${report.reason}`);
      },
    });

    return () => disconnect();
  }, [profile.userId, showToast]);

  // Silently sync conversations when switching to Chats tab so read receipts & incoming messages are fresh
  useEffect(() => {
    if (currentTab !== 'chats' || !profile.userId) return;
    let active = true;
    api.getChats().then((liveChats) => {
      if (!active || !Array.isArray(liveChats) || liveChats.length === 0) return;
      setConversations((prev) =>
        liveChats.map((serverConv) => {
          const prevConv = prev.find((c) => c.id === serverConv.id);
          if (!prevConv) return serverConv;
          const pendingMsgs = prevConv.messages.filter(
            (m) =>
              (m.status === 'sending' || m.status === 'failed') &&
              !serverConv.messages.some(
                (sm) => sm.id === m.id || (m.clientId && sm.clientId === m.clientId)
              )
          );
          if (pendingMsgs.length === 0) return serverConv;
          return {
            ...serverConv,
            messages: [...serverConv.messages, ...pendingMsgs],
          };
        })
      );
    });
    return () => {
      active = false;
    };
  }, [currentTab, profile.userId]);

  useEffect(() => {
    const pulseHeartbeat = async () => {
      if (document.visibilityState === 'hidden') return;
      const summary = await api.sendPresenceHeartbeat();
      if (summary) setOnlinePresence(summary);
    };

    pulseHeartbeat();
    const interval = setInterval(pulseHeartbeat, 45000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        pulseHeartbeat();
      }
    };
    const handlePageHide = () => {
      api.sendPresenceOffline();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [profile.userId]);

  const handleOpenAuth = useCallback((mode: 'login' | 'register' = 'login') => {
    setAuthModalMode(mode);
    setIsAuthModalOpen(true);
  }, []);

  const handleCloseAuth = useCallback(() => setIsAuthModalOpen(false), []);
  const handleSelectTab = useCallback(
    (tab: NavigationTab) => navigate({ tab, clearPost: tab !== 'home' }),
    [navigate]
  );
  const handleSelectSettings = useCallback(() => navigate({ tab: 'settings' }), [navigate]);
  const handleSelectUpdates = useCallback(
    (view?: UpdatesView) => navigate({ tab: 'updates', updatesView: view || 'notifications' }),
    [navigate]
  );
  const handleSelectChats = useCallback(
    (chatId?: string) => navigate({ tab: 'chats', chatId: chatId || null }),
    [navigate]
  );
  const handleOpenComposeSimple = useCallback(() => handleOpenCompose(), [handleOpenCompose]);
  const handleCloseCompose = useCallback(() => {
    setIsComposeOpen(false);
    setComposeInitialLocation(null);
  }, []);
  const handleRefreshFeed = useCallback(
    () => loadData(feedFilter, feedCategory, feedLocation),
    [feedCategory, feedFilter, feedLocation, loadData]
  );

  const handleTrackViews = useCallback(async (postIds: string[]) => {
    if (!postIds.length) return;
    const res = await api.recordPostViews(postIds, { source: 'feed', dwellMs: 900 });
    if (res?.viewsByPost && Object.keys(res.viewsByPost).length > 0) {
      setPosts((prev) =>
        prev.map((p) => {
          const updatedCount = res.viewsByPost[p.id];
          if (typeof updatedCount === 'number' && updatedCount > (p.viewsCount ?? 0)) {
            return { ...p, viewsCount: updatedCount };
          }
          return p;
        })
      );
    }
  }, []);

  const handleSharePostTracked = useCallback(async (postId: string) => {
    const res = await api.recordPostShare(postId);
    if (res && typeof res.shares === 'number') {
      setPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, sharesCount: res.shares } : p))
      );
    }
  }, []);

  const handleUpdateLocationConsent = useCallback(
    async (enabled: boolean, preferredArea: string | null) => {
      if (!profile.userId) {
        handleOpenAuth('login');
        return;
      }
      try {
        const res = await api.updateLocationPreference({
          locationSharingEnabled: enabled,
          preferredLocationArea: enabled ? preferredArea : null,
        });
        if (res.profile) {
          setProfile(res.profile);
        } else {
          setProfile((prev) => ({
            ...prev,
            locationSharingEnabled: res.locationSharingEnabled,
            preferredLocationArea: res.preferredLocationArea,
          }));
        }
        const nextLoc: LocationFilterKey =
          enabled && res.preferredLocationArea
            ? feedLocation === 'my_area'
              ? 'my_area'
              : feedLocation
            : feedLocation === 'my_area'
            ? 'all'
            : feedLocation;
        if (nextLoc !== feedLocation) setFeedLocation(nextLoc);
        await fetchFirstFeedPage(feedFilter, feedCategory, nextLoc);
        showToast(
          enabled && res.preferredLocationArea
            ? 'Area preference saved for feed relevance.'
            : 'Location sharing disabled. Your area preference was cleared.',
          'success'
        );
      } catch (e: any) {
        showToast(e?.message || 'Unable to update location preference.', 'error');
      }
    },
    [feedCategory, feedFilter, feedLocation, fetchFirstFeedPage, handleOpenAuth, profile.userId, showToast]
  );

  const handleReportPost = useCallback(
    async (postId: string, reason: string, details?: string) => {
      await api.createReport({
        target_type: 'post',
        target_id: postId,
        reason,
        details,
      });
      showToast('Report submitted. Admins have been alerted.', 'success');
    },
    [showToast]
  );

  const handleAuthSuccess = async (newProfile: StudentProfile, message?: string) => {
    setProfile(newProfile);
    setDismissedWelcome(true);
    showToast(message || `Authenticated as ${newProfile.handle}`, 'success');
    await loadData(feedFilter, feedCategory, feedLocation);
    const presence = await api.sendPresenceHeartbeat();
    if (presence) setOnlinePresence(presence);
  };

  const handleLogout = async () => {
    try {
      await api.logout();
      setProfile(INITIAL_STUDENT_PROFILE);
      setConversations([]);
      setFeedCategory('for_you');
      setFeedLocation('all');
      navigate({
        tab: 'home',
        viewingUserId: null,
        communityId: null,
        chatId: null,
        clearPost: true,
        replace: true,
      });
      setDismissedWelcome(false);
      showToast('Signed out of Schoolbackdoor');
      await loadData('all', 'for_you', 'all');
    } catch (e) {
      console.error('Logout error:', e);
      showToast('Signed out');
    }
  };

  const handleToggleLike = useCallback(
    async (postId: string) => {
      if (!profile.userId) {
        handleOpenAuth('login');
        return;
      }
      if (inFlightLikesRef.current.has(postId)) return;
      inFlightLikesRef.current.add(postId);
      triggerHaptic('like');

      const rollbackBox: { value: { isLiked: boolean; likes: number } | null } = { value: null };
      setPosts((prev) =>
        prev.map((post) => {
          if (post.id === postId) {
            rollbackBox.value = { isLiked: Boolean(post.isLiked), likes: post.likes };
            const isLiked = !post.isLiked;
            return {
              ...post,
              isLiked,
              likes: isLiked ? post.likes + 1 : Math.max(0, post.likes - 1),
            };
          }
          return post;
        })
      );

      try {
        const result = await api.toggleLike(postId);
        if (result) {
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId ? { ...p, isLiked: result.isLiked, likes: result.likes } : p
            )
          );
        }
      } catch (e: any) {
        if (rollbackBox.value) {
          const rollback = rollbackBox.value;
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId ? { ...p, isLiked: rollback.isLiked, likes: rollback.likes } : p
            )
          );
        }
        showToast(e?.message || 'Unable to update like right now.', 'error');
      } finally {
        inFlightLikesRef.current.delete(postId);
      }
    },
    [handleOpenAuth, profile.userId, showToast]
  );

  const handleToggleRepost = useCallback(
    async (postId: string) => {
      if (!profile.userId) {
        handleOpenAuth('login');
        return;
      }
      if (inFlightRepostsRef.current.has(postId)) return;
      inFlightRepostsRef.current.add(postId);
      triggerHaptic('like');

      const rollbackBox: { value: { isReposted: boolean; reposts: number } | null } = {
        value: null,
      };
      setPosts((prev) =>
        prev.map((post) => {
          if (post.id === postId) {
            rollbackBox.value = { isReposted: Boolean(post.isReposted), reposts: post.reposts };
            const isReposted = !post.isReposted;
            return {
              ...post,
              isReposted,
              reposts: isReposted ? post.reposts + 1 : Math.max(0, post.reposts - 1),
            };
          }
          return post;
        })
      );

      try {
        const result = await api.toggleRepost(postId);
        if (result) {
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId
                ? { ...p, isReposted: result.isReposted, reposts: result.reposts }
                : p
            )
          );
          showToast(
            result.isReposted ? 'Reposted to your feed' : 'Removed repost',
            'success'
          );
        }
      } catch (e: any) {
        if (rollbackBox.value) {
          const rollback = rollbackBox.value;
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId
                ? { ...p, isReposted: rollback.isReposted, reposts: rollback.reposts }
                : p
            )
          );
        }
        showToast(e?.message || 'Unable to repost right now.', 'error');
      } finally {
        inFlightRepostsRef.current.delete(postId);
      }
    },
    [handleOpenAuth, profile.userId, showToast]
  );

  const handleToggleSave = useCallback(
    (postId: string) => {
      triggerHaptic('tap');
      setPosts((prev) =>
        prev.map((post) => {
          if (post.id === postId) {
            const isSaved = !post.isSaved;
            showToast(isSaved ? 'Saved post to bookmarks' : 'Removed from bookmarks', 'success');
            return { ...post, isSaved };
          }
          return post;
        })
      );
    },
    [showToast]
  );

  const handleVotePoll = useCallback(
    async (postId: string, optionId: string) => {
      if (!profile.userId) {
        handleOpenAuth('login');
        return;
      }
      triggerHaptic('like');

      let previousPollSnapshot: Post['poll'] | undefined;

      setPosts((prev) =>
        prev.map((post) => {
          if (post.id !== postId || !post.poll) return post;
          previousPollSnapshot = post.poll;
          const prevVoted = new Set(post.poll.userVotedOptionIds || []);
          let nextVoted: string[];

          if (post.poll.allowMultiple) {
            if (prevVoted.has(optionId)) {
              prevVoted.delete(optionId);
            } else {
              prevVoted.add(optionId);
            }
            nextVoted = Array.from(prevVoted);
          } else {
            if (prevVoted.has(optionId)) {
              return post;
            }
            nextVoted = [optionId];
          }

          const nextOptions = post.poll.options.map((opt) => {
            const wasSelected = post.poll!.userVotedOptionIds.includes(opt.id);
            const isNowSelected = nextVoted.includes(opt.id);
            let votes = opt.votes;
            if (!wasSelected && isNowSelected) votes += 1;
            else if (wasSelected && !isNowSelected) votes = Math.max(0, votes - 1);
            return { ...opt, votes };
          });

          const totalVotes = nextOptions.reduce((sum, o) => sum + o.votes, 0);

          return {
            ...post,
            poll: {
              ...post.poll,
              options: nextOptions,
              totalVotes,
              userVotedOptionIds: nextVoted,
            },
          };
        })
      );

      try {
        const result = await api.votePoll(postId, optionId);
        if (result?.poll) {
          setPosts((prev) =>
            prev.map((p) => (p.id === postId ? { ...p, poll: result.poll } : p))
          );
        }
      } catch (e: any) {
        if (previousPollSnapshot) {
          const rollback = previousPollSnapshot;
          setPosts((prev) =>
            prev.map((p) => (p.id === postId ? { ...p, poll: rollback } : p))
          );
        }
        showToast(e?.message || 'Unable to submit vote right now.', 'error');
      }
    },
    [handleOpenAuth, profile.userId, showToast]
  );

  const handleAddComment = useCallback(
    async (postId: string, text: string, parentCommentId?: string, images?: string[]): Promise<boolean> => {
      if (!profile.userId) {
        handleOpenAuth('login');
        return false;
      }
      const cleanText = (text || '').trim();
      const attachedImages = Array.isArray(images) ? images.filter(Boolean) : [];
      if (!cleanText && attachedImages.length === 0) return false;

      if (inFlightCommentsRef.current.has(postId)) return false;
      inFlightCommentsRef.current.add(postId);

      const tempCommentId = `temp-c-${Date.now()}`;
      const newComment = {
        id: tempCommentId,
        parentCommentId,
        authorId: profile.userId,
        authorName: profile.name,
        authorHandle: profile.handle,
        avatarInitials: profile.avatarInitials,
        avatarBg: profile.avatarBg,
        avatarUrl: profile.avatarUrl,
        avatarThumbUrl: profile.avatarThumbUrl,
        department: profile.department,
        level: profile.level,
        content: cleanText,
        images: attachedImages.length > 0 ? attachedImages : undefined,
        timestamp: 'Just now',
      };

      setPosts((prev) =>
        prev.map((post) => {
          if (post.id === postId) {
            return {
              ...post,
              commentsCount: post.commentsCount + 1,
              comments: [...post.comments, newComment],
            };
          }
          return post;
        })
      );

      try {
        const savedComment = await api.addComment(postId, cleanText, parentCommentId, attachedImages);
        if (savedComment?.id) {
          setPosts((prev) =>
            prev.map((post) =>
              post.id === postId
                ? {
                    ...post,
                    comments: post.comments.map((c) =>
                      c.id === tempCommentId ? savedComment : c
                    ),
                  }
                : post
            )
          );
        }
        showToast(parentCommentId ? 'Reply published' : 'Comment published', 'success');
        return true;
      } catch (e: any) {
        setPosts((prev) =>
          prev.map((post) =>
            post.id === postId
              ? {
                  ...post,
                  commentsCount: Math.max(0, post.commentsCount - 1),
                  comments: post.comments.filter((c) => c.id !== tempCommentId),
                }
              : post
          )
        );
        showToast(e?.message || 'Could not publish comment right now.', 'error');
        return false;
      } finally {
        inFlightCommentsRef.current.delete(postId);
      }
    },
    [
      handleOpenAuth,
      profile.avatarBg,
      profile.avatarInitials,
      profile.avatarThumbUrl,
      profile.avatarUrl,
      profile.department,
      profile.handle,
      profile.level,
      profile.name,
      profile.userId,
      showToast,
    ]
  );

  const handleEditPost = useCallback(
    async (postId: string, content: string): Promise<boolean> => {
      try {
        const updated = await api.editPost(postId, content);
        setPosts((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, ...updated, comments: updated.comments || p.comments } : p))
        );
        showToast('Post updated', 'success');
        return true;
      } catch (e: any) {
        showToast(e?.message || 'Unable to edit post.', 'error');
        return false;
      }
    },
    [showToast]
  );

  const handleDeletePost = useCallback(
    async (postId: string): Promise<boolean> => {
      try {
        await api.deletePost(postId);
        setPosts((prev) => prev.filter((p) => p.id !== postId));
        showToast('Post deleted', 'success');
        return true;
      } catch (e: any) {
        showToast(e?.message || 'Unable to delete post.', 'error');
        return false;
      }
    },
    [showToast]
  );

  const handleEditComment = useCallback(
    async (postId: string, commentId: string, content: string): Promise<boolean> => {
      try {
        const updated = await api.editComment(commentId, content);
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  comments: p.comments.map((c) => (c.id === commentId ? { ...c, ...updated } : c)),
                }
              : p
          )
        );
        showToast('Comment updated', 'success');
        return true;
      } catch (e: any) {
        showToast(e?.message || 'Unable to edit comment.', 'error');
        return false;
      }
    },
    [showToast]
  );

  const handleDeleteComment = useCallback(
    async (postId: string, commentId: string): Promise<boolean> => {
      try {
        await api.deleteComment(commentId);
        setPosts((prev) =>
          prev.map((p) => {
            if (p.id !== postId) return p;
            const remaining = p.comments.filter(
              (c) => c.id !== commentId && c.parentCommentId !== commentId
            );
            return {
              ...p,
              comments: remaining,
              commentsCount: remaining.length,
            };
          })
        );
        showToast('Comment removed', 'success');
        return true;
      } catch (e: any) {
        showToast(e?.message || 'Unable to delete comment.', 'error');
        return false;
      }
    },
    [showToast]
  );

  const handleMessageUser = useCallback(
    async (targetUserId: string) => {
      if (!profile.userId) {
        handleOpenAuth('login');
        return;
      }
      try {
        const res = await api.createDirectChat(targetUserId);
        const liveChats = await api.getChats();
        if (liveChats) setConversations(liveChats);
        navigate({ tab: 'chats', viewingUserId: null, chatId: res?.chatId || null });
      } catch (e: any) {
        showToast(e?.message || 'Unable to start direct message.', 'error');
      }
    },
    [handleOpenAuth, navigate, profile.userId, showToast]
  );

  const handleAddPost = async (
    newPostData: Omit<Post, 'id' | 'timestamp' | 'likes' | 'commentsCount' | 'reposts' | 'comments'>
  ): Promise<boolean> => {
    if (!profile.userId) {
      handleOpenAuth('login');
      return false;
    }
    const persisted = await api.createPost({
      content: newPostData.content,
      school_tag: newPostData.schoolTag,
      hostel_tag: newPostData.hostelTag,
      location: newPostData.location,
      images: newPostData.images,
      is_anonymous: newPostData.isAnonymous,
      poll: newPostData.poll
        ? {
            question: newPostData.poll.question,
            options: newPostData.poll.options.map((o) => o.label),
            allowMultiple: newPostData.poll.allowMultiple,
          }
        : undefined,
    });
    if (persisted) {
      setPosts((prev) => (prev.some((p) => p.id === persisted.id) ? prev : [persisted, ...prev]));
    }
    navigate({ tab: 'home', clearPost: true });
    showToast(
      persisted?.location || newPostData.location
        ? `Post pinned at ${(persisted?.location || newPostData.location)?.name} published`
        : 'Post published to the feed',
      'success'
    );
    return true;
  };

  const handleToggleJoin = async (communityId: string) => {
    if (!profile.userId) {
      handleOpenAuth('login');
      return;
    }
    if (inFlightJoinsRef.current.has(communityId)) return;
    inFlightJoinsRef.current.add(communityId);
    triggerHaptic('like');

    const rollbackBox: {
      value: { isJoined: boolean; memberCount: number; acronym: string } | null;
    } = { value: null };
    setCommunities((prev) =>
      prev.map((c) => {
        if (c.id === communityId) {
          rollbackBox.value = { isJoined: c.isJoined, memberCount: c.memberCount, acronym: c.acronym };
          const isJoined = !c.isJoined;
          return {
            ...c,
            isJoined,
            memberCount: isJoined ? c.memberCount + 1 : Math.max(0, c.memberCount - 1),
          };
        }
        return c;
      })
    );

    try {
      const result = await api.toggleJoinCommunity(communityId);
      if (result) {
        setCommunities((prev) =>
          prev.map((c) =>
            c.id === communityId
              ? { ...c, isJoined: result.isJoined, memberCount: result.memberCount }
              : c
          )
        );
        showToast(
          `${result.isJoined ? 'Joined' : 'Left'} ${rollbackBox.value?.acronym || 'community'}`,
          'success'
        );
      }
    } catch (e: any) {
      if (rollbackBox.value) {
        const rollback = rollbackBox.value;
        setCommunities((prev) =>
          prev.map((c) =>
            c.id === communityId
              ? { ...c, isJoined: rollback.isJoined, memberCount: rollback.memberCount }
              : c
          )
        );
      }
      showToast(e?.message || 'Unable to update community membership.', 'error');
    } finally {
      inFlightJoinsRef.current.delete(communityId);
    }
  };

  const handleSendMessage = async (
    conversationId: string,
    text: string,
    location?: CampusLocation,
    images?: string[],
    clientId?: string
  ) => {
    const effectiveClientId =
      clientId || `cli-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

    const optimisticMessage: Message = {
      id: effectiveClientId,
      clientId: effectiveClientId,
      senderName: 'You',
      text,
      timestamp: 'Just now',
      isMe: true,
      status: 'sending',
      location,
      images,
    };

    setConversations((prev) =>
      prev.map((conv) => {
        if (conv.id === conversationId) {
          const previewText = text
            ? location
              ? `Spot: ${location.name} - ${text}`
              : text
            : images && images.length > 0
            ? 'Photo attachment'
            : location
            ? `Spot: ${location.name}`
            : '';

          const msgIndex = conv.messages.findIndex(
            (m) => m.clientId === effectiveClientId || m.id === effectiveClientId
          );

          let updatedMessages: Message[];
          if (msgIndex >= 0) {
            updatedMessages = [...conv.messages];
            updatedMessages[msgIndex] = optimisticMessage;
          } else {
            updatedMessages = [...conv.messages, optimisticMessage];
          }

          return {
            ...conv,
            lastMessage: previewText,
            timestamp: 'Just now',
            unreadCount: 0,
            messages: updatedMessages,
          };
        }
        return conv;
      })
    );

    try {
      const persistedMessage = await api.sendMessage(
        conversationId,
        text,
        location,
        images,
        effectiveClientId
      );

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id === conversationId) {
            return {
              ...conv,
              messages: conv.messages.map((m) =>
                m.clientId === effectiveClientId || m.id === effectiveClientId
                  ? {
                      ...persistedMessage,
                      isMe: true,
                      status:
                        persistedMessage.status === 'read' || m.status === 'read'
                          ? 'read'
                          : 'sent',
                    }
                  : m
              ),
            };
          }
          return conv;
        })
      );

      if (location && images && images.length > 0) {
        showToast(`Shared photo & spot at ${location.name}`, 'success');
      } else if (location) {
        showToast(`Shared location: ${location.name}`, 'success');
      } else if (images && images.length > 0) {
        showToast('Photo sent to chat', 'success');
      }
    } catch (e: any) {
      console.error('Failed to deliver message:', e);
      showToast(e.message || 'Message delivery failed', 'error');

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id === conversationId) {
            return {
              ...conv,
              messages: conv.messages.map((m) =>
                m.clientId === effectiveClientId || m.id === effectiveClientId
                  ? { ...m, status: 'failed' }
                  : m
              ),
            };
          }
          return conv;
        })
      );
    }
  };

  const handleEditMessage = useCallback(
    async (conversationId: string, messageId: string, text: string): Promise<boolean> => {
      try {
        const updated = await api.editMessage(conversationId, messageId, text);
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== conversationId) return conv;
            const nextMessages = conv.messages.map((m) =>
              m.id === messageId
                ? { ...m, text: updated.text, mentions: updated.mentions, isEdited: true }
                : m
            );
            const newest = nextMessages[nextMessages.length - 1];
            return {
              ...conv,
              lastMessage: newest?.id === messageId ? updated.text : conv.lastMessage,
              messages: nextMessages,
            };
          })
        );
        showToast('Message updated', 'success');
        return true;
      } catch (e: any) {
        showToast(e?.message || 'Unable to edit message.', 'error');
        return false;
      }
    },
    [showToast]
  );

  const handleDeleteMessage = useCallback(
    async (conversationId: string, messageId: string): Promise<boolean> => {
      try {
        await api.deleteMessage(conversationId, messageId);
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== conversationId) return conv;
            const nextMessages = conv.messages.filter((m) => m.id !== messageId);
            const newest = nextMessages[nextMessages.length - 1];
            return {
              ...conv,
              lastMessage: newest
                ? newest.text || (newest.location ? `Spot: ${newest.location.name}` : 'Photo')
                : 'No messages yet',
              messages: nextMessages,
            };
          })
        );
        showToast('Message deleted', 'success');
        return true;
      } catch (e: any) {
        showToast(e?.message || 'Unable to delete message.', 'error');
        return false;
      }
    },
    [showToast]
  );

  const handleMarkChatRead = useCallback(async (chatId: string) => {
    if (!chatId) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c))
    );
    await api.markChatAsRead(chatId);
  }, []);

  const handleMarkNotificationRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
    );
    await api.markNotificationAsRead(id);
  };

  const handleMarkAllNotificationsRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    await api.markAllNotificationsAsRead();
  };

  const handleProfileUpdated = useCallback(async (updated: StudentProfile) => {
    setProfile(updated);
    const presence = await api.getOnlinePresence();
    if (presence) setOnlinePresence(presence);
  }, []);

  const handleNotificationDeepLink = useCallback(
    (tab: NavigationTab, rawLink?: string) => {
      let query = '';
      if (rawLink && rawLink.includes('?')) {
        query = rawLink.slice(rawLink.indexOf('?') + 1);
      }
      const params = new URLSearchParams(query);
      if (tab === 'home') {
        navigate({ tab: 'home', postId: params.get('post') || null });
      } else if (tab === 'chats') {
        navigate({
          tab: 'chats',
          chatId: params.get('conv') || params.get('chat') || params.get('chatId') || null,
        });
      } else if (tab === 'communities') {
        setRequestedCommunityTab(params.get('announcement') ? 'announcements' : 'discussions');
        navigate({
          tab: 'communities',
          communityId: params.get('id') || params.get('community') || null,
        });
      } else if (tab === 'admin') {
        navigate({
          tab: 'admin',
          adminSection: (params.get('section') as AdminSection | null) || 'moderation',
        });
      } else {
        navigate({ tab });
      }
    },
    [navigate]
  );

  const unreadMessagesCount = conversations.reduce(
    (acc, curr) => acc + curr.unreadCount,
    0
  );
  const unreadNoticesCount = notifications.filter((n) => !n.isRead).length;

  const isAdminUser = profile.role === 'admin';
  const isGlobalMaintenance = platformConfig?.settings?.maintenance_mode === 'true';
  const maintenanceBanner =
    platformConfig?.settings?.maintenance_message ||
    'Scheduled platform maintenance is in progress. Normal student access will resume shortly.';

  const tabFeatureMap: Partial<Record<NavigationTab, string>> = {
    home: 'posts',
    updates: 'updates',
    chats: 'chats',
    communities: 'communities',
  };
  const activeFeatureKey = tabFeatureMap[currentTab];
  const activeFeatureConfig = activeFeatureKey
    ? platformConfig?.features?.find((f) => f.key === activeFeatureKey)
    : undefined;
  const isTabBlocked =
    !isAdminUser &&
    ((isGlobalMaintenance && currentTab !== 'settings' && currentTab !== 'policies') ||
      Boolean(activeFeatureConfig && (!activeFeatureConfig.enabled || activeFeatureConfig.maintenanceMode)));

  const showWelcomeGate = hasLoadedSession && !profile.userId && !dismissedWelcome;

  return (
    <SavedLocationsProvider userId={profile.userId} onNotify={(msg) => showToast(msg)}>
    <div className="min-h-dvh overflow-x-clip sb-liquid-canvas text-[#171613] dark:text-[#F5EFE3] flex flex-col md:flex-row antialiased">
      {showWelcomeGate ? (
        <div className="w-full">
          <WelcomeScreen
            onGetStarted={() => handleOpenAuth('register')}
            onSignIn={() => handleOpenAuth('login')}
            onBrowsePublicFeed={() => setDismissedWelcome(true)}
            onlineMessage={onlinePresence.message}
          />
        </div>
      ) : (
        <>
          <MobileTopBar
            currentTab={currentTab}
            onSelectTab={handleSelectTab}
            onOpenSettings={handleSelectSettings}
            profile={profile}
            onOpenAuth={handleOpenAuth}
          />

          <DesktopSidebar
            currentTab={currentTab}
            onSelectTab={handleSelectTab}
            onOpenCompose={handleOpenComposeSimple}
            profile={profile}
            unreadMessagesCount={unreadMessagesCount}
            unreadNoticesCount={unreadNoticesCount}
            onlinePresence={onlinePresence}
            platformConfig={platformConfig}
            onOpenAuth={handleOpenAuth}
            onLogout={handleLogout}
          />

          <main className="flex-1 min-w-0 pb-24 md:pb-8">
            {isGlobalMaintenance && (
              <div className="bg-[#171613] dark:bg-[#1C1A16] text-[#F5EFE3] px-4 py-2.5 text-xs flex items-center justify-between gap-3 border-b border-[#D98BA5]/30">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#D98BA5] animate-pulse shrink-0" />
                  <span className="font-medium">
                    Maintenance Mode Active{isAdminUser ? ' (Admin Bypass Active)' : ''}: {maintenanceBanner}
                  </span>
                </div>
                {isAdminUser && (
                  <button
                    type="button"
                    onClick={() => navigate({ tab: 'admin' })}
                    className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] font-semibold text-[11px] shrink-0 cursor-pointer"
                  >
                    Open Admin
                  </button>
                )}
              </div>
            )}

            {profile.restrictedUntil && new Date(profile.restrictedUntil).getTime() > Date.now() && (
              <div className="bg-[#F6E2E6] dark:bg-[#4A2532]/75 text-[#171613] dark:text-[#F5EFE3] px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2 border-b border-[#C4718E]/40">
                <div>
                  <span className="font-semibold">Temporary Account Restriction Active:</span>{' '}
                  Posting and messaging are paused until{' '}
                  <span className="font-mono tabular-nums">{new Date(profile.restrictedUntil).toLocaleString()}</span>.
                  {profile.restrictionReason && ` Reason: ${profile.restrictionReason}`}
                </div>
              </div>
            )}

            {isTabBlocked ? (
              <div className="max-w-xl mx-auto my-12 px-4">
                <GlassCard tone="cream" padding="lg" className="text-center">
                  <div className="w-11 h-11 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-[#171613] dark:text-[#F5EFE3] mx-auto mb-3 flex items-center justify-center font-serif font-bold text-lg">
                    !
                  </div>
                  <h2 className="font-serif text-xl font-bold text-[#171613] dark:text-[#F5EFE3]">
                    {isGlobalMaintenance
                      ? 'Platform Under Scheduled Maintenance'
                      : activeFeatureConfig?.maintenanceMode
                      ? `${activeFeatureConfig.name} — Maintenance`
                      : `${activeFeatureConfig?.name || 'Feature'} Temporarily Paused`}
                  </h2>
                  <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-2 leading-relaxed">
                    {isGlobalMaintenance
                      ? maintenanceBanner
                      : activeFeatureConfig?.maintenanceMessage ||
                        'This module has been temporarily paused by the Schoolbackdoor Admin. All existing student records remain safely preserved.'}
                  </p>
                  <div className="mt-5 flex items-center justify-center gap-2">
                    <GlassButton variant="pink" size="sm" onClick={() => navigate({ tab: 'settings' })}>
                      Account &amp; Sign In
                    </GlassButton>
                    <GlassButton variant="glass" size="sm" onClick={() => navigate({ tab: 'policies' })}>
                      View Policies
                    </GlassButton>
                  </div>
                </GlassCard>
              </div>
            ) : (
              <>
                {currentTab === 'home' && (
                  <HomePage
                    posts={posts}
                    notices={notices}
                    onToggleLike={handleToggleLike}
                    onToggleRepost={handleToggleRepost}
                    onToggleSave={handleToggleSave}
                    onAddComment={handleAddComment}
                    onEditPost={handleEditPost}
                    onDeletePost={handleDeletePost}
                    onEditComment={handleEditComment}
                    onDeleteComment={handleDeleteComment}
                    onVotePoll={handleVotePoll}
                    onOpenCompose={handleOpenComposeSimple}
                    onNavigateToUpdates={handleSelectUpdates}
                    onReportPost={handleReportPost}
                    onViewUserProfile={(uid) => navigate({ viewingUserId: uid })}
                    onNotify={(msg) => showToast(msg)}
                    onRequireAuth={() => handleOpenAuth('login')}
                    isAuthenticated={Boolean(profile.userId)}
                    profile={profile}
                    onlinePresence={onlinePresence}
                    focusedPostId={focusedPostId}
                    activeFilter={feedFilter}
                    onFilterChange={handleFeedFilterChange}
                    activeCategory={feedCategory}
                    onCategoryChange={handleFeedCategoryChange}
                    activeLocation={feedLocation}
                    onLocationChange={handleFeedLocationChange}
                    onUpdateLocationConsent={handleUpdateLocationConsent}
                    onTrackViews={handleTrackViews}
                    onSharePostTracked={handleSharePostTracked}
                    hasMorePosts={hasMorePosts}
                    isLoading={!hasLoadedSession}
                    isLoadingMore={isLoadingMorePosts}
                    feedError={feedError}
                    onLoadMore={handleLoadMorePosts}
                    onRetryLoad={handleRetryFeedPage}
                  />
                )}

                <Suspense fallback={<TabFallback />}>
                  {currentTab === 'updates' && (
                    <UpdatesPage
                      notices={notices}
                      notifications={notifications}
                      activeView={updatesView}
                      onViewChange={(view) => navigate({ tab: 'updates', updatesView: view })}
                      onMarkNotificationRead={handleMarkNotificationRead}
                      onMarkAllNotificationsRead={handleMarkAllNotificationsRead}
                      onNavigateToTab={handleNotificationDeepLink}
                      onPinLandmarkToDispatch={(landmark) => {
                        handleOpenCompose(landmark);
                        showToast(`Pinned ${landmark.name} to draft`);
                      }}
                      onFilterFeedByArea={(area) => {
                        setFeedLocation(area);
                        navigate({ tab: 'home', clearPost: true });
                        loadData(feedFilter, feedCategory, area);
                      }}
                    />
                  )}

                  {currentTab === 'chats' && (
                    <ChatsPage
                      conversations={conversations}
                      onSendMessage={handleSendMessage}
                      onEditMessage={handleEditMessage}
                      onDeleteMessage={handleDeleteMessage}
                      onMarkChatRead={handleMarkChatRead}
                      onViewUserProfile={(uid) => navigate({ viewingUserId: uid })}
                      onRefreshChats={handleRefreshFeed}
                      selectedConvId={selectedChatId}
                      onSelectConv={(id) => {
                        navigate({ tab: 'chats', chatId: id });
                      }}
                      mobileShowThread={mobileShowChatThread}
                      onMobileShowThreadChange={(show) => {
                        setMobileShowChatThread(show);
                        if (!show) {
                          navigate({ tab: 'chats', chatId: null });
                        }
                      }}
                      isLoading={!hasLoadedSession}
                    />
                  )}

                  {currentTab === 'communities' && (
                    <CommunitiesPage
                      communities={communities}
                      onToggleJoin={handleToggleJoin}
                      onNavigateToChat={(chatId) => handleSelectChats(chatId)}
                      onViewUserProfile={(uid) => navigate({ viewingUserId: uid })}
                      profile={profile}
                      onRefreshCommunities={handleRefreshFeed}
                      selectedCommunityId={selectedCommunityId}
                      onSelectCommunity={(id) =>
                        navigate({ tab: 'communities', communityId: id })
                      }
                      requestedTab={requestedCommunityTab}
                      onClearRequestedTab={() => setRequestedCommunityTab(null)}
                      onPostUpdated={(updatedPost) => {
                        setPosts((prev) =>
                          prev.map((p) =>
                            p.id === updatedPost.id
                              ? { ...p, ...updatedPost, comments: updatedPost.comments || p.comments }
                              : p
                          )
                        );
                      }}
                      onPostDeleted={(deletedPostId) => {
                        setPosts((prev) => prev.filter((p) => p.id !== deletedPostId));
                      }}
                      isLoading={!hasLoadedSession}
                    />
                  )}

                  {currentTab === 'profile' && (
                    <ProfilePage
                      profile={profile}
                      posts={posts}
                      notices={notices}
                      communities={communities}
                      onToggleLike={handleToggleLike}
                      onToggleRepost={handleToggleRepost}
                      onToggleSave={handleToggleSave}
                      onVotePoll={handleVotePoll}
                      onViewUserProfile={(uid) => navigate({ viewingUserId: uid })}
                      onNotify={(msg) => showToast(msg)}
                      onNavigateToSettings={handleSelectSettings}
                      onProfileUpdated={handleProfileUpdated}
                    />
                  )}

                  {currentTab === 'settings' && (
                    <SettingsPage
                      profile={profile}
                      onProfileUpdated={handleProfileUpdated}
                      onOpenAuth={handleOpenAuth}
                      onLogout={handleLogout}
                      onNavigateToTab={handleSelectTab}
                    />
                  )}

                  {currentTab === 'admin' && (
                    <AdminPage
                      profile={profile}
                      onNavigateToTab={handleSelectTab}
                      onConfigChanged={setPlatformConfig}
                      latestReport={latestAdminReport}
                      requestedSection={adminRequestedSection}
                      onClearRequestedSection={() => setAdminRequestedSection(null)}
                    />
                  )}

                  {currentTab === 'mod' && (
                    <ModeratorPage
                      profile={profile}
                      onNavigateToTab={handleSelectTab}
                      latestReport={latestAdminReport}
                    />
                  )}

                  {currentTab === 'policies' && (
                    <PoliciesPage onNavigateToTab={handleSelectTab} />
                  )}
                </Suspense>
              </>
            )}
          </main>

          <MobileBottomNav
            currentTab={currentTab}
            onSelectTab={handleSelectTab}
            onOpenCompose={handleOpenComposeSimple}
            unreadMessagesCount={unreadMessagesCount}
            unreadNoticesCount={unreadNoticesCount}
            platformConfig={platformConfig}
            isAdmin={isAdminUser}
          />
        </>
      )}

      {/* Lazy Modals (Mounted on both Welcome & App views) */}
      <Suspense fallback={null}>
        {isComposeOpen && (
          <ComposeModal
            isOpen={isComposeOpen}
            onClose={handleCloseCompose}
            onAddPost={handleAddPost}
            profile={profile}
            onProfileUpdated={handleProfileUpdated}
            initialLocation={composeInitialLocation}
            platformConfig={platformConfig}
          />
        )}

        {isAuthModalOpen && (
          <AuthModal
            isOpen={isAuthModalOpen}
            onClose={handleCloseAuth}
            onAuthSuccess={handleAuthSuccess}
            initialMode={authModalMode}
          />
        )}

        {viewingUserId && (
          <UserProfileModal
            userId={viewingUserId}
            currentUserId={profile.userId}
            currentUserRole={profile.role}
            onClose={() => navigate({ viewingUserId: null })}
            onMessageUser={handleMessageUser}
            onViewUserProfile={(uid) => navigate({ viewingUserId: uid })}
            onRequireAuth={() => {
              navigate({ viewingUserId: null });
              handleOpenAuth('login');
            }}
            onNotify={(msg) => showToast(msg)}
          />
        )}
      </Suspense>

      <GlassNotification
        message={toastState?.message || null}
        tone={toastState?.tone || 'default'}
        onDismiss={() => setToastState(null)}
      />
    </div>
    </SavedLocationsProvider>
  );
}

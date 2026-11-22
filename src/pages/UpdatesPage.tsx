import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AtSign,
  Bell,
  Bookmark,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  CloudOff,
  Compass,
  Edit2,
  Eye,
  FileText,
  Filter,
  Heart,
  History,
  MapPin,
  MessageCircle,
  Pin,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  AppNotification,
  CampusLandmark,
  CampusLocation,
  LocationFilterKey,
  NavigationTab,
  Notice,
  SavedLocation,
  UpdatesView,
} from '../types';
import { api } from '../api/client';
import { LazyLeafletMap } from '../components/map/LazyLeafletMap';
import { ListRowsSkeleton } from '../components/common/Skeletons';
import { useDebounce } from '../utils/useDebounce';
import { FUTA_CAMPUS_SPOTS } from '../data/futaData';
import { useSavedLocations } from '../utils/useSavedLocations';
import { GlassButton, GlassCard, GlassInput, GlassTab } from '../components/glass';
import { triggerHaptic } from '../utils/haptics';

const LocationViewModal = lazy(() =>
  import('../components/map/LocationViewModal').then((m) => ({ default: m.LocationViewModal }))
);

interface UpdatesPageProps {
  notices: Notice[];
  notifications?: AppNotification[];
  activeView?: UpdatesView;
  onViewChange?: (view: UpdatesView) => void;
  onMarkNotificationRead?: (id: string) => void;
  onMarkAllNotificationsRead?: () => void;
  onNavigateToTab?: (tab: NavigationTab, param?: string) => void;
  onPinLandmarkToDispatch?: (landmark: CampusLocation) => void;
  onFilterFeedByArea?: (areaKey: LocationFilterKey) => void;
}

export const UpdatesPage: React.FC<UpdatesPageProps> = ({
  notices,
  notifications = [],
  activeView: controlledActiveView,
  onViewChange,
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
  onNavigateToTab,
  onPinLandmarkToDispatch,
  onFilterFeedByArea,
}) => {
  const [localActiveView, setLocalActiveView] = useState<UpdatesView>('notifications');
  const activeView = controlledActiveView ?? localActiveView;
  const setActiveView = useCallback(
    (next: UpdatesView) => {
      if (controlledActiveView === undefined) setLocalActiveView(next);
      onViewChange?.(next);
    },
    [controlledActiveView, onViewChange]
  );

  const {
    savedLocations,
    searchHistory,
    isLoading: isLoadingSaved,
    isSyncing,
    isOnline,
    pendingCount,
    syncPendingChanges,
    findMatchingSavedLocation,
    saveLocation,
    pinLocation,
    updateSavedLocation,
    togglePinLocation,
    removeSavedLocation,
    removeSearchHistoryItem,
    clearSearchHistory,
  } = useSavedLocations();

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNoticeId, setExpandedNoticeId] = useState<string | null>('notice-1');

  const [landmarks, setLandmarks] = useState<CampusLandmark[]>([]);
  const [isLoadingLandmarks, setIsLoadingLandmarks] = useState(true);
  const [landmarkSearch, setLandmarkSearch] = useState('');
  const [landmarkZone, setLandmarkZone] = useState<'all' | 'on_campus' | 'off_campus'>('all');
  const [landmarkCategory, setLandmarkCategory] = useState<string>('all');
  const [previewLandmark, setPreviewLandmark] = useState<CampusLocation | null>(null);
  const [previewWithDirections, setPreviewWithDirections] = useState(false);
  const [showInteractiveMap, setShowInteractiveMap] = useState(false);

  // Saved & Pinned Locations tab state
  const [savedSearch, setSavedSearch] = useState('');
  const [savedFilter, setSavedFilter] = useState<'all' | 'pinned' | 'saved_only' | 'off_campus' | 'history'>('all');
  const [showSavedMap, setShowSavedMap] = useState(true);
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const [editLabelDraft, setEditLabelDraft] = useState('');
  const [editNotesDraft, setEditNotesDraft] = useState('');
  const [confirmDeleteSavedId, setConfirmDeleteSavedId] = useState<string | null>(null);

  const debouncedSearchQuery = useDebounce(searchQuery, 200);
  const debouncedLandmarkSearch = useDebounce(landmarkSearch, 200);
  const debouncedSavedSearch = useDebounce(savedSearch, 180);

  // Paginated activity state (seeded with live notifications prop, extended cleanly on scroll)
  const [extraNotifications, setExtraNotifications] = useState<AppNotification[]>([]);
  const [notifOffset, setNotifOffset] = useState(notifications.length);
  const [hasMoreNotifs, setHasMoreNotifs] = useState(notifications.length >= 20);
  const [isLoadingMoreNotifs, setIsLoadingMoreNotifs] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const notifLoadLockRef = useRef(false);
  const notifSentinelRef = useRef<HTMLDivElement | null>(null);

  const mergedNotifications = useMemo(() => {
    const map = new Map<string, AppNotification>();
    notifications.forEach((n) => map.set(n.id, n));
    extraNotifications.forEach((n) => {
      if (!map.has(n.id)) map.set(n.id, n);
    });
    return Array.from(map.values());
  }, [notifications, extraNotifications]);

  useEffect(() => {
    setNotifOffset((prev) => Math.max(prev, notifications.length));
    if (notifications.length >= 20 && extraNotifications.length === 0) {
      setHasMoreNotifs(true);
    }
  }, [notifications.length, extraNotifications.length]);

  const handleLoadMoreNotifications = useCallback(async () => {
    if (notifLoadLockRef.current || isLoadingMoreNotifs || !hasMoreNotifs) return;
    notifLoadLockRef.current = true;
    setIsLoadingMoreNotifs(true);
    setNotifError(null);
    try {
      const page = await api.getNotificationsPaginated({
        unreadOnly,
        limit: 20,
        offset: notifOffset,
      });
      setExtraNotifications((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const additions = (page.notifications || []).filter((item) => !seen.has(item.id));
        return [...prev, ...additions];
      });
      setHasMoreNotifs(Boolean(page.hasMore));
      setNotifOffset(page.nextOffset ?? notifOffset + (page.notifications?.length || 0));
    } catch (err: any) {
      setNotifError(err?.message || 'Unable to load older notifications.');
    } finally {
      notifLoadLockRef.current = false;
      setIsLoadingMoreNotifs(false);
    }
  }, [hasMoreNotifs, isLoadingMoreNotifs, notifOffset, unreadOnly]);

  useEffect(() => {
    if (activeView !== 'notifications' || !hasMoreNotifs || isLoadingMoreNotifs || notifError) return;
    const target = notifSentinelRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          handleLoadMoreNotifications();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [activeView, handleLoadMoreNotifications, hasMoreNotifs, isLoadingMoreNotifs, notifError]);

  useEffect(() => {
    let isMounted = true;
    const loadFallback = (): CampusLandmark[] =>
      FUTA_CAMPUS_SPOTS.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category as any,
        campusZone: s.isOffCampus ? 'Off-Campus (South Gate / Town)' : 'On-Campus (Obanla)',
        coordinates: s.coordinates,
        description: s.description,
        isOffCampus: Boolean(s.isOffCampus),
        pinnedCount: 12,
      }));

    api
      .getLandmarks()
      .then((data) => {
        if (isMounted) setLandmarks(data.length > 0 ? data : loadFallback());
      })
      .catch(() => {
        if (isMounted) setLandmarks(loadFallback());
      })
      .finally(() => {
        if (isMounted) setIsLoadingLandmarks(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const filteredNotices = useMemo(() => {
    const q = debouncedSearchQuery.trim().toLowerCase();
    return notices.filter((notice) => {
      const matchesCategory = filterCategory === 'all' || notice.category === filterCategory;
      const matchesSearch =
        q === '' ||
        notice.title.toLowerCase().includes(q) ||
        notice.summary.toLowerCase().includes(q) ||
        notice.source.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [debouncedSearchQuery, filterCategory, notices]);

  const filteredNotifications = useMemo(
    () => mergedNotifications.filter((n) => (!unreadOnly ? true : !n.isRead)),
    [mergedNotifications, unreadOnly]
  );

  const unreadNotifsCount = useMemo(
    () => mergedNotifications.filter((n) => !n.isRead).length,
    [mergedNotifications]
  );

  const filteredLandmarks = useMemo(() => {
    const q = debouncedLandmarkSearch.trim().toLowerCase();
    return landmarks.filter((l) => {
      const matchesZone =
        landmarkZone === 'all' ||
        (landmarkZone === 'on_campus' && !l.isOffCampus) ||
        (landmarkZone === 'off_campus' && l.isOffCampus);
      const matchesCategory = landmarkCategory === 'all' || l.category === landmarkCategory;
      const matchesSearch =
        q === '' ||
        l.name.toLowerCase().includes(q) ||
        l.campusZone.toLowerCase().includes(q) ||
        (l.description && l.description.toLowerCase().includes(q));
      return matchesZone && matchesCategory && matchesSearch;
    });
  }, [debouncedLandmarkSearch, landmarkCategory, landmarkZone, landmarks]);

  const filteredSavedItems = useMemo(() => {
    const q = debouncedSavedSearch.trim().toLowerCase();
    return savedLocations.filter((item) => {
      if (savedFilter === 'pinned' && !item.isPinned) return false;
      if (savedFilter === 'saved_only' && item.isPinned) return false;
      if (savedFilter === 'off_campus' && !item.isOffCampus) return false;
      if (!q) return true;
      return (
        item.displayName.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        (item.notes || '').toLowerCase().includes(q) ||
        (item.address || '').toLowerCase().includes(q) ||
        (item.description || '').toLowerCase().includes(q) ||
        (item.areaLabel || '').toLowerCase().includes(q)
      );
    });
  }, [debouncedSavedSearch, savedFilter, savedLocations]);

  const filteredSearchHistory = useMemo(() => {
    const q = debouncedSavedSearch.trim().toLowerCase();
    return searchHistory.filter((item) => {
      if (!q) return true;
      return (
        item.queryText.toLowerCase().includes(q) ||
        (item.selectedName || '').toLowerCase().includes(q) ||
        (item.selectedAddress || '').toLowerCase().includes(q) ||
        (item.areaLabel || '').toLowerCase().includes(q)
      );
    });
  }, [debouncedSavedSearch, searchHistory]);

  const handleNotificationClick = (n: AppNotification) => {
    triggerHaptic('tap');
    if (onMarkNotificationRead && !n.isRead) {
      onMarkNotificationRead(n.id);
    }
    if (!onNavigateToTab || !n.link) return;

    if (n.link.startsWith('/home')) onNavigateToTab('home', n.link);
    else if (n.link.startsWith('/chats')) onNavigateToTab('chats', n.link);
    else if (n.link.startsWith('/communities')) onNavigateToTab('communities', n.link);
    else if (n.link.startsWith('/admin')) onNavigateToTab('admin', n.link);
    else if (n.link.startsWith('/updates')) setActiveView('bulletins');
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'like':
        return <Heart className="w-4 h-4 text-[#D98BA5]" />;
      case 'comment':
      case 'reply':
        return <MessageCircle className="w-4 h-4 text-[#171613] dark:text-[#F5EFE3]" />;
      case 'mention':
        return <AtSign className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />;
      case 'message':
      case 'group':
        return <Users className="w-4 h-4 text-[#171613] dark:text-[#F5EFE3]" />;
      case 'announcement':
        return <FileText className="w-4 h-4 text-[#171613] dark:text-[#F5EFE3]" />;
      case 'system':
        return <ShieldAlert className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />;
      case 'account':
        return <ShieldCheck className="w-4 h-4 text-[#D98BA5]" />;
      default:
        return <Bell className="w-4 h-4 text-[#171613] dark:text-[#F5EFE3]" />;
    }
  };

  const mapMarkers = useMemo(() => {
    const merged = new Map<
      string,
      {
        id: string;
        name: string;
        coordinates: [number, number];
        category?: string;
        description?: string;
        pinVariant?: 'default' | 'saved' | 'pinned';
      }
    >();

    filteredLandmarks.forEach((l) => {
      const savedMatch = findMatchingSavedLocation(l);
      merged.set(`${l.coordinates[0].toFixed(4)},${l.coordinates[1].toFixed(4)}`, {
        id: l.id,
        name: savedMatch ? savedMatch.displayName : l.name,
        coordinates: l.coordinates,
        category: l.category,
        description: l.description,
        pinVariant: savedMatch ? (savedMatch.isPinned ? 'pinned' : 'saved') : 'default',
      });
    });

    savedLocations.forEach((item) => {
      const coordKey = `${item.coordinates[0].toFixed(4)},${item.coordinates[1].toFixed(4)}`;
      if (!merged.has(coordKey)) {
        merged.set(coordKey, {
          id: item.id,
          name: item.displayName,
          coordinates: item.coordinates,
          category: item.category,
          description: item.notes || item.description || item.address || item.areaLabel,
          pinVariant: item.isPinned ? 'pinned' : 'saved',
        });
      }
    });

    return Array.from(merged.values());
  }, [filteredLandmarks, findMatchingSavedLocation, savedLocations]);

  const savedMapMarkers = useMemo(
    () =>
      filteredSavedItems.map((item) => ({
        id: item.id,
        name: item.displayName,
        coordinates: item.coordinates,
        category: item.category,
        description: item.notes || item.description || item.address || item.areaLabel,
        pinVariant: (item.isPinned ? 'pinned' : 'saved') as 'pinned' | 'saved',
      })),
    [filteredSavedItems]
  );

  const savedMapCenter: [number, number] =
    filteredSavedItems[0]?.coordinates || savedLocations[0]?.coordinates || [7.3034, 5.1386];

  const handleStartEditSaved = (item: SavedLocation) => {
    triggerHaptic('tap');
    setEditingSavedId(item.id);
    setEditLabelDraft(item.customLabel || item.name);
    setEditNotesDraft(item.notes || '');
  };

  const handleSaveEditSaved = async (item: SavedLocation) => {
    triggerHaptic('success');
    const trimmedLabel = editLabelDraft.trim();
    const trimmedNotes = editNotesDraft.trim();
    await updateSavedLocation(item.id, {
      customLabel: trimmedLabel && trimmedLabel !== item.name ? trimmedLabel : null,
      name: trimmedLabel && item.source === 'manual' ? trimmedLabel : undefined,
      notes: trimmedNotes || null,
    });
    setEditingSavedId(null);
  };

  const toCampusLocation = (item: SavedLocation): CampusLocation => ({
    id: item.landmarkId || item.id,
    name: item.displayName,
    category: item.category,
    coordinates: item.coordinates,
    description: item.notes || item.description || item.address || item.areaLabel,
    address: item.address,
    isOffCampus: item.isOffCampus,
  });

  const pinnedCount = useMemo(
    () => savedLocations.filter((s) => s.isPinned).length,
    [savedLocations]
  );

  return (
    <div className="w-full flex justify-center px-3.5 sm:px-4 py-6 md:py-8">
      <div className="w-full max-w-4xl flex flex-col gap-6 min-w-0">
        {/* Header & Switcher */}
        <div className="border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-4 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-[#82796F] dark:text-[#A89F95]">
                Community Feed &amp; Spots
              </div>
              <h1 className="font-serif text-2xl md:text-3xl font-bold tracking-tight text-[#171613] dark:text-[#F5EFE3] mt-1">
                Updates &amp; Landmarks
              </h1>
              <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-1">
                Live social activity, community announcements, landmarks, and your synced saved spots.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto scrollbar-none pb-0.5">
            <GlassTab
              activeId={activeView}
              onChange={(val) => setActiveView(val as UpdatesView)}
              items={[
                {
                  id: 'notifications',
                  label: 'Activity',
                  count: unreadNotifsCount > 0 ? unreadNotifsCount : undefined,
                  icon: <Bell className="w-3.5 h-3.5" />,
                },
                {
                  id: 'bulletins',
                  label: 'Announcements',
                  count: notices.length,
                  icon: <FileText className="w-3.5 h-3.5" />,
                },
                {
                  id: 'landmarks',
                  label: 'Landmarks',
                  count: landmarks.length,
                  icon: <MapPin className="w-3.5 h-3.5" />,
                },
                {
                  id: 'saved',
                  label: 'Saved Spots',
                  count: savedLocations.length > 0 ? savedLocations.length : undefined,
                  icon: <Bookmark className="w-3.5 h-3.5" />,
                },
              ]}
            />
          </div>
        </div>

        {/* 1. ACTIVITY NOTIFICATIONS */}
        {activeView === 'notifications' && (
          <div className="flex flex-col gap-4 animate-sb-in">
            <GlassCard tone="subtle" padding="sm" className="flex items-center justify-between gap-3 flex-wrap">
              <GlassTab
                activeId={unreadOnly ? 'unread' : 'all'}
                onChange={(val) => setUnreadOnly(val === 'unread')}
                items={[
                  { id: 'all', label: 'All Activity' },
                  { id: 'unread', label: 'Unread', count: unreadNotifsCount },
                ]}
              />

              {unreadNotifsCount > 0 && onMarkAllNotificationsRead && (
                <GlassButton variant="ghost" size="sm" onClick={onMarkAllNotificationsRead}>
                  <CheckCheck className="w-3.5 h-3.5 text-[#C4718E]" />
                  <span>Mark all read</span>
                </GlassButton>
              )}
            </GlassCard>

            {filteredNotifications.length > 0 ? (
              <>
                <GlassCard tone="cream" padding="none" className="divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10 overflow-hidden">
                  {filteredNotifications.map((n) => (
                    <div
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className={`p-4 flex items-start gap-3.5 transition-colors cursor-pointer ${
                        !n.isRead
                          ? 'bg-[#F6E2E6]/45 hover:bg-[#F6E2E6]/65 dark:bg-[#D98BA5]/15 dark:hover:bg-[#D98BA5]/22'
                          : 'hover:bg-[#FFFCF7]/70 dark:hover:bg-[#23211C]/70'
                      }`}
                    >
                      <div className="w-9 h-9 rounded-xl bg-[#FFFCF7] dark:bg-[#23211C] flex items-center justify-center shrink-0 border border-[#171613]/10 dark:border-[#F5EFE3]/12">
                        {getNotificationIcon(n.type)}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-xs ${!n.isRead ? 'font-bold text-[#171613] dark:text-[#F5EFE3]' : 'font-medium text-[#171613]/85 dark:text-[#F5EFE3]/85'}`}>
                            {n.title}
                          </span>
                          <span className="text-[10px] font-mono tabular-nums text-[#82796F] dark:text-[#A89F95] shrink-0">
                            {new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>

                        <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-1 line-clamp-2">{n.body}</p>

                        <div className="flex items-center gap-2 mt-2 text-[10px] text-[#82796F] dark:text-[#A89F95]">
                          <span className="uppercase tracking-wider font-mono text-[#171613] dark:text-[#F5EFE3]">{n.type}</span>
                          {n.link && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-[#C4718E] dark:text-[#E5A4BA]">Open →</span>
                            </>
                          )}
                        </div>
                      </div>

                      {!n.isRead && (
                        <span className="w-2.5 h-2.5 rounded-full bg-[#D98BA5] shrink-0 mt-2" title="Unread" />
                      )}
                    </div>
                  ))}
                </GlassCard>

                {isLoadingMoreNotifs && <ListRowsSkeleton rows={2} />}

                {notifError && (
                  <GlassCard tone="pink" padding="md" className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 text-[#171613] dark:text-[#F5EFE3]">
                      <AlertCircle className="w-4 h-4 text-[#C4718E] shrink-0" />
                      <span>{notifError}</span>
                    </div>
                    <GlassButton variant="black" size="sm" onClick={handleLoadMoreNotifications}>
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry</span>
                    </GlassButton>
                  </GlassCard>
                )}

                {hasMoreNotifs && !notifError && (
                  <div ref={notifSentinelRef} className="h-4 w-full" aria-hidden="true" />
                )}
              </>
            ) : (
              <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                {unreadOnly
                  ? 'No unread notifications right now.'
                  : 'No notifications yet. Activity from posts, replies, and chats will appear here.'}
              </GlassCard>
            )}
          </div>
        )}

        {/* 2. OFFICIAL BULLETINS */}
        {activeView === 'bulletins' && (
          <div className="flex flex-col gap-4 animate-sb-in">
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              <div className="flex-1">
                <GlassInput
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search circulars, senate memos, or hall updates..."
                  leftIcon={<Search className="w-4 h-4" />}
                />
              </div>

              <div className="overflow-x-auto scrollbar-none">
                <GlassTab
                  activeId={filterCategory}
                  onChange={setFilterCategory}
                  items={[
                    { id: 'all', label: 'All' },
                    { id: 'academic', label: 'Senate' },
                    { id: 'hostel', label: 'Halls' },
                    { id: 'administrative', label: 'SUG & Admin' },
                  ]}
                />
              </div>
            </div>

            <div className="flex flex-col gap-4">
              {filteredNotices.length > 0 ? (
                filteredNotices.map((notice) => {
                  const isExpanded = expandedNoticeId === notice.id;
                  return (
                    <GlassCard key={notice.id} tone="subtle" padding="md">
                      <div className="flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] mb-2 flex-wrap gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1">
                            {notice.source}
                            {notice.verified && <ShieldCheck className="w-3.5 h-3.5 text-[#D98BA5]" />}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="capitalize">{notice.category}</span>
                        </div>
                        <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                          <span>{notice.date}</span>
                          <span aria-hidden="true">·</span>
                          <span>{notice.readTime}</span>
                        </div>
                      </div>

                      <h2 className="font-serif text-lg md:text-xl font-bold text-[#171613] dark:text-[#F5EFE3] leading-snug">
                        {notice.title}
                      </h2>

                      <p className="text-xs md:text-sm text-[#171613]/80 dark:text-[#F5EFE3]/85 mt-2 leading-relaxed">
                        {notice.summary}
                      </p>

                      {isExpanded && (
                        <div className="mt-4 bg-[#FFFCF7]/80 dark:bg-[#23211C] p-4 rounded-xl border border-[#171613]/10 dark:border-[#F5EFE3]/10">
                          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[#82796F] dark:text-[#A89F95] mb-2">
                            <FileText className="w-3.5 h-3.5 text-[#D98BA5]" />
                            <span>Community Notice &amp; Digest</span>
                          </div>
                          <div className="font-serif text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] leading-relaxed">
                            <p>{notice.fullBody}</p>
                          </div>
                          <div className="mt-3 pt-2 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono">
                            <span>Schoolbackdoor Independent Digest</span>
                            <span className="text-[#171613] dark:text-[#F5EFE3] font-sans font-semibold">Community Bulletin</span>
                          </div>
                        </div>
                      )}

                      <div className="mt-3.5 pt-2 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('tap');
                            setExpandedNoticeId(isExpanded ? null : notice.id);
                          }}
                          className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] hover:text-[#C4718E] dark:hover:text-[#E5A4BA] flex items-center gap-1 transition-colors cursor-pointer py-1.5"
                        >
                          <span>{isExpanded ? 'Collapse Notice' : 'Read Full Notice'}</span>
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                        {notice.urgency === 'high' && (
                          <span className="text-[10px] font-mono font-bold text-[#171613] dark:text-[#F5EFE3] bg-[#F6E2E6] dark:bg-[#D98BA5]/25 border border-[#D98BA5]/60 px-2.5 py-0.5 rounded-md whitespace-nowrap shrink-0">
                            Important
                          </span>
                        )}
                      </div>
                    </GlassCard>
                  );
                })
              ) : (
                <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                  No community announcements match your query.
                </GlassCard>
              )}
            </div>
          </div>
        )}

        {/* 3. CAMPUS LANDMARKS */}
        {activeView === 'landmarks' && (
          <div className="flex flex-col gap-4 animate-sb-in">
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              <div className="flex-1">
                <GlassInput
                  type="text"
                  value={landmarkSearch}
                  onChange={(e) => setLandmarkSearch(e.target.value)}
                  placeholder="Identify landmark (e.g. ETF 3, South Gate, SEET, Titans)..."
                  leftIcon={<Search className="w-4 h-4" />}
                />
              </div>

              <div className="overflow-x-auto scrollbar-none">
                <GlassTab
                  activeId={landmarkZone}
                  onChange={(v) => setLandmarkZone(v as any)}
                  items={[
                    { id: 'all', label: 'All Spots' },
                    { id: 'on_campus', label: 'Obanla' },
                    { id: 'off_campus', label: 'Off-Campus' },
                  ]}
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-xs flex-wrap gap-2">
              <div className="overflow-x-auto scrollbar-none max-w-full">
                <GlassTab
                  activeId={landmarkCategory}
                  onChange={setLandmarkCategory}
                  items={[
                    { id: 'all', label: 'All Categories' },
                    { id: 'academic', label: 'Faculties' },
                    { id: 'hostel', label: 'Hostels' },
                    { id: 'gate', label: 'Gates' },
                  ]}
                />
              </div>

              <GlassButton
                variant={showInteractiveMap ? 'black' : 'glass'}
                size="sm"
                onClick={() => setShowInteractiveMap(!showInteractiveMap)}
              >
                <Compass className="w-3.5 h-3.5 text-[#D98BA5]" />
                <span>{showInteractiveMap ? 'Hide Map Overview' : 'Interactive Map Overview'}</span>
              </GlassButton>
            </div>

            {showInteractiveMap && (
              <GlassCard tone="cream" padding="sm" className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] px-1 flex-wrap gap-2">
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                    Campus &amp; Saved Spots Map
                  </span>
                  <span className="text-[10px] font-mono">
                    OpenStreetMap · Rose = Pinned, White = Saved
                  </span>
                </div>
                <div className="rounded-xl overflow-hidden border border-[#171613]/12 dark:border-[#F5EFE3]/12">
                  <LazyLeafletMap center={[7.3048, 5.136]} zoom={15} markers={mapMarkers} height="320px" />
                </div>
              </GlassCard>
            )}

            {isLoadingLandmarks && landmarks.length === 0 ? (
              <ListRowsSkeleton rows={4} />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {filteredLandmarks.map((landmark) => {
                  const asLocation: CampusLocation = {
                    id: landmark.id,
                    name: landmark.name,
                    category: landmark.category,
                    coordinates: landmark.coordinates,
                    description: landmark.description,
                    isOffCampus: landmark.isOffCampus,
                  };
                  const savedMatch = findMatchingSavedLocation(landmark);

                  return (
                    <GlassCard key={landmark.id} tone="subtle" padding="md" className="flex flex-col justify-between gap-3">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-2 text-[11px] text-[#82796F] dark:text-[#A89F95]">
                          <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                            {landmark.isOffCampus ? 'Off-Campus Hub' : 'On-Campus (Obanla)'}
                          </span>
                          <span className="capitalize">{landmark.category}</span>
                        </div>

                        <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] leading-snug">
                          {landmark.name}
                        </h3>

                        {landmark.description && (
                          <p className="text-xs text-[#82796F] dark:text-[#A89F95] line-clamp-2">{landmark.description}</p>
                        )}
                      </div>

                      <div className="pt-2.5 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center justify-between text-xs gap-2 flex-wrap">
                        <div className="flex items-center gap-1 font-mono text-[11px] text-[#82796F] dark:text-[#A89F95] tabular-nums">
                          <Pin className="w-3 h-3 text-[#D98BA5]" />
                          <span>{landmark.pinnedCount || 0} dispatches</span>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                          <GlassButton
                            variant={savedMatch ? 'black' : 'glass'}
                            size="sm"
                            onClick={() => {
                              triggerHaptic('tap');
                              if (savedMatch) {
                                void removeSavedLocation(savedMatch.id);
                              } else {
                                void saveLocation({
                                  landmarkId: landmark.id,
                                  name: landmark.name,
                                  category: landmark.category,
                                  campusZone: landmark.campusZone,
                                  description: landmark.description,
                                  coordinates: landmark.coordinates,
                                  isOffCampus: landmark.isOffCampus,
                                  isPinned: false,
                                  source: 'landmark',
                                });
                              }
                            }}
                          >
                            <Bookmark className={`w-3 h-3 ${savedMatch ? 'fill-current text-[#D98BA5]' : ''}`} />
                            <span>{savedMatch ? 'Saved' : 'Save'}</span>
                          </GlassButton>

                          <GlassButton
                            variant="glass"
                            size="sm"
                            onClick={() => {
                              setPreviewWithDirections(false);
                              setPreviewLandmark(asLocation);
                            }}
                          >
                            <Eye className="w-3 h-3" />
                            <span>Map</span>
                          </GlassButton>

                          {onPinLandmarkToDispatch && (
                            <GlassButton
                              variant="pink"
                              size="sm"
                              onClick={() => {
                                void pinLocation(asLocation, 'landmark', { silent: true });
                                onPinLandmarkToDispatch(asLocation);
                              }}
                            >
                              <Send className="w-3 h-3" />
                              <span>Post</span>
                            </GlassButton>
                          )}
                        </div>
                      </div>
                    </GlassCard>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 4. SAVED & PINNED LOCATIONS + RECENT SEARCHES */}
        {activeView === 'saved' && (
          <div className="flex flex-col gap-4 animate-sb-in">
            {/* Sync Status & Summary Strip */}
            <GlassCard tone="cream" padding="sm" className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1.5 font-semibold text-[#171613] dark:text-[#F5EFE3]">
                  <Pin className="w-3.5 h-3.5 text-[#C4718E] fill-current" />
                  <span>{pinnedCount} Pinned</span>
                </span>
                <span className="text-[#82796F] dark:text-[#A89F95]">·</span>
                <span className="inline-flex items-center gap-1.5 font-medium text-[#171613] dark:text-[#F5EFE3]">
                  <Bookmark className="w-3.5 h-3.5 text-[#D98BA5]" />
                  <span>{savedLocations.length} Total Saved</span>
                </span>
                <span className="text-[#82796F] dark:text-[#A89F95]">·</span>
                <span className="inline-flex items-center gap-1.5 text-[#82796F] dark:text-[#A89F95]">
                  <History className="w-3.5 h-3.5" />
                  <span>{searchHistory.length} Recent Searches</span>
                </span>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {!isOnline && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[#F6E2E6] dark:bg-[#D98BA5]/20 text-[11px] font-medium text-[#171613] dark:text-[#F5EFE3]">
                    <CloudOff className="w-3 h-3 text-[#C4718E]" />
                    <span>Offline Cache Active</span>
                  </span>
                )}
                {pendingCount > 0 && (
                  <GlassButton
                    variant="pink"
                    size="sm"
                    onClick={() => void syncPendingChanges()}
                    loading={isSyncing}
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Sync {pendingCount} Queued</span>
                  </GlassButton>
                )}
                <GlassButton
                  variant={showSavedMap ? 'black' : 'glass'}
                  size="sm"
                  onClick={() => setShowSavedMap((v) => !v)}
                >
                  <Compass className="w-3.5 h-3.5 text-[#D98BA5]" />
                  <span>{showSavedMap ? 'Hide Map' : 'Show Map'}</span>
                </GlassButton>
              </div>
            </GlassCard>

            {/* Search & Filter Row */}
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              <div className="flex-1">
                <GlassInput
                  type="text"
                  value={savedSearch}
                  onChange={(e) => setSavedSearch(e.target.value)}
                  placeholder="Search saved spots, custom labels, notes, or search history..."
                  leftIcon={<Search className="w-4 h-4" />}
                />
              </div>

              <div className="overflow-x-auto scrollbar-none">
                <GlassTab
                  activeId={savedFilter}
                  onChange={(val) => setSavedFilter(val as any)}
                  items={[
                    { id: 'all', label: 'All', count: savedLocations.length },
                    { id: 'pinned', label: 'Pinned', count: pinnedCount },
                    { id: 'saved_only', label: 'Saved Only' },
                    { id: 'off_campus', label: 'Off-Campus' },
                    { id: 'history', label: 'Recent Searches', count: searchHistory.length },
                  ]}
                />
              </div>
            </div>

            {/* Saved Locations Map Overview */}
            {showSavedMap && savedFilter !== 'history' && savedLocations.length > 0 && (
              <GlassCard tone="cream" padding="sm" className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] px-1 flex-wrap gap-2">
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                    Your Saved &amp; Pinned Map ({savedMapMarkers.length})
                  </span>
                  <span className="text-[10px] font-mono">
                    Synced across devices · Private to your account
                  </span>
                </div>
                <div className="rounded-xl overflow-hidden border border-[#171613]/12 dark:border-[#F5EFE3]/12">
                  <LazyLeafletMap
                    center={savedMapCenter}
                    zoom={14}
                    markers={savedMapMarkers}
                    height="270px"
                  />
                </div>
              </GlassCard>
            )}

            {/* Saved & Pinned Cards */}
            {savedFilter !== 'history' && (
              <>
                {isLoadingSaved && savedLocations.length === 0 ? (
                  <ListRowsSkeleton rows={3} />
                ) : filteredSavedItems.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    {filteredSavedItems.map((item) => {
                      const isEditing = editingSavedId === item.id;
                      const asLocation = toCampusLocation(item);
                      const feedTargetArea: LocationFilterKey =
                        (item.areaKey as LocationFilterKey) ||
                        (item.isOffCampus ? 'off_campus' : 'on_campus');

                      return (
                        <GlassCard
                          key={item.id}
                          tone={item.isPinned ? 'pink' : 'subtle'}
                          padding="md"
                          className="flex flex-col justify-between gap-3"
                        >
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between gap-2 text-[11px] flex-wrap">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold text-[10px] uppercase tracking-wider ${
                                    item.isPinned
                                      ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613]'
                                      : 'bg-[#FFFCF7] dark:bg-[#23211C] text-[#171613] dark:text-[#F5EFE3] border border-[#171613]/10 dark:border-white/15'
                                  }`}
                                >
                                  {item.isPinned ? (
                                    <>
                                      <Pin className="w-2.5 h-2.5 fill-current text-[#D98BA5]" />
                                      <span>Pinned</span>
                                    </>
                                  ) : (
                                    <>
                                      <Bookmark className="w-2.5 h-2.5 text-[#C4718E]" />
                                      <span>Saved</span>
                                    </>
                                  )}
                                </span>
                                <span className="text-[#82796F] dark:text-[#A89F95] font-medium">
                                  {item.areaLabel || (item.isOffCampus ? 'Off-Campus' : 'Campus')}
                                </span>
                                {item.pendingSync && (
                                  <span className="text-[10px] font-mono text-[#C4718E]">Pending Sync</span>
                                )}
                              </div>

                              <span className="text-[10px] font-mono text-[#82796F] dark:text-[#A89F95] tabular-nums">
                                {item.coordinates[0].toFixed(4)}° N, {item.coordinates[1].toFixed(4)}° E
                              </span>
                            </div>

                            {isEditing ? (
                              <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-[#FFFCF7]/80 dark:bg-[#23211C] border border-[#171613]/10 dark:border-white/10">
                                <div className="flex flex-col gap-1">
                                  <label className="text-[10px] font-mono uppercase text-[#82796F] dark:text-[#A89F95]">
                                    Custom Label
                                  </label>
                                  <input
                                    type="text"
                                    value={editLabelDraft}
                                    onChange={(e) => setEditLabelDraft(e.target.value)}
                                    maxLength={120}
                                    placeholder={item.name}
                                    className="w-full glass-input rounded-lg px-2.5 py-1.5 text-xs text-[#171613] dark:text-[#F5EFE3]"
                                  />
                                </div>
                                <div className="flex flex-col gap-1">
                                  <label className="text-[10px] font-mono uppercase text-[#82796F] dark:text-[#A89F95]">
                                    Personal Note (optional)
                                  </label>
                                  <input
                                    type="text"
                                    value={editNotesDraft}
                                    onChange={(e) => setEditNotesDraft(e.target.value)}
                                    maxLength={300}
                                    placeholder="Lodge gate code, study spot, landmark note..."
                                    className="w-full glass-input rounded-lg px-2.5 py-1.5 text-xs text-[#171613] dark:text-[#F5EFE3]"
                                  />
                                </div>
                                <div className="flex items-center justify-end gap-2 pt-1">
                                  <GlassButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingSavedId(null)}
                                  >
                                    Cancel
                                  </GlassButton>
                                  <GlassButton
                                    variant="pink"
                                    size="sm"
                                    onClick={() => void handleSaveEditSaved(item)}
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                    <span>Save</span>
                                  </GlassButton>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div>
                                  <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] leading-snug">
                                    {item.displayName}
                                  </h3>
                                  {item.customLabel && item.customLabel !== item.name && (
                                    <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5">
                                      Spot: {item.name}
                                    </div>
                                  )}
                                </div>

                                {item.notes && (
                                  <p className="text-xs text-[#171613]/85 dark:text-[#F5EFE3]/85 bg-[#FFFCF7]/70 dark:bg-black/20 rounded-xl px-2.5 py-1.5">
                                    {item.notes}
                                  </p>
                                )}

                                {(item.address || item.description) && (
                                  <p className="text-xs text-[#82796F] dark:text-[#A89F95] line-clamp-2">
                                    {item.address || item.description}
                                  </p>
                                )}
                              </>
                            )}
                          </div>

                          <div className="pt-2.5 border-t border-[#171613]/10 dark:border-white/10 flex items-center justify-between gap-1.5 flex-wrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <GlassButton
                                variant={item.isPinned ? 'black' : 'glass'}
                                size="sm"
                                onClick={() => void togglePinLocation(item.id)}
                                title={item.isPinned ? 'Unpin' : 'Pin'}
                              >
                                <Pin className={`w-3 h-3 ${item.isPinned ? 'fill-current text-[#D98BA5]' : ''}`} />
                                <span>{item.isPinned ? 'Unpin' : 'Pin'}</span>
                              </GlassButton>

                              <GlassButton
                                variant="glass"
                                size="sm"
                                onClick={() => handleStartEditSaved(item)}
                                title="Rename or edit notes"
                              >
                                <Edit2 className="w-3 h-3" />
                                <span>Rename</span>
                              </GlassButton>

                              {onFilterFeedByArea && (
                                <GlassButton
                                  variant="glass"
                                  size="sm"
                                  onClick={() => onFilterFeedByArea(feedTargetArea)}
                                  title="Browse feed posts around this area"
                                >
                                  <Filter className="w-3 h-3 text-[#C4718E]" />
                                  <span>Feed</span>
                                </GlassButton>
                              )}

                              {onPinLandmarkToDispatch && (
                                <GlassButton
                                  variant="pink"
                                  size="sm"
                                  onClick={() => {
                                    void updateSavedLocation(item.id, { markUsed: true });
                                    onPinLandmarkToDispatch(asLocation);
                                  }}
                                >
                                  <Send className="w-3 h-3" />
                                  <span>Post</span>
                                </GlassButton>
                              )}
                            </div>

                            <div className="flex items-center gap-1">
                              <GlassButton
                                variant="glass"
                                size="sm"
                                onClick={() => {
                                  setPreviewWithDirections(false);
                                  setPreviewLandmark(asLocation);
                                }}
                                title="View on map & directions"
                              >
                                <Eye className="w-3 h-3" />
                              </GlassButton>

                              {confirmDeleteSavedId === item.id ? (
                                <GlassButton
                                  variant="pink"
                                  size="sm"
                                  onClick={() => {
                                    void removeSavedLocation(item.id);
                                    setConfirmDeleteSavedId(null);
                                  }}
                                >
                                  <span>Confirm</span>
                                </GlassButton>
                              ) : (
                                <GlassButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setConfirmDeleteSavedId(item.id)}
                                  title="Remove saved location"
                                >
                                  <Trash2 className="w-3.5 h-3.5 text-[#C4718E]" />
                                </GlassButton>
                              )}
                            </div>
                          </div>
                        </GlassCard>
                      );
                    })}
                  </div>
                ) : (
                  <GlassCard tone="subtle" padding="lg" className="text-center flex flex-col items-center gap-2.5 text-xs text-[#82796F] dark:text-[#A89F95]">
                    <MapPin className="w-6 h-6 text-[#D98BA5]" />
                    <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                      {savedSearch ? 'No saved locations match your search.' : 'No saved or pinned locations yet.'}
                    </span>
                    <p className="max-w-md leading-relaxed">
                      Save locations when searching on the map, or attach any campus or off-campus spot to a post or chat to automatically keep it here across devices.
                    </p>
                    <GlassButton variant="glass" size="sm" onClick={() => setActiveView('landmarks')}>
                      <MapPin className="w-3.5 h-3.5 text-[#C4718E]" />
                      <span>Browse Campus &amp; Off-Campus Landmarks</span>
                    </GlassButton>
                  </GlassCard>
                )}
              </>
            )}

            {/* Recent Search History Section */}
            {(savedFilter === 'history' || (savedFilter === 'all' && filteredSearchHistory.length > 0)) && (
              <GlassCard tone="cream" padding="md" className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <History className="w-4 h-4 text-[#C4718E]" />
                    <h2 className="font-serif text-base font-bold text-[#171613] dark:text-[#F5EFE3]">
                      Recent Location Searches
                    </h2>
                  </div>

                  {searchHistory.length > 0 && (
                    <GlassButton variant="ghost" size="sm" onClick={() => void clearSearchHistory()}>
                      <Trash2 className="w-3.5 h-3.5 text-[#C4718E]" />
                      <span>Clear History</span>
                    </GlassButton>
                  )}
                </div>

                {filteredSearchHistory.length === 0 ? (
                  <p className="text-xs text-[#82796F] dark:text-[#A89F95] py-2">
                    No recent location searches recorded yet.
                  </p>
                ) : (
                  <div className="divide-y divide-[#171613]/8 dark:divide-white/10">
                    {filteredSearchHistory.map((hist) => {
                      const alreadySaved = hist.coordinates
                        ? findMatchingSavedLocation({
                            coordinates: hist.coordinates,
                            landmarkId: hist.landmarkId,
                          })
                        : undefined;

                      return (
                        <div
                          key={hist.id}
                          className="py-2.5 flex items-center justify-between gap-2 flex-wrap"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (hist.coordinates) {
                                setPreviewWithDirections(false);
                                setPreviewLandmark({
                                  id: hist.landmarkId || hist.id,
                                  name: hist.selectedName || hist.queryText,
                                  category:
                                    (hist.selectedCategory as CampusLocation['category']) ||
                                    'off_campus',
                                  coordinates: hist.coordinates,
                                  description: hist.selectedDescription || hist.selectedAddress,
                                  address: hist.selectedAddress,
                                  isOffCampus: hist.isOffCampus,
                                });
                              } else {
                                setSavedSearch(hist.queryText);
                              }
                            }}
                            className="flex items-start gap-2.5 text-left min-w-0 flex-1 cursor-pointer"
                          >
                            <Clock className="w-4 h-4 text-[#82796F] shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] truncate">
                                {hist.selectedName || hist.queryText}
                              </div>
                              <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] truncate">
                                {hist.selectedAddress ||
                                  hist.areaLabel ||
                                  `Query: "${hist.queryText}"`}{' '}
                                · {hist.searchCount > 1 ? `Searched ${hist.searchCount}×` : 'Recent'}
                              </div>
                            </div>
                          </button>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {hist.coordinates && (
                              <GlassButton
                                variant={alreadySaved ? 'black' : 'glass'}
                                size="sm"
                                onClick={() => {
                                  if (alreadySaved) {
                                    void removeSavedLocation(alreadySaved.id);
                                  } else {
                                    void saveLocation({
                                      landmarkId: hist.landmarkId,
                                      name: hist.selectedName || hist.queryText,
                                      category: hist.selectedCategory || 'off_campus',
                                      description: hist.selectedDescription,
                                      address: hist.selectedAddress,
                                      coordinates: hist.coordinates!,
                                      isOffCampus: hist.isOffCampus,
                                      source: 'search',
                                    });
                                  }
                                }}
                              >
                                <Bookmark
                                  className={`w-3 h-3 ${
                                    alreadySaved ? 'fill-current text-[#D98BA5]' : ''
                                  }`}
                                />
                                <span>{alreadySaved ? 'Saved' : 'Save'}</span>
                              </GlassButton>
                            )}

                            <button
                              type="button"
                              onClick={() => void removeSearchHistoryItem(hist.id)}
                              aria-label="Remove search history item"
                              className="p-2 rounded-lg text-[#82796F] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </GlassCard>
            )}
          </div>
        )}

        <Suspense fallback={null}>
          {previewLandmark && (
            <LocationViewModal
              location={previewLandmark}
              initialShowDirections={previewWithDirections}
              onClose={() => {
                setPreviewLandmark(null);
                setPreviewWithDirections(false);
              }}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
};

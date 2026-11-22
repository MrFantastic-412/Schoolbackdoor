import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Check,
  Compass,
  Crown,
  Flag,
  Heart,
  Loader2,
  MapPin,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import { CampusLocation, Community, CommunityMember, Post, StudentProfile } from '../types';
import { api } from '../api/client';
import { GlassButton, GlassCard, GlassInput, GlassModal, GlassTab } from '../components/glass';
import { CommunityGridSkeleton, ListRowsSkeleton } from '../components/common/Skeletons';
import { PostPollCard } from '../components/common/PostPollCard';
import { PostImageGrid } from '../components/common/PostImageGrid';
import { UserAvatar } from '../components/common/UserAvatar';
import { MentionInput } from '../components/common/MentionInput';
import { MentionText } from '../components/common/MentionText';
import {
  compressMultipleImages,
  IMAGE_UPLOAD_ACCEPT,
  IMAGE_UPLOAD_GUIDANCE,
  MAX_ATTACHMENTS_POST,
} from '../utils/imageCompression';
import { useDebounce } from '../utils/useDebounce';
import { triggerHaptic } from '../utils/haptics';

const ReportPostModal = lazy(() =>
  import('../components/common/ReportPostModal').then((m) => ({ default: m.ReportPostModal }))
);
const ImageViewerModal = lazy(() =>
  import('../components/common/ImageViewerModal').then((m) => ({ default: m.ImageViewerModal }))
);

interface CommunitiesPageProps {
  communities: Community[];
  selectedCommunityId?: string | null;
  onSelectCommunity?: (id: string | null) => void;
  requestedTab?: 'discussions' | 'announcements' | null;
  onClearRequestedTab?: () => void;
  onToggleJoin: (communityId: string) => void;
  onNavigateToChat?: (chatId?: string) => void;
  onOpenComposeWithLocation?: (location: CampusLocation) => void;
  onViewUserProfile?: (userId: string) => void;
  onPostUpdated?: (post: Post) => void;
  onPostDeleted?: (postId: string) => void;
  profile?: StudentProfile;
  onRefreshCommunities?: () => void;
  isLoading?: boolean;
}

export const CommunitiesPage: React.FC<CommunitiesPageProps> = ({
  communities,
  selectedCommunityId: controlledCommunityId,
  onSelectCommunity,
  requestedTab,
  onClearRequestedTab,
  onToggleJoin,
  onNavigateToChat,
  onViewUserProfile,
  onPostUpdated,
  onPostDeleted,
  profile,
  onRefreshCommunities,
  isLoading = false,
}) => {
  const [directoryScope, setDirectoryScope] = useState<'discover' | 'mine'>('discover');
  const [filter, setFilter] = useState<'all' | 'school' | 'hostel' | 'tech' | 'academic' | 'social'>('all');
  const [search, setSearch] = useState('');
  const [localCommunityId, setLocalCommunityId] = useState<string | null>(null);
  const selectedCommunityId = controlledCommunityId !== undefined ? controlledCommunityId : localCommunityId;

  const setSelectedCommunityId = useCallback(
    (id: string | null) => {
      if (controlledCommunityId === undefined) setLocalCommunityId(id);
      onSelectCommunity?.(id);
    },
    [controlledCommunityId, onSelectCommunity]
  );

  const [detailTab, setDetailTab] = useState<'discussions' | 'announcements' | 'members' | 'settings'>('discussions');

  const [communityPosts, setCommunityPosts] = useState<Post[]>([]);
  const [communityMembers, setCommunityMembers] = useState<CommunityMember[]>([]);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [communityPostsOffset, setCommunityPostsOffset] = useState(0);
  const [hasMoreCommunityPosts, setHasMoreCommunityPosts] = useState(false);
  const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false);
  const [communityPostsError, setCommunityPostsError] = useState<string | null>(null);
  const postsLockRef = useRef(false);
  const postsSentinelRef = useRef<HTMLDivElement | null>(null);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isAnnouncementModalOpen, setIsAnnouncementModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ text: string; isError?: boolean } | null>(null);
  const [pendingRemoveUserId, setPendingRemoveUserId] = useState<string | null>(null);
  const [reportTargetPost, setReportTargetPost] = useState<Post | null>(null);
  const [reportedPostIds, setReportedPostIds] = useState<Set<string>>(() => new Set());

  const [quickDiscussionText, setQuickDiscussionText] = useState('');
  const [discussionImages, setDiscussionImages] = useState<string[]>([]);
  const [discussionImageUpload, setDiscussionImageUpload] = useState<{
    active: boolean;
    progress: number;
    label: string;
  } | null>(null);
  const [discussionImageError, setDiscussionImageError] = useState<string | null>(null);
  const discussionFileInputRef = useRef<HTMLInputElement | null>(null);

  const [isSubmittingDiscussion, setIsSubmittingDiscussion] = useState(false);
  const [votingPostIds, setVotingPostIds] = useState<Set<string>>(() => new Set());
  const [announcementText, setAnnouncementText] = useState('');
  const [announcementUrgency, setAnnouncementUrgency] = useState<'normal' | 'high'>('normal');
  const [announcementImages, setAnnouncementImages] = useState<string[]>([]);
  const [announcementImageUpload, setAnnouncementImageUpload] = useState<{
    active: boolean;
    progress: number;
    label: string;
  } | null>(null);
  const [announcementImageError, setAnnouncementImageError] = useState<string | null>(null);
  const announcementFileInputRef = useRef<HTMLInputElement | null>(null);

  const [lightboxState, setLightboxState] = useState<{
    images: string[];
    index: number;
    title?: string;
  } | null>(null);

  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editPostDraft, setEditPostDraft] = useState('');
  const [isSavingPostEdit, setIsSavingPostEdit] = useState(false);
  const [confirmDeletePostId, setConfirmDeletePostId] = useState<string | null>(null);
  const [isDeletingPostId, setIsDeletingPostId] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState({
    name: '',
    acronym: '',
    category: 'social' as 'school' | 'hostel' | 'tech' | 'academic' | 'social',
    description: '',
    location: '',
    leaders: '',
    rules: 'Be respectful, follow community guidelines, and keep the space welcoming.',
    allowDiscussions: true,
  });

  const [editForm, setEditForm] = useState({
    name: '',
    description: '',
    location: '',
    leaders: '',
    rules: '',
    allowDiscussions: true,
  });

  const showNotice = (text: string, isError = false) => {
    triggerHaptic(isError ? 'error' : 'success');
    setActionFeedback({ text, isError });
    setTimeout(() => setActionFeedback(null), 3500);
  };

  const selectedCommunity = communities.find((c) => c.id === selectedCommunityId) || null;

  useEffect(() => {
    if (!requestedTab) return;
    setDetailTab(requestedTab);
    onClearRequestedTab?.();
  }, [onClearRequestedTab, requestedTab]);

  useEffect(() => {
    if (!selectedCommunityId) return;

    let isMounted = true;
    setIsLoadingDetails(true);
    setPendingRemoveUserId(null);
    setEditingPostId(null);
    setEditPostDraft('');
    setConfirmDeletePostId(null);
    setCommunityPostsError(null);
    setDiscussionImages([]);
    setDiscussionImageError(null);
    setAnnouncementImages([]);
    setAnnouncementImageError(null);
    setCommunityPosts([]);
    setCommunityPostsOffset(0);
    setHasMoreCommunityPosts(false);
    postsLockRef.current = false;

    const loadData = async () => {
      try {
        const [postsPage, members] = await Promise.all([
          api.getCommunityPostsPaginated(selectedCommunityId, { limit: 15, offset: 0 }),
          api.getCommunityMembers(selectedCommunityId),
        ]);
        if (isMounted) {
          setCommunityPosts(postsPage.posts || []);
          setHasMoreCommunityPosts(Boolean(postsPage.hasMore));
          setCommunityPostsOffset(postsPage.nextOffset ?? (postsPage.posts?.length || 0));
          setCommunityMembers(members);
        }
      } catch (err: any) {
        console.error('Failed to load community details:', err);
        if (isMounted) {
          setCommunityPostsError(err?.message || 'Failed to load community posts.');
        }
      } finally {
        if (isMounted) setIsLoadingDetails(false);
      }
    };

    loadData();

    if (selectedCommunity) {
      setEditForm({
        name: selectedCommunity.name,
        description: selectedCommunity.description,
        location: selectedCommunity.location,
        leaders: selectedCommunity.leaders || '',
        rules: selectedCommunity.rules || 'Be respectful and keep discussions constructive.',
        allowDiscussions: selectedCommunity.settings?.allowMemberDiscussions !== false,
      });
    }

    return () => {
      isMounted = false;
    };
  }, [selectedCommunityId]);

  const handleLoadMoreCommunityPosts = useCallback(async () => {
    if (!selectedCommunityId || postsLockRef.current || isLoadingMorePosts || !hasMoreCommunityPosts) return;
    postsLockRef.current = true;
    setIsLoadingMorePosts(true);
    setCommunityPostsError(null);
    try {
      const page = await api.getCommunityPostsPaginated(selectedCommunityId, {
        limit: 15,
        offset: communityPostsOffset,
      });
      setCommunityPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const additions = (page.posts || []).filter((p) => !seen.has(p.id));
        return [...prev, ...additions];
      });
      setHasMoreCommunityPosts(Boolean(page.hasMore));
      setCommunityPostsOffset(page.nextOffset ?? communityPostsOffset + (page.posts?.length || 0));
    } catch (err: any) {
      setCommunityPostsError(err?.message || 'Unable to load more discussions.');
    } finally {
      postsLockRef.current = false;
      setIsLoadingMorePosts(false);
    }
  }, [communityPostsOffset, hasMoreCommunityPosts, isLoadingMorePosts, selectedCommunityId]);

  useEffect(() => {
    if (
      !selectedCommunityId ||
      detailTab !== 'discussions' ||
      !hasMoreCommunityPosts ||
      isLoadingMorePosts ||
      communityPostsError
    ) {
      return;
    }
    const target = postsSentinelRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          handleLoadMoreCommunityPosts();
        }
      },
      { rootMargin: '220px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    communityPostsError,
    detailTab,
    handleLoadMoreCommunityPosts,
    hasMoreCommunityPosts,
    isLoadingMorePosts,
    selectedCommunityId,
  ]);

  const debouncedSearch = useDebounce(search, 200);

  const myCommunitiesCount = useMemo(
    () => communities.filter((c) => c.isJoined).length,
    [communities]
  );

  const filteredCommunities = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return communities.filter((c) => {
      const matchesScope = directoryScope === 'discover' ? true : Boolean(c.isJoined);
      const matchesFilter = filter === 'all' || c.category === filter;
      const matchesSearch =
        q === '' ||
        c.name.toLowerCase().includes(q) ||
        c.acronym.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q);
      return matchesScope && matchesFilter && matchesSearch;
    });
  }, [communities, debouncedSearch, directoryScope, filter]);

  const isLead = selectedCommunity?.userRole === 'lead';
  const isModerator = selectedCommunity?.userRole === 'moderator';
  const canPublishAnnouncement = isLead || isModerator;
  const isJoined = Boolean(selectedCommunity?.isJoined);
  const canManageGuild = Boolean(isLead || profile?.role === 'admin' || profile?.badges?.includes('Admin'));

  const handleCreateCommunitySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);

    try {
      const created = await api.createCommunity({
        name: createForm.name,
        acronym: createForm.acronym,
        category: createForm.category,
        description: createForm.description,
        location: createForm.location,
        leaders: createForm.leaders,
        rules: createForm.rules,
        settings: {
          allowMemberDiscussions: createForm.allowDiscussions,
        },
      });

      setIsCreateModalOpen(false);
      onRefreshCommunities?.();
      setSelectedCommunityId(created.id);
      setDetailTab('discussions');
      showNotice(`${created.acronym} guild established.`);
    } catch (err: any) {
      setFormError(err.message || 'Failed to establish guild.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCommunityId) return;

    setIsSubmitting(true);
    setFormError(null);

    try {
      await api.editCommunity(selectedCommunityId, {
        name: editForm.name,
        description: editForm.description,
        location: editForm.location,
        leaders: editForm.leaders,
        rules: editForm.rules,
        settings: {
          allowMemberDiscussions: editForm.allowDiscussions,
        },
      });

      onRefreshCommunities?.();
      setDetailTab('discussions');
      showNotice('Guild governance settings saved.');
    } catch (err: any) {
      setFormError(err.message || 'Failed to save changes.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateRole = async (targetUserId: string, newRole: 'lead' | 'moderator' | 'member') => {
    if (!selectedCommunityId) return;
    try {
      await api.updateCommunityMemberRole(selectedCommunityId, targetUserId, newRole);
      setCommunityMembers((prev) =>
        prev.map((m) => (m.userId === targetUserId ? { ...m, communityRole: newRole } : m))
      );
      showNotice(`Member role updated to ${newRole.toUpperCase()}.`);
    } catch (err: any) {
      showNotice(err.message || 'Failed to update member role.', true);
    }
  };

  const handleRemoveMember = async (targetUserId: string) => {
    if (!selectedCommunityId) return;
    try {
      await api.removeCommunityMember(selectedCommunityId, targetUserId);
      setCommunityMembers((prev) => prev.filter((m) => m.userId !== targetUserId));
      setPendingRemoveUserId(null);
      onRefreshCommunities?.();
      showNotice('Member removed from guild.');
    } catch (err: any) {
      showNotice(err.message || 'Failed to remove member.', true);
    }
  };

  const handleAttachImagesForComposer = async (
    files: FileList | null,
    target: 'discussion' | 'announcement'
  ) => {
    if (!files || files.length === 0) return;
    const existing = target === 'discussion' ? discussionImages : announcementImages;
    const setImages = target === 'discussion' ? setDiscussionImages : setAnnouncementImages;
    const setUpload = target === 'discussion' ? setDiscussionImageUpload : setAnnouncementImageUpload;
    const setError = target === 'discussion' ? setDiscussionImageError : setAnnouncementImageError;

    const remaining = MAX_ATTACHMENTS_POST - existing.length;
    if (remaining <= 0) {
      setError(`You can attach up to ${MAX_ATTACHMENTS_POST} photos per post.`);
      return;
    }

    setError(null);
    setUpload({ active: true, progress: 5, label: 'Optimizing photo...' });

    try {
      const { results, error } = await compressMultipleImages(files, remaining, (pct) =>
        setUpload({
          active: true,
          progress: Math.max(5, Math.round(pct * 0.5)),
          label: 'Optimizing photo...',
        })
      );
      if (error) {
        triggerHaptic('error');
        setError(error);
        return;
      }

      const uploadedUrls: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        const uploaded = await api.uploadImage(item.dataUrl, item.thumbnailDataUrl, (pct) => {
          const totalPct = Math.min(99, 50 + Math.round(((i + pct / 100) / Math.max(1, results.length)) * 50));
          setUpload({ active: true, progress: totalPct, label: 'Uploading photo...' });
        });
        uploadedUrls.push(uploaded.url);
      }

      if (uploadedUrls.length > 0) {
        setImages((prev) => [...prev, ...uploadedUrls].slice(0, MAX_ATTACHMENTS_POST));
        triggerHaptic('success');
      }
    } catch (err: any) {
      triggerHaptic('error');
      setError(err?.message || 'Failed to upload image.');
    } finally {
      setUpload(null);
    }
  };

  const handleCreateDiscussion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      isSubmittingDiscussion ||
      (!quickDiscussionText.trim() && discussionImages.length === 0) ||
      !selectedCommunityId
    ) {
      return;
    }

    setIsSubmittingDiscussion(true);
    try {
      const newPost = await api.createCommunityPost(selectedCommunityId, {
        content: quickDiscussionText.trim(),
        isAnnouncement: false,
        images: discussionImages.length > 0 ? discussionImages : undefined,
      });
      setCommunityPosts((prev) => [newPost, ...prev]);
      setQuickDiscussionText('');
      setDiscussionImages([]);
      setDiscussionImageError(null);
      showNotice('Discussion posted to guild.');
    } catch (err: any) {
      showNotice(err.message || 'Failed to publish discussion.', true);
    } finally {
      setIsSubmittingDiscussion(false);
    }
  };

  const handleCreateAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      isSubmitting ||
      (!announcementText.trim() && announcementImages.length === 0) ||
      !selectedCommunityId
    ) {
      return;
    }

    setIsSubmitting(true);
    try {
      const newAnnouncement = await api.createCommunityPost(selectedCommunityId, {
        content: announcementText.trim(),
        isAnnouncement: true,
        announcementUrgency,
        images: announcementImages.length > 0 ? announcementImages : undefined,
      });

      setCommunityPosts((prev) => [newAnnouncement, ...prev]);
      setAnnouncementText('');
      setAnnouncementImages([]);
      setAnnouncementImageError(null);
      setIsAnnouncementModalOpen(false);
      setDetailTab('announcements');
      showNotice('Community announcement posted for members.');
    } catch (err: any) {
      showNotice(err.message || 'Failed to publish announcement.', true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVoteCommunityPoll = async (postId: string, optionId: string) => {
    if (!profile?.userId) {
      showNotice('Please sign in to vote on polls.', true);
      return;
    }
    if (votingPostIds.has(postId)) return;
    setVotingPostIds((prev) => {
      const next = new Set(prev);
      next.add(postId);
      return next;
    });
    try {
      const updated = await api.votePoll(postId, optionId);
      setCommunityPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, poll: updated.poll } : p))
      );
    } catch (err: any) {
      showNotice(err?.message || 'Unable to submit vote right now.', true);
    } finally {
      setVotingPostIds((prev) => {
        const next = new Set(prev);
        next.delete(postId);
        return next;
      });
    }
  };

  const handleSaveCommunityPostEdit = async (postId: string) => {
    if (!editPostDraft.trim() || isSavingPostEdit) return;
    setIsSavingPostEdit(true);
    try {
      const updated = await api.editPost(postId, editPostDraft.trim());
      if (updated) {
        setCommunityPosts((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, ...updated, comments: updated.comments || p.comments } : p))
        );
        onPostUpdated?.(updated);
      }
      setEditingPostId(null);
      setEditPostDraft('');
      showNotice('Community post updated.');
    } catch (err: any) {
      showNotice(err?.message || 'Unable to edit community post.', true);
    } finally {
      setIsSavingPostEdit(false);
    }
  };

  const handleDeleteCommunityPost = async (postId: string) => {
    if (isDeletingPostId) return;
    setIsDeletingPostId(postId);
    try {
      await api.deletePost(postId);
      setCommunityPosts((prev) => prev.filter((p) => p.id !== postId));
      onPostDeleted?.(postId);
      setConfirmDeletePostId(null);
      showNotice('Post deleted from community.');
    } catch (err: any) {
      showNotice(err?.message || 'Unable to delete community post.', true);
    } finally {
      setIsDeletingPostId(null);
    }
  };

  const announcementsList = communityPosts.filter((p) => p.isAnnouncement);
  const discussionsList = communityPosts.filter((p) => !p.isAnnouncement);

  const detailTabItems = [
    {
      id: 'discussions' as const,
      label: 'Discussions',
      count: discussionsList.length,
      icon: <MessageCircle className="w-3.5 h-3.5" />,
    },
    {
      id: 'announcements' as const,
      label: 'Announcements',
      count: announcementsList.length,
      icon: <Megaphone className="w-3.5 h-3.5" />,
    },
    {
      id: 'members' as const,
      label: 'Roster',
      count: communityMembers.length,
      icon: <Users className="w-3.5 h-3.5" />,
    },
    ...(canManageGuild
      ? [
          {
            id: 'settings' as const,
            label: 'Settings',
            icon: <Settings className="w-3.5 h-3.5" />,
          },
        ]
      : []),
  ];

  return (
    <div className="w-full flex justify-center px-4 py-6 md:py-8">
      <div className="w-full max-w-4xl flex flex-col gap-6">
        {actionFeedback && (
          <div
            className={`px-4 py-3 rounded-2xl text-xs font-medium flex items-center justify-between gap-2 animate-sb-in ${
              actionFeedback.isError
                ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#C4718E] text-[#171613] dark:text-[#F5EFE3]'
                : 'glass-dark text-[#F5EFE3]'
            }`}
          >
            <span>{actionFeedback.text}</span>
            <button
              type="button"
              onClick={() => setActionFeedback(null)}
              className="opacity-70 hover:opacity-100 cursor-pointer p-1"
              aria-label="Dismiss notice"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ======================================================== */}
        {/* VIEW 1: SINGLE COMMUNITY DETAIL VIEW                    */}
        {/* ======================================================== */}
        {selectedCommunity ? (
          <div className="flex flex-col gap-5 animate-sb-in">
            {/* Top Navigation Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-4">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  setSelectedCommunityId(null);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] font-medium transition-colors cursor-pointer py-1.5"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Return to Guilds Directory</span>
              </button>

              <div className="flex items-center gap-2">
                {selectedCommunity.chatId && isJoined && (
                  <GlassButton
                    variant="glass"
                    size="sm"
                    onClick={() => onNavigateToChat?.(selectedCommunity.chatId)}
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>Open Group Lounge</span>
                  </GlassButton>
                )}

                <GlassButton
                  variant={selectedCommunity.isJoined ? 'glass' : 'pink'}
                  size="sm"
                  onClick={() => onToggleJoin(selectedCommunity.id)}
                >
                  {selectedCommunity.isJoined ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-[#C4718E]" />
                      <span>Joined Guild</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5" />
                      <span>Join Guild</span>
                    </>
                  )}
                </GlassButton>
              </div>
            </div>

            {/* Guild Header Glass Card */}
            <GlassCard tone="cream" padding="lg" className="flex flex-col gap-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2.5 py-0.5 rounded-lg font-mono text-xs font-bold bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613]">
                  {selectedCommunity.acronym}
                </span>
                <span className="text-[11px] font-medium text-[#171613] dark:text-[#F5EFE3] capitalize bg-[#E8DDCC]/75 dark:bg-[#23211C] px-2.5 py-0.5 rounded-lg">
                  {selectedCommunity.category} Guild
                </span>
                {selectedCommunity.userRole && (
                  <span className="text-[11px] text-[#171613] dark:text-[#F5EFE3] bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5]/50 px-2.5 py-0.5 rounded-lg font-semibold flex items-center gap-1">
                    {selectedCommunity.userRole === 'lead' ? (
                      <>
                        <Crown className="w-3 h-3 text-[#C4718E]" />
                        <span>Guild Lead</span>
                      </>
                    ) : selectedCommunity.userRole === 'moderator' ? (
                      <>
                        <Shield className="w-3 h-3 text-[#C4718E]" />
                        <span>Guild Moderator</span>
                      </>
                    ) : (
                      <span>Member</span>
                    )}
                  </span>
                )}
              </div>

              <div>
                <h1 className="font-serif text-2xl md:text-3xl font-bold tracking-tight text-[#171613] dark:text-[#F5EFE3]">
                  {selectedCommunity.name}
                </h1>
                <p className="text-xs md:text-sm text-[#82796F] dark:text-[#A89F95] mt-2 leading-relaxed">
                  {selectedCommunity.description}
                </p>
              </div>

              <div className="pt-3 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10 flex flex-wrap items-center justify-between gap-3 text-xs text-[#82796F] dark:text-[#A89F95]">
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-1.5 text-[#171613] dark:text-[#F5EFE3]">
                    <MapPin className="w-3.5 h-3.5 text-[#C4718E]" />
                    <span>{selectedCommunity.location}</span>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-[#171613] dark:text-[#F5EFE3] font-medium tabular-nums">
                    <Users className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95]" />
                    <span>{selectedCommunity.memberCount.toLocaleString()} Students Enrolled</span>
                  </div>
                </div>

                {selectedCommunity.leaders && (
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] italic">
                    {selectedCommunity.leaders}
                  </div>
                )}
              </div>
            </GlassCard>

            {/* Detail Tabs */}
            <GlassTab
              items={detailTabItems}
              activeId={detailTab}
              onChange={(id) => setDetailTab(id)}
            />

            {isLoadingDetails && <ListRowsSkeleton rows={3} />}

            {/* TAB 1: DISCUSSIONS */}
            {detailTab === 'discussions' && (
              <div className="flex flex-col gap-4">
                {isJoined ? (
                  <GlassCard tone="cream" padding="md">
                    <form onSubmit={handleCreateDiscussion} className="flex flex-col gap-3">
                      <div className="flex items-center justify-between text-xs gap-2 flex-wrap">
                        <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">Start a Guild Discussion</span>
                        {canPublishAnnouncement && (
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('tap');
                              setIsAnnouncementModalOpen(true);
                            }}
                            className="text-[11px] text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] flex items-center gap-1 font-semibold cursor-pointer"
                          >
                            <Megaphone className="w-3 h-3" />
                            <span>Post Pinned Announcement Instead</span>
                          </button>
                        )}
                      </div>
                      <MentionInput
                        as="textarea"
                        value={quickDiscussionText}
                        onChange={setQuickDiscussionText}
                        communityId={selectedCommunity.id}
                        placement="below"
                        placeholder={`Share a post, meme, question, or @tag members in ${selectedCommunity.acronym}...`}
                        rows={2}
                        disabled={isSubmittingDiscussion}
                        className="w-full p-3 glass-input rounded-xl text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] resize-none"
                      />

                      {discussionImageUpload?.active && (
                        <div className="px-3 py-2 rounded-xl glass-subtle text-[11px] flex flex-col gap-1.5">
                          <div className="flex items-center justify-between text-[#171613] dark:text-[#F5EFE3]">
                            <span className="inline-flex items-center gap-1.5">
                              <Loader2 className="w-3 h-3 animate-spin text-[#C4718E]" />
                              <span>{discussionImageUpload.label}</span>
                            </span>
                            <span className="font-mono tabular-nums text-[#82796F] dark:text-[#A89F95]">
                              {discussionImageUpload.progress}%
                            </span>
                          </div>
                          <div className="w-full h-1 bg-[#E8DDCC] dark:bg-[#2E2B25] rounded-full overflow-hidden">
                            <div
                              className="h-full bg-[#D98BA5] transition-all duration-200"
                              style={{ width: `${discussionImageUpload.progress}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {discussionImageError && (
                        <div className="px-3 py-2 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-[11px] text-[#171613] dark:text-[#F5EFE3] flex items-center justify-between gap-2">
                          <span>{discussionImageError}</span>
                          <button
                            type="button"
                            onClick={() => setDiscussionImageError(null)}
                            className="underline shrink-0 cursor-pointer"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}

                      {discussionImages.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2">
                          {discussionImages.map((imgUrl, idx) => (
                            <div
                              key={idx}
                              className="relative w-16 h-16 rounded-xl overflow-hidden border border-[#171613]/12 dark:border-[#F5EFE3]/15"
                            >
                              <img src={imgUrl} alt={`Discussion photo ${idx + 1}`} className="w-full h-full object-cover" />
                              <button
                                type="button"
                                onClick={() => {
                                  triggerHaptic('close');
                                  setDiscussionImages((prev) => prev.filter((_, i) => i !== idx));
                                }}
                                aria-label={`Remove photo ${idx + 1}`}
                                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-[#171613]/85 text-[#FFFCF7] flex items-center justify-center cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <input
                            ref={discussionFileInputRef}
                            type="file"
                            accept={IMAGE_UPLOAD_ACCEPT}
                            multiple
                            onChange={(e) => {
                              handleAttachImagesForComposer(e.target.files, 'discussion');
                              e.currentTarget.value = '';
                            }}
                            className="hidden"
                          />
                          <button
                            type="button"
                            disabled={
                              Boolean(discussionImageUpload?.active) ||
                              discussionImages.length >= MAX_ATTACHMENTS_POST ||
                              isSubmittingDiscussion
                            }
                            onClick={() => {
                              triggerHaptic('tap');
                              discussionFileInputRef.current?.click();
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-xl glass-subtle text-xs font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer disabled:opacity-45"
                          >
                            <Camera className="w-3.5 h-3.5 text-[#C4718E]" />
                            <span>
                              Add Photo ({discussionImages.length}/{MAX_ATTACHMENTS_POST})
                            </span>
                          </button>
                          <span className="text-[10px] font-mono text-[#82796F] dark:text-[#A89F95]">
                            {IMAGE_UPLOAD_GUIDANCE}
                          </span>
                        </div>

                        <GlassButton
                          type="submit"
                          variant="pink"
                          size="sm"
                          loading={isSubmittingDiscussion}
                          disabled={
                            (!quickDiscussionText.trim() && discussionImages.length === 0) ||
                            isSubmittingDiscussion ||
                            Boolean(discussionImageUpload?.active)
                          }
                        >
                          {isSubmittingDiscussion ? 'Posting...' : 'Post to Community'}
                        </GlassButton>
                      </div>
                    </form>
                  </GlassCard>
                ) : (
                  <GlassCard tone="pink" padding="md" className="text-center flex flex-col items-center gap-2.5">
                    <span className="text-xs text-[#171613] dark:text-[#F5EFE3] font-medium">
                      Join {selectedCommunity.name} to participate in discussions and member lounges.
                    </span>
                    <GlassButton
                      variant="pink"
                      size="sm"
                      onClick={() => onToggleJoin(selectedCommunity.id)}
                    >
                      Join Community
                    </GlassButton>
                  </GlassCard>
                )}

                {discussionsList.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {discussionsList.map((post) => {
                      const isPostAuthor = Boolean(profile?.userId && post.authorId === profile.userId);
                      const canDeletePost = Boolean(isPostAuthor || profile?.role === 'admin');
                      const isEditingThis = editingPostId === post.id;

                      return (
                      <GlassCard
                        key={post.id}
                        tone={post.isAdminPost || post.isAnnouncement ? 'cream' : 'subtle'}
                        padding="md"
                        className={`flex flex-col gap-2.5 ${
                          post.isAdminPost || post.isAnnouncement ? 'border-[#C4718E]/45 dark:border-[#D98BA5]/40' : ''
                        }`}
                      >
                        {(post.isAdminPost || post.isAnnouncement || post.isPinned || post.isFeatured) && (
                          <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-[#171613]/8 dark:border-[#F5EFE3]/10 text-[11px]">
                            {(post.isAdminPost || post.isAnnouncement) && (
                              <span className="inline-flex items-center gap-1.5 font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                                <Megaphone className="w-3 h-3 shrink-0" />
                                <span>Official Admin Notice</span>
                              </span>
                            )}
                            {post.isPinned && (
                              <span className="inline-flex items-center gap-1 font-medium text-[#171613] dark:text-[#F5EFE3]">
                                {(post.isAdminPost || post.isAnnouncement) && <span aria-hidden="true">·</span>}
                                <Pin className="w-3 h-3 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
                                <span>Pinned</span>
                              </span>
                            )}
                          </div>
                        )}
                        <div className="flex items-center justify-between text-xs gap-2 flex-wrap">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <button
                              type="button"
                              disabled={!post.authorId || post.isAnonymous || !onViewUserProfile}
                              onClick={() => post.authorId && !post.isAnonymous && onViewUserProfile?.(post.authorId)}
                              className={`rounded-full shrink-0 ${
                                post.authorId && !post.isAnonymous && onViewUserProfile ? 'cursor-pointer hover:ring-2 hover:ring-[#D98BA5]/60' : ''
                              }`}
                            >
                              <UserAvatar
                                name={post.authorName}
                                initials={post.avatarInitials}
                                bg={post.avatarBg}
                                avatarUrl={post.avatarUrl}
                                avatarThumbUrl={post.avatarThumbUrl}
                                isAnonymous={post.isAnonymous}
                                size="sm"
                              />
                            </button>
                            <div className="flex flex-col min-w-0">
                              <button
                                type="button"
                                disabled={!post.authorId || post.isAnonymous || !onViewUserProfile}
                                onClick={() => post.authorId && !post.isAnonymous && onViewUserProfile?.(post.authorId)}
                                className={`font-semibold text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1 text-left ${
                                  post.authorId && !post.isAnonymous && onViewUserProfile ? 'hover:text-[#C4718E] dark:hover:text-[#E5A4BA] cursor-pointer' : ''
                                }`}
                              >
                                {post.authorName}
                                {post.verified && <ShieldCheck className="w-3 h-3 text-[#D98BA5] shrink-0" />}
                              </button>
                              <span className="text-[10px] text-[#82796F] dark:text-[#A89F95] truncate">
                                {post.authorHandle} · {post.department}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[10px] font-mono text-[#82796F] dark:text-[#A89F95]">
                              {new Date(post.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                            </span>
                            {(isPostAuthor || canDeletePost) && !isEditingThis && (
                              <div className="flex items-center gap-0.5">
                                {isPostAuthor && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      triggerHaptic('tap');
                                      setEditingPostId(post.id);
                                      setEditPostDraft(post.content);
                                    }}
                                    aria-label="Edit discussion"
                                    title="Edit discussion"
                                    className="w-7 h-7 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/55 dark:hover:bg-[#23211C] cursor-pointer transition-colors"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                                {canDeletePost && (
                                  confirmDeletePostId === post.id ? (
                                    <div className="flex items-center gap-1 ml-1">
                                      <button
                                        type="button"
                                        disabled={isDeletingPostId === post.id}
                                        onClick={() => handleDeleteCommunityPost(post.id)}
                                        className="px-2 py-0.5 rounded-lg bg-[#C4718E] text-[#FFFCF7] text-[10px] font-semibold cursor-pointer"
                                      >
                                        {isDeletingPostId === post.id ? '...' : 'Delete'}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isDeletingPostId === post.id}
                                        onClick={() => setConfirmDeletePostId(null)}
                                        className="px-2 py-0.5 rounded-lg glass-subtle text-[10px] text-[#82796F] dark:text-[#A89F95] cursor-pointer"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        triggerHaptic('tap');
                                        setConfirmDeletePostId(post.id);
                                      }}
                                      aria-label="Delete discussion"
                                      title="Delete discussion"
                                      className="w-7 h-7 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:text-[#C4718E] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/20 cursor-pointer transition-colors"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {isEditingThis ? (
                          <div className="flex flex-col gap-2 mt-1">
                            <MentionInput
                              as="textarea"
                              value={editPostDraft}
                              onChange={setEditPostDraft}
                              communityId={selectedCommunity.id}
                              placement="below"
                              rows={3}
                              disabled={isSavingPostEdit}
                              autoFocus
                              className="w-full p-3 glass-input rounded-xl text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] resize-none leading-relaxed"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <GlassButton
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingPostId(null)}
                                disabled={isSavingPostEdit}
                              >
                                Cancel
                              </GlassButton>
                              <GlassButton
                                variant="pink"
                                size="sm"
                                loading={isSavingPostEdit}
                                disabled={!editPostDraft.trim() || isSavingPostEdit}
                                onClick={() => handleSaveCommunityPostEdit(post.id)}
                              >
                                Save Changes
                              </GlassButton>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs md:text-sm text-[#171613]/90 dark:text-[#F5EFE3]/90 leading-relaxed whitespace-pre-line break-words">
                            <MentionText
                              text={post.content}
                              mentions={post.mentions}
                              onMentionClick={onViewUserProfile}
                            />
                            {post.isEdited && (
                              <span className="ml-1.5 text-[10px] font-mono text-[#82796F] dark:text-[#A89F95]">
                                (edited)
                              </span>
                            )}
                          </p>
                        )}

                        {post.images && post.images.length > 0 && (
                          <PostImageGrid
                            images={post.images}
                            onImageClick={(idx) => {
                              triggerHaptic('tap');
                              setLightboxState({
                                images: post.images!,
                                index: idx,
                                title: `${post.authorName} · ${selectedCommunity.acronym}`,
                              });
                            }}
                          />
                        )}

                        {post.poll && (
                          <PostPollCard
                            postId={post.id}
                            poll={post.poll}
                            onVote={handleVoteCommunityPoll}
                            disabled={votingPostIds.has(post.id)}
                          />
                        )}

                        <div className="pt-2 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95]">
                          <div className="flex items-center gap-3 tabular-nums">
                            <span className="flex items-center gap-1 font-mono">
                              <Heart className="w-3 h-3 text-[#C4718E]" />
                              <span>{post.likes}</span>
                            </span>
                            <span className="flex items-center gap-1 font-mono">
                              <MessageCircle className="w-3 h-3" />
                              <span>{post.commentsCount}</span>
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            {post.location && (
                              <span className="text-[10px] text-[#171613]/80 dark:text-[#F5EFE3]/85 flex items-center gap-1">
                                <MapPin className="w-3 h-3 text-[#C4718E]" />
                                <span>{post.location.name}</span>
                              </span>
                            )}
                            <button
                              type="button"
                              disabled={reportedPostIds.has(post.id)}
                              onClick={() => {
                                triggerHaptic('tap');
                                if (!profile?.userId) {
                                  showNotice('Please sign in to report content.', true);
                                  return;
                                }
                                setReportTargetPost(post);
                              }}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                                reportedPostIds.has(post.id)
                                  ? 'bg-[#F6E2E6]/80 dark:bg-[#D98BA5]/20 text-[#C4718E] dark:text-[#E5A4BA] cursor-default'
                                  : 'hover:text-[#C4718E] dark:hover:text-[#E5A4BA] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/15 cursor-pointer'
                              }`}
                            >
                              <Flag className="w-3 h-3" />
                              <span>{reportedPostIds.has(post.id) ? 'Reported' : 'Report'}</span>
                            </button>
                          </div>
                        </div>
                      </GlassCard>
                      );
                    })}

                    {isLoadingMorePosts && <ListRowsSkeleton rows={2} />}

                    {communityPostsError && (
                      <GlassCard tone="pink" padding="md" className="flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2 text-[#171613] dark:text-[#F5EFE3]">
                          <AlertCircle className="w-4 h-4 text-[#C4718E] shrink-0" />
                          <span>{communityPostsError}</span>
                        </div>
                        <GlassButton variant="black" size="sm" onClick={handleLoadMoreCommunityPosts}>
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>Retry</span>
                        </GlassButton>
                      </GlassCard>
                    )}

                    {hasMoreCommunityPosts && !communityPostsError && (
                      <div ref={postsSentinelRef} className="h-4 w-full" aria-hidden="true" />
                    )}
                  </div>
                ) : communityPostsError ? (
                  <GlassCard tone="pink" padding="md" className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 text-[#171613] dark:text-[#F5EFE3]">
                      <AlertCircle className="w-4 h-4 text-[#C4718E] shrink-0" />
                      <span>{communityPostsError}</span>
                    </div>
                    <GlassButton variant="black" size="sm" onClick={handleLoadMoreCommunityPosts}>
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry</span>
                    </GlassButton>
                  </GlassCard>
                ) : (
                  <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                    No discussions posted in this community yet. Be the first to start a conversation!
                  </GlassCard>
                )}
              </div>
            )}

            {/* TAB 2: ANNOUNCEMENTS */}
            {detailTab === 'announcements' && (
              <div className="flex flex-col gap-4">
                {canPublishAnnouncement && (
                  <div className="flex justify-end">
                    <GlassButton
                      variant="pink"
                      size="sm"
                      onClick={() => setIsAnnouncementModalOpen(true)}
                    >
                      <Megaphone className="w-3.5 h-3.5" />
                      <span>Post Announcement</span>
                    </GlassButton>
                  </div>
                )}

                {announcementsList.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {announcementsList.map((ann) => {
                      const isAnnAuthor = Boolean(profile?.userId && ann.authorId === profile.userId);
                      const canDeleteAnn = Boolean(isAnnAuthor || profile?.role === 'admin');
                      const isEditingThisAnn = editingPostId === ann.id;

                      return (
                      <GlassCard key={ann.id} tone="pink" padding="md" className="flex flex-col gap-3">
                        <div className="flex items-center justify-between text-xs flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <span className="px-2.5 py-0.5 rounded-lg font-mono text-[10px] uppercase font-bold bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613]">
                              Pinned Announcement
                            </span>
                            {ann.announcementUrgency === 'high' && (
                              <span className="px-2.5 py-0.5 rounded-lg font-mono text-[10px] uppercase font-bold bg-[#D98BA5] text-[#171613]">
                                Urgent
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">
                              {new Date(ann.timestamp).toLocaleDateString([], {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })}
                            </span>
                            {(isAnnAuthor || canDeleteAnn) && !isEditingThisAnn && (
                              <div className="flex items-center gap-0.5">
                                {isAnnAuthor && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      triggerHaptic('tap');
                                      setEditingPostId(ann.id);
                                      setEditPostDraft(ann.content);
                                    }}
                                    aria-label="Edit announcement"
                                    title="Edit announcement"
                                    className="w-7 h-7 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#FFFCF7]/70 dark:hover:bg-[#23211C] cursor-pointer transition-colors"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                                {canDeleteAnn && (
                                  confirmDeletePostId === ann.id ? (
                                    <div className="flex items-center gap-1 ml-1">
                                      <button
                                        type="button"
                                        disabled={isDeletingPostId === ann.id}
                                        onClick={() => handleDeleteCommunityPost(ann.id)}
                                        className="px-2 py-0.5 rounded-lg bg-[#C4718E] text-[#FFFCF7] text-[10px] font-semibold cursor-pointer"
                                      >
                                        {isDeletingPostId === ann.id ? '...' : 'Delete'}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isDeletingPostId === ann.id}
                                        onClick={() => setConfirmDeletePostId(null)}
                                        className="px-2 py-0.5 rounded-lg glass-subtle text-[10px] text-[#82796F] dark:text-[#A89F95] cursor-pointer"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        triggerHaptic('tap');
                                        setConfirmDeletePostId(ann.id);
                                      }}
                                      aria-label="Delete announcement"
                                      title="Delete announcement"
                                      className="w-7 h-7 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:text-[#C4718E] hover:bg-[#FFFCF7]/70 dark:hover:bg-[#23211C] cursor-pointer transition-colors"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {isEditingThisAnn ? (
                          <div className="flex flex-col gap-2 mt-1">
                            <MentionInput
                              as="textarea"
                              value={editPostDraft}
                              onChange={setEditPostDraft}
                              communityId={selectedCommunity.id}
                              placement="below"
                              rows={3}
                              disabled={isSavingPostEdit}
                              autoFocus
                              className="w-full p-3 glass-input rounded-xl text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] font-serif resize-none leading-relaxed"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <GlassButton
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingPostId(null)}
                                disabled={isSavingPostEdit}
                              >
                                Cancel
                              </GlassButton>
                              <GlassButton
                                variant="pink"
                                size="sm"
                                loading={isSavingPostEdit}
                                disabled={!editPostDraft.trim() || isSavingPostEdit}
                                onClick={() => handleSaveCommunityPostEdit(ann.id)}
                              >
                                Save Changes
                              </GlassButton>
                            </div>
                          </div>
                        ) : (
                          <div className="font-serif text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] leading-relaxed whitespace-pre-line break-words">
                            <MentionText
                              text={ann.content}
                              mentions={ann.mentions}
                              onMentionClick={onViewUserProfile}
                            />
                            {ann.isEdited && (
                              <span className="ml-1.5 text-[10px] font-mono text-[#82796F] dark:text-[#A89F95]">
                                (edited)
                              </span>
                            )}
                          </div>
                        )}

                        {ann.images && ann.images.length > 0 && (
                          <PostImageGrid
                            images={ann.images}
                            onImageClick={(idx) => {
                              triggerHaptic('tap');
                              setLightboxState({
                                images: ann.images!,
                                index: idx,
                                title: `${selectedCommunity.acronym} Announcement`,
                              });
                            }}
                          />
                        )}

                        {ann.poll && (
                          <PostPollCard
                            postId={ann.id}
                            poll={ann.poll}
                            onVote={handleVoteCommunityPoll}
                            disabled={votingPostIds.has(ann.id)}
                          />
                        )}

                        <div className="pt-2 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10 flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono">
                          <div className="flex items-center gap-2">
                            <UserAvatar
                              name={ann.authorName}
                              initials={ann.avatarInitials}
                              bg={ann.avatarBg}
                              avatarUrl={ann.avatarUrl}
                              avatarThumbUrl={ann.avatarThumbUrl}
                              isAnonymous={ann.isAnonymous}
                              size="xs"
                              className="w-6 h-6 text-[9px]"
                            />
                            <Crown className="w-3.5 h-3.5 text-[#C4718E]" />
                            <span>Posted by {ann.authorName} ({selectedCommunity.acronym} Moderators)</span>
                          </div>
                        </div>
                      </GlassCard>
                      );
                    })}
                  </div>
                ) : (
                  <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                    No pinned announcements posted in this community yet.
                  </GlassCard>
                )}
              </div>
            )}

            {/* TAB 3: MEMBERS ROSTER */}
            {detailTab === 'members' && (
              <GlassCard tone="subtle" padding="none" className="overflow-hidden divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10">
                <div className="px-4 py-3 bg-[#E8DDCC]/45 dark:bg-[#23211C] border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 flex items-center justify-between text-xs text-[#171613] dark:text-[#F5EFE3] font-medium">
                  <span>Members ({communityMembers.length})</span>
                  <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">Tap any member to view profile</span>
                </div>

                {communityMembers.map((member) => (
                  <div
                    key={member.userId}
                    className="p-4 flex items-center justify-between gap-3 text-xs hover:bg-[#FFFCF7]/60 dark:hover:bg-[#23211C]/70 transition-colors"
                  >
                    <button
                      type="button"
                      disabled={!onViewUserProfile}
                      onClick={() => onViewUserProfile?.(member.userId)}
                      className={`flex items-center gap-3 min-w-0 text-left ${onViewUserProfile ? 'cursor-pointer group' : ''}`}
                    >
                      <UserAvatar
                        name={member.name}
                        initials={member.avatarInitials}
                        avatarUrl={member.avatarUrl}
                        avatarThumbUrl={member.avatarThumbUrl}
                        size="sm"
                        className="group-hover:ring-2 group-hover:ring-[#D98BA5]/60"
                      />
                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] truncate group-hover:text-[#C4718E] dark:group-hover:text-[#E5A4BA]">
                            {member.name}
                          </span>
                          {member.verified && <ShieldCheck className="w-3.5 h-3.5 text-[#D98BA5] shrink-0" />}
                        </div>
                        <span className="text-[11px] text-[#82796F] dark:text-[#A89F95] truncate">
                          {member.handle} · {member.department} ({member.level})
                        </span>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border ${
                          member.communityRole === 'lead'
                            ? 'bg-[#171613] text-[#F5EFE3] border-[#171613] dark:bg-[#F5EFE3] dark:text-[#171613] dark:border-[#F5EFE3]'
                            : member.communityRole === 'moderator'
                            ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#171613] dark:text-[#F5EFE3] border-[#D98BA5]/60'
                            : 'bg-[#E8DDCC]/70 dark:bg-[#23211C] text-[#171613] dark:text-[#F5EFE3] border-[#171613]/10 dark:border-[#F5EFE3]/12'
                        }`}
                      >
                        {member.communityRole.toUpperCase()}
                      </span>

                      {canManageGuild && member.userId !== profile?.userId && (
                        <div className="flex items-center gap-1">
                          {member.communityRole !== 'moderator' && member.communityRole !== 'lead' && (
                            <button
                              type="button"
                              onClick={() => handleUpdateRole(member.userId, 'moderator')}
                              className="p-1.5 rounded-lg text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/60 dark:hover:bg-[#23211C] transition-colors cursor-pointer"
                              title="Promote to Moderator"
                            >
                              <Shield className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {member.communityRole === 'moderator' && (
                            <button
                              type="button"
                              onClick={() => handleUpdateRole(member.userId, 'member')}
                              className="p-1.5 rounded-lg text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/60 dark:hover:bg-[#23211C] transition-colors cursor-pointer"
                              title="Demote to Member"
                            >
                              <UserCheck className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {pendingRemoveUserId === member.userId ? (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleRemoveMember(member.userId)}
                                className="px-2 py-1 rounded-lg bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613] text-[10px] font-semibold cursor-pointer"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingRemoveUserId(null)}
                                className="px-2 py-1 rounded-lg border border-[#171613]/15 dark:border-[#F5EFE3]/15 text-[10px] text-[#82796F] dark:text-[#A89F95] cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPendingRemoveUserId(member.userId)}
                              className="p-1.5 rounded-lg text-[#C4718E] hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#F6E2E6] dark:hover:bg-[#D98BA5]/20 transition-colors cursor-pointer"
                              title="Remove from Guild"
                            >
                              <UserMinus className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </GlassCard>
            )}

            {/* TAB 4: SETTINGS */}
            {detailTab === 'settings' && canManageGuild && (
              <GlassCard tone="cream" padding="lg">
                <form onSubmit={handleSaveSettings} className="flex flex-col gap-4 text-xs">
                  <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                    Customise Guild Information & Governance
                  </h3>

                  <GlassInput
                    label="Guild Name"
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    required
                  />

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-[#82796F] dark:text-[#A89F95]">
                      Official Description
                    </label>
                    <textarea
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      rows={3}
                      className="p-3 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3] resize-none"
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <GlassInput
                      label="Physical Campus Location"
                      type="text"
                      value={editForm.location}
                      onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
                      required
                    />

                    <GlassInput
                      label="Leaders & Advisers"
                      type="text"
                      value={editForm.leaders}
                      onChange={(e) => setEditForm({ ...editForm, leaders: e.target.value })}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-[#82796F] dark:text-[#A89F95]">
                      Guild Charter & Conduct Rules
                    </label>
                    <textarea
                      value={editForm.rules}
                      onChange={(e) => setEditForm({ ...editForm, rules: e.target.value })}
                      rows={2}
                      className="p-3 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3] resize-none"
                    />
                  </div>

                  <label className="flex items-center gap-2.5 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.allowDiscussions}
                      onChange={(e) => setEditForm({ ...editForm, allowDiscussions: e.target.checked })}
                      className="w-4 h-4 accent-[#D98BA5]"
                    />
                    <span className="text-[#171613] dark:text-[#F5EFE3]">
                      Permit enrolled members to post discussions (uncheck for broadcast-only bulletin mode)
                    </span>
                  </label>

                  {formError && (
                    <div className="p-2.5 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-xs text-[#171613] dark:text-[#F5EFE3]">
                      {formError}
                    </div>
                  )}

                  <div className="flex justify-end pt-3 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10">
                    <GlassButton type="submit" variant="black" loading={isSubmitting} disabled={isSubmitting}>
                      {isSubmitting ? 'Saving Changes...' : 'Save Guild Settings'}
                    </GlassButton>
                  </div>
                </form>
              </GlassCard>
            )}
          </div>
        ) : (
          /* ======================================================== */
          /* VIEW 2: ALL COMMUNITIES DIRECTORY                        */
          /* ======================================================== */
          <>
            <div className="pb-2 flex items-center justify-between gap-4">
              <div>
                <h1 className="font-serif text-2xl md:text-3xl font-bold tracking-tight text-[#171613] dark:text-[#F5EFE3]">
                  Communities
                </h1>
                <p className="text-xs md:text-sm text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Interest clubs, hostels, humor & lifestyle groups, and academic communities.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  setIsCreateModalOpen(true);
                }}
                aria-label="Create Community"
                className="w-10 h-10 rounded-xl glass-pink text-[#171613] flex items-center justify-center shrink-0 cursor-pointer transition-transform hover:scale-105"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>

            {/* Discover vs My Communities Switcher */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <GlassTab
                variant="pink"
                items={[
                  {
                    id: 'discover',
                    label: 'Discover',
                    count: communities.length,
                    icon: <Compass className="w-3.5 h-3.5" />,
                  },
                  {
                    id: 'mine',
                    label: 'My Communities',
                    count: myCommunitiesCount,
                    icon: <Users className="w-3.5 h-3.5" />,
                  },
                ]}
                activeId={directoryScope}
                onChange={(id) => setDirectoryScope(id)}
              />

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs scrollbar-none">
                {[
                  { id: 'all', label: 'All' },
                  { id: 'social', label: 'Social & Fun' },
                  { id: 'school', label: 'Schools' },
                  { id: 'hostel', label: 'Halls' },
                  { id: 'tech', label: 'Tech' },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setFilter(cat.id as any);
                    }}
                    className={`px-3.5 py-1.5 min-h-[36px] rounded-xl font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      filter === cat.id
                        ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613] shadow-xs'
                        : 'glass-subtle text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Frosted Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 text-[#82796F] dark:text-[#A89F95] absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search faculty, school acronym (SEET, SOC), or hostel..."
                className="w-full pl-11 pr-4 py-2.5 rounded-xl glass-input text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95]"
              />
            </div>

            {/* Community Cards */}
            {isLoading && communities.length === 0 ? (
              <CommunityGridSkeleton count={4} />
            ) : filteredCommunities.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {filteredCommunities.map((c) => (
                  <GlassCard
                    key={c.id}
                    tone="cream"
                    padding="md"
                    onClick={() => {
                      triggerHaptic('tap');
                      setSelectedCommunityId(c.id);
                      setDetailTab('discussions');
                    }}
                    className="flex items-center justify-between gap-3.5 hover:bg-[#FFFCF7]/85 dark:hover:bg-[#23211C]/90 cursor-pointer group"
                  >
                    <div className="flex items-center gap-3.5 min-w-0 flex-1">
                      <div className="w-14 h-14 rounded-xl p-0.5 bg-gradient-to-br from-[#F0B4C7] via-[#D98BA5] to-[#E8DDCC] dark:to-[#2A2722] shrink-0 shadow-sm">
                        <div className="w-full h-full rounded-[10px] bg-[#FFFCF7] dark:bg-[#1E1C18] flex flex-col items-center justify-center border border-[#171613]/10 dark:border-[#F5EFE3]/12">
                          <span className="font-mono font-bold text-xs text-[#171613] dark:text-[#F5EFE3] tracking-tight">
                            {c.acronym.slice(0, 4)}
                          </span>
                          <span className="text-[9px] uppercase text-[#C4718E] dark:text-[#E5A4BA] font-semibold">
                            {c.category.slice(0, 4)}
                          </span>
                        </div>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <h3 className="font-serif font-bold text-sm md:text-base text-[#171613] dark:text-[#F5EFE3] truncate">
                            {c.name}
                          </h3>
                          {c.userRole && (
                            <span className="text-[9px] font-mono text-[#171613] dark:text-[#F5EFE3] bg-[#F6E2E6] dark:bg-[#D98BA5]/25 px-1.5 py-0.5 rounded-md border border-[#D98BA5]/50 font-semibold whitespace-nowrap shrink-0">
                              {c.userRole.toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] tabular-nums mt-0.5">
                          {c.memberCount.toLocaleString()} members · {c.location}
                        </div>
                        <p className="text-[11px] text-[#82796F] dark:text-[#A89F95] truncate mt-0.5">
                          {c.description}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleJoin(c.id);
                      }}
                      className={`px-3.5 py-1.5 min-h-[38px] rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-all flex items-center gap-1 ${
                        c.isJoined
                          ? 'glass-subtle text-[#171613] dark:text-[#F5EFE3] border border-[#D98BA5]/60 hover:bg-[#F6E2E6] dark:hover:bg-[#D98BA5]/20'
                          : 'bg-[#171613] text-[#F5EFE3] hover:bg-[#2A2823] dark:bg-[#F5EFE3] dark:text-[#171613] dark:hover:bg-[#E8DDCC] shadow-sm'
                      }`}
                    >
                      {c.isJoined ? (
                        <>
                          <Check className="w-3 h-3 text-[#C4718E]" />
                          <span>Joined</span>
                        </>
                      ) : (
                        <span>Join</span>
                      )}
                    </button>
                  </GlassCard>
                ))}
              </div>
            ) : (
              <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                {directoryScope === 'mine'
                  ? 'You have not joined any campus communities matching this filter yet.'
                  : 'No campus communities match your search criteria.'}
              </GlassCard>
            )}
          </>
        )}

        {/* CREATE COMMUNITY MODAL */}
        <GlassModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          title="Create New Community"
          subtitle="Start a social club, hobby group, hostel space, or study community"
        >
          <form onSubmit={handleCreateCommunitySubmit} className="p-5 flex flex-col gap-3.5 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <GlassInput
                  label="Community Name *"
                  type="text"
                  placeholder="e.g. Campus Memes & Banter"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  required
                />
              </div>
              <div>
                <GlassInput
                  label="Tag / Short *"
                  type="text"
                  placeholder="MEME"
                  value={createForm.acronym}
                  onChange={(e) => setCreateForm({ ...createForm, acronym: e.target.value.toUpperCase() })}
                  className="font-mono"
                  maxLength={8}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold tracking-wide text-[#82796F] dark:text-[#A89F95] uppercase">
                  Category *
                </label>
                <select
                  value={createForm.category}
                  onChange={(e: any) => setCreateForm({ ...createForm, category: e.target.value })}
                  className="p-2.5 min-h-[44px] glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3]"
                >
                  <option value="social">Social, Entertainment & Lifestyle</option>
                  <option value="school">School / Faculty</option>
                  <option value="hostel">Hall / Hostel Area</option>
                  <option value="tech">Tech & Creators</option>
                  <option value="academic">Study Group / Department</option>
                </select>
              </div>

              <GlassInput
                label="Location / Hangout *"
                type="text"
                placeholder="South Gate / Online"
                value={createForm.location}
                onChange={(e) => setCreateForm({ ...createForm, location: e.target.value })}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold tracking-wide text-[#82796F] dark:text-[#A89F95] uppercase">
                Description *
              </label>
              <textarea
                placeholder="Describe what people share and talk about in this community..."
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                rows={2}
                className="p-3 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] resize-none"
                required
              />
            </div>

            <GlassInput
              label="Moderators / Organizers"
              type="text"
              placeholder="Host: @username"
              value={createForm.leaders}
              onChange={(e) => setCreateForm({ ...createForm, leaders: e.target.value })}
            />

            <label className="flex items-center gap-2 pt-1 cursor-pointer">
              <input
                type="checkbox"
                checked={createForm.allowDiscussions}
                onChange={(e) => setCreateForm({ ...createForm, allowDiscussions: e.target.checked })}
                className="w-4 h-4 accent-[#D98BA5]"
              />
              <span className="text-[#171613] dark:text-[#F5EFE3]">
                Enable member discussions & linked group chat
              </span>
            </label>

            {formError && (
              <div className="p-2.5 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-xs text-[#171613] dark:text-[#F5EFE3]">
                {formError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-3 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10">
              <GlassButton variant="ghost" size="sm" onClick={() => setIsCreateModalOpen(false)} disabled={isSubmitting}>
                Cancel
              </GlassButton>
              <GlassButton type="submit" variant="pink" size="sm" loading={isSubmitting} disabled={isSubmitting}>
                {isSubmitting ? 'Creating...' : 'Create Community'}
              </GlassButton>
            </div>
          </form>
        </GlassModal>

        {/* POST ANNOUNCEMENT MODAL */}
        <GlassModal
          isOpen={Boolean(isAnnouncementModalOpen && selectedCommunity)}
          onClose={() => setIsAnnouncementModalOpen(false)}
          title={selectedCommunity ? `Pin ${selectedCommunity.acronym} Announcement` : 'Pin Announcement'}
          subtitle="Community Member Notice"
        >
          {selectedCommunity && (
            <form onSubmit={handleCreateAnnouncement} className="p-5 flex flex-col gap-3.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#82796F] dark:text-[#A89F95] font-medium">Priority Level:</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setAnnouncementUrgency('normal');
                    }}
                    className={`px-3 py-1.5 min-h-[34px] rounded-xl text-xs font-medium cursor-pointer transition-colors ${
                      announcementUrgency === 'normal'
                        ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613]'
                        : 'glass-subtle text-[#82796F] dark:text-[#A89F95]'
                    }`}
                  >
                    Standard Notice
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setAnnouncementUrgency('high');
                    }}
                    className={`px-3 py-1.5 min-h-[34px] rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                      announcementUrgency === 'high'
                        ? 'bg-[#D98BA5] text-[#171613]'
                        : 'bg-[#F6E2E6] dark:bg-[#D98BA5]/20 text-[#171613] dark:text-[#F5EFE3] border border-[#D98BA5]/50'
                    }`}
                  >
                    Urgent Notice
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-[#82796F] dark:text-[#A89F95]">
                  Announcement Message
                </label>
                <MentionInput
                  as="textarea"
                  placeholder="Share an event update, meetup spot, or tag @username..."
                  value={announcementText}
                  onChange={setAnnouncementText}
                  communityId={selectedCommunity.id}
                  placement="below"
                  rows={4}
                  className="w-full p-3 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] resize-none font-serif leading-relaxed"
                  autoFocus
                />
              </div>

              {announcementImageUpload?.active && (
                <div className="px-3 py-2 rounded-xl glass-subtle text-[11px] flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[#171613] dark:text-[#F5EFE3]">
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin text-[#C4718E]" />
                      <span>{announcementImageUpload.label}</span>
                    </span>
                    <span className="font-mono tabular-nums text-[#82796F] dark:text-[#A89F95]">
                      {announcementImageUpload.progress}%
                    </span>
                  </div>
                  <div className="w-full h-1 bg-[#E8DDCC] dark:bg-[#2E2B25] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#D98BA5] transition-all duration-200"
                      style={{ width: `${announcementImageUpload.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {announcementImageError && (
                <div className="px-3 py-2 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-[11px] text-[#171613] dark:text-[#F5EFE3] flex items-center justify-between gap-2">
                  <span>{announcementImageError}</span>
                  <button
                    type="button"
                    onClick={() => setAnnouncementImageError(null)}
                    className="underline shrink-0 cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {announcementImages.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {announcementImages.map((imgUrl, idx) => (
                    <div
                      key={idx}
                      className="relative w-16 h-16 rounded-xl overflow-hidden border border-[#171613]/12 dark:border-[#F5EFE3]/15"
                    >
                      <img src={imgUrl} alt={`Announcement photo ${idx + 1}`} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('close');
                          setAnnouncementImages((prev) => prev.filter((_, i) => i !== idx));
                        }}
                        aria-label={`Remove photo ${idx + 1}`}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-[#171613]/85 text-[#FFFCF7] flex items-center justify-center cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 flex-wrap">
                <input
                  ref={announcementFileInputRef}
                  type="file"
                  accept={IMAGE_UPLOAD_ACCEPT}
                  multiple
                  onChange={(e) => {
                    handleAttachImagesForComposer(e.target.files, 'announcement');
                    e.currentTarget.value = '';
                  }}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={
                    Boolean(announcementImageUpload?.active) ||
                    announcementImages.length >= MAX_ATTACHMENTS_POST ||
                    isSubmitting
                  }
                  onClick={() => {
                    triggerHaptic('tap');
                    announcementFileInputRef.current?.click();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-xl glass-subtle text-xs font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer disabled:opacity-45"
                >
                  <Camera className="w-3.5 h-3.5 text-[#C4718E]" />
                  <span>Attach Photo ({announcementImages.length}/{MAX_ATTACHMENTS_POST})</span>
                </button>
                <span className="text-[10px] font-mono text-[#82796F] dark:text-[#A89F95]">
                  {IMAGE_UPLOAD_GUIDANCE}
                </span>
              </div>

              <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] italic glass-subtle p-3 rounded-xl">
                Announcement will appear in the pinned announcements tab for all {selectedCommunity.memberCount} members.
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10">
                <GlassButton variant="ghost" size="sm" onClick={() => setIsAnnouncementModalOpen(false)} disabled={isSubmitting}>
                  Cancel
                </GlassButton>
                <GlassButton
                  type="submit"
                  variant="pink"
                  size="sm"
                  loading={isSubmitting}
                  disabled={
                    isSubmitting ||
                    Boolean(announcementImageUpload?.active) ||
                    (!announcementText.trim() && announcementImages.length === 0)
                  }
                >
                  {isSubmitting ? 'Posting...' : 'Post Announcement'}
                </GlassButton>
              </div>
            </form>
          )}
        </GlassModal>

        <Suspense fallback={null}>
          {reportTargetPost && (
            <ReportPostModal
              post={reportTargetPost}
              isOpen={Boolean(reportTargetPost)}
              onClose={() => setReportTargetPost(null)}
              onSubmit={async (postId, reason, details) => {
                await api.createReport({
                  target_type: 'post',
                  target_id: postId,
                  reason,
                  details,
                });
                setReportedPostIds((prev) => {
                  const next = new Set(prev);
                  next.add(postId);
                  return next;
                });
                showNotice('Report submitted to Admin moderation.');
              }}
            />
          )}

          {lightboxState && (
            <ImageViewerModal
              isOpen={Boolean(lightboxState)}
              images={lightboxState.images}
              initialIndex={lightboxState.index}
              title={lightboxState.title}
              onClose={() => setLightboxState(null)}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
};

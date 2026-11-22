import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  Clock,
  Compass,
  CornerDownRight,
  Eye,
  Feather,
  Flag,
  Flame,
  Heart,
  Loader2,
  MapPin,
  Megaphone,
  MessageCircle,
  Navigation,
  Pencil,
  Pin,
  RefreshCw,
  Repeat2,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import {
  CampusLocation,
  FeedCategory,
  FeedFilter,
  LocationFilterKey,
  Notice,
  Post,
  PostComment,
  PresenceSummary,
  StudentProfile,
  UpdatesView,
  UserSearchResult,
} from '../types';
import { useSavedLocations } from '../utils/useSavedLocations';
import { api } from '../api/client';
import {
  CAMPUS_AREA_OPTIONS,
  getLocationFilterLabel,
  snapCoordsToArea,
} from '../data/locationAreas';
import { LocationBadge } from '../components/map/LocationBadge';
import { PostImageGrid } from '../components/common/PostImageGrid';
import { PostPollCard } from '../components/common/PostPollCard';
import { UserAvatar } from '../components/common/UserAvatar';
import { FeedSkeleton } from '../components/common/Skeletons';
import { GlassButton, GlassCard, GlassTab } from '../components/glass';
import { MentionText } from '../components/common/MentionText';
import {
  MentionInput,
  MentionSuggestionsDropdown,
  useMentionAutocomplete,
} from '../components/common/MentionInput';
import {
  compressMultipleImages,
  IMAGE_UPLOAD_ACCEPT,
  IMAGE_UPLOAD_GUIDANCE,
  MAX_ATTACHMENTS_POST,
} from '../utils/imageCompression';
import { triggerHaptic } from '../utils/haptics';

const LocationViewModal = lazy(() =>
  import('../components/map/LocationViewModal').then((m) => ({ default: m.LocationViewModal }))
);
const ImageViewerModal = lazy(() =>
  import('../components/common/ImageViewerModal').then((m) => ({ default: m.ImageViewerModal }))
);
const ReportPostModal = lazy(() =>
  import('../components/common/ReportPostModal').then((m) => ({ default: m.ReportPostModal }))
);

interface HomePageProps {
  posts: Post[];
  notices: Notice[];
  onToggleLike: (postId: string) => void;
  onToggleRepost?: (postId: string) => void;
  onToggleSave: (postId: string) => void;
  onAddComment: (
    postId: string,
    commentText: string,
    parentCommentId?: string,
    images?: string[]
  ) => Promise<boolean> | void;
  onEditPost?: (postId: string, content: string) => Promise<boolean> | void;
  onDeletePost?: (postId: string) => Promise<boolean> | void;
  onEditComment?: (postId: string, commentId: string, content: string) => Promise<boolean> | void;
  onDeleteComment?: (postId: string, commentId: string) => Promise<boolean> | void;
  onVotePoll?: (postId: string, optionId: string) => void;
  onOpenCompose: () => void;
  onNavigateToUpdates: (view?: UpdatesView) => void;
  onReportPost?: (postId: string, reason: string, details?: string) => Promise<void>;
  onViewUserProfile?: (userId: string) => void;
  onNotify?: (message: string) => void;
  onRequireAuth?: () => void;
  isAuthenticated?: boolean;
  profile: StudentProfile;
  onlinePresence?: PresenceSummary | null;
  focusedPostId?: string | null;
  activeFilter?: FeedFilter;
  onFilterChange?: (filter: FeedFilter) => void;
  activeCategory?: FeedCategory;
  onCategoryChange?: (category: FeedCategory) => void;
  activeLocation?: LocationFilterKey;
  onLocationChange?: (location: LocationFilterKey) => void;
  onUpdateLocationConsent?: (enabled: boolean, preferredArea: string | null) => Promise<void> | void;
  onTrackViews?: (postIds: string[]) => void;
  onSharePostTracked?: (postId: string) => void;
  hasMorePosts?: boolean;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  feedError?: string | null;
  onLoadMore?: () => void;
  onRetryLoad?: () => void;
}

interface PostCardProps {
  post: Post;
  currentUserId?: string;
  currentUserRole?: string;
  isCommentsOpen: boolean;
  commentInput: string;
  commentImages: string[];
  commentImageUpload?: { active: boolean; progress: number; label: string } | null;
  commentImageError?: string | null;
  isCommentSubmitting?: boolean;
  replyTarget: PostComment | null;
  isCopied: boolean;
  isReported: boolean;
  onToggleLike: (postId: string) => void;
  onToggleRepost?: (postId: string) => void;
  onToggleSave: (postId: string) => void;
  onVotePoll?: (postId: string, optionId: string) => void;
  onToggleComments: (postId: string) => void;
  onCommentInputChange: (postId: string, val: string) => void;
  onAddCommentImages: (postId: string, files: FileList | null) => void;
  onRemoveCommentImage: (postId: string, index: number) => void;
  onDismissCommentImageError: (postId: string) => void;
  onSetReplyTarget: (postId: string, target: PostComment | null) => void;
  onCommentSubmit: (postId: string, e: React.FormEvent) => void;
  onEditPost?: (postId: string, content: string) => Promise<boolean> | void;
  onDeletePost?: (postId: string) => Promise<boolean> | void;
  onEditComment?: (postId: string, commentId: string, content: string) => Promise<boolean> | void;
  onDeleteComment?: (postId: string, commentId: string) => Promise<boolean> | void;
  onShare: (post: Post) => void;
  onOpenReport: (post: Post) => void;
  onViewUserProfile?: (userId: string) => void;
  onPreviewLocation: (loc: CampusLocation, directions: boolean) => void;
  onOpenLightbox: (images: string[], idx: number, title: string) => void;
  onPostVisible?: (postId: string) => void;
}

const PostCard: React.FC<PostCardProps> = memo(
  ({
    post,
    currentUserId,
    currentUserRole,
    isCommentsOpen,
    commentInput,
    commentImages,
    commentImageUpload,
    commentImageError,
    isCommentSubmitting = false,
    replyTarget,
    isCopied,
    isReported,
    onToggleLike,
    onToggleRepost,
    onToggleSave,
    onVotePoll,
    onToggleComments,
    onCommentInputChange,
    onAddCommentImages,
    onRemoveCommentImage,
    onDismissCommentImageError,
    onSetReplyTarget,
    onCommentSubmit,
    onEditPost,
    onDeletePost,
    onEditComment,
    onDeleteComment,
    onShare,
    onOpenReport,
    onViewUserProfile,
    onPreviewLocation,
    onOpenLightbox,
    onPostVisible,
  }) => {
    const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(() => new Set());
    const [isEditingPost, setIsEditingPost] = useState(false);
    const [postEditDraft, setPostEditDraft] = useState(post.content);
    const [isSavingPostEdit, setIsSavingPostEdit] = useState(false);
    const [confirmDeletePost, setConfirmDeletePost] = useState(false);
    const [isDeletingPost, setIsDeletingPost] = useState(false);

    const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
    const [commentEditDraft, setCommentEditDraft] = useState('');
    const [isSavingCommentEdit, setIsSavingCommentEdit] = useState(false);
    const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<string | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const commentFileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
      if (!onPostVisible || typeof IntersectionObserver === 'undefined') return;
      const node = cardRef.current;
      if (!node) return;
      let timer: number | null = null;
      let fired = false;

      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry) return;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.45 && !fired) {
            if (timer === null) {
              timer = window.setTimeout(() => {
                fired = true;
                onPostVisible(post.id);
                observer.disconnect();
              }, 900);
            }
          } else if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
          }
        },
        { threshold: [0.45] }
      );

      observer.observe(node);
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        observer.disconnect();
      };
    }, [onPostVisible, post.id]);

    useEffect(() => {
      if (!isEditingPost) {
        setPostEditDraft(post.content);
      }
    }, [isEditingPost, post.content]);

    const commentMention = useMentionAutocomplete({
      value: commentInput,
      onChange: (val) => onCommentInputChange(post.id, val),
      communityId: post.communityId,
      enabled: isCommentsOpen && !isCommentSubmitting,
    });

    const canClickAuthor = Boolean(!post.isAnonymous && post.authorId && onViewUserProfile);
    const isPostAuthor = Boolean(currentUserId && post.authorId && currentUserId === post.authorId);
    const canDeletePost = Boolean(isPostAuthor || currentUserRole === 'admin');

    const { topLevelComments, repliesByParent } = useMemo(() => {
      const byId = new Set(post.comments.map((c) => c.id));
      const top: PostComment[] = [];
      const replies = new Map<string, PostComment[]>();
      for (const c of post.comments) {
        if (c.parentCommentId && byId.has(c.parentCommentId)) {
          const list = replies.get(c.parentCommentId) || [];
          list.push(c);
          replies.set(c.parentCommentId, list);
        } else {
          top.push(c);
        }
      }
      return { topLevelComments: top, repliesByParent: replies };
    }, [post.comments]);

    const toggleThreadExpand = (commentId: string) => {
      triggerHaptic('tap');
      setExpandedThreadIds((prev) => {
        const next = new Set(prev);
        if (next.has(commentId)) next.delete(commentId);
        else next.add(commentId);
        return next;
      });
    };

    const handleSavePostEdit = async () => {
      if (!onEditPost || !postEditDraft.trim()) return;
      setIsSavingPostEdit(true);
      try {
        const res = await onEditPost(post.id, postEditDraft.trim());
        if (res !== false) {
          setIsEditingPost(false);
        }
      } finally {
        setIsSavingPostEdit(false);
      }
    };

    const handleDeletePostConfirm = async () => {
      if (!onDeletePost) return;
      setIsDeletingPost(true);
      try {
        await onDeletePost(post.id);
      } finally {
        setIsDeletingPost(false);
        setConfirmDeletePost(false);
      }
    };

    const handleSaveCommentEdit = async (commentId: string) => {
      if (!onEditComment || !commentEditDraft.trim()) return;
      setIsSavingCommentEdit(true);
      try {
        const res = await onEditComment(post.id, commentId, commentEditDraft.trim());
        if (res !== false) {
          setEditingCommentId(null);
          setCommentEditDraft('');
        }
      } finally {
        setIsSavingCommentEdit(false);
      }
    };

    return (
      <div ref={cardRef}>
        <GlassCard
          tone={post.isAdminPost || post.isAnnouncement ? 'cream' : 'subtle'}
          padding="md"
          className={`hover:bg-[#FFFCF7]/72 dark:hover:bg-[#1E1C18]/90 transition-colors ${
            post.isAdminPost || post.isAnnouncement
              ? 'border-[#C4718E]/45 dark:border-[#D98BA5]/40'
              : ''
          }`}
        >
        {(post.isAdminPost || post.isAnnouncement || post.isPinned || post.isFeatured) && (
          <div className="flex flex-wrap items-center gap-2 pb-2.5 mb-2.5 border-b border-[#171613]/8 dark:border-[#F5EFE3]/10 text-[11px]">
            {(post.isAdminPost || post.isAnnouncement) && (
              <span className="inline-flex items-center gap-1.5 font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                <Megaphone className="w-3.5 h-3.5 shrink-0" />
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
            {post.isFeatured && (
              <span className="inline-flex items-center gap-1 font-medium text-[#82796F] dark:text-[#A89F95]">
                {(post.isAdminPost || post.isAnnouncement || post.isPinned) && <span aria-hidden="true">·</span>}
                <span>Featured</span>
              </span>
            )}
          </div>
        )}

        {/* Author Header */}
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            disabled={!canClickAuthor}
            onClick={() => canClickAuthor && post.authorId && onViewUserProfile?.(post.authorId)}
            className={`flex items-center gap-3 min-w-0 text-left ${
              canClickAuthor ? 'cursor-pointer group' : 'cursor-default'
            }`}
          >
            <UserAvatar
              name={post.authorName}
              initials={post.avatarInitials}
              bg={post.avatarBg}
              avatarUrl={post.avatarUrl}
              avatarThumbUrl={post.avatarThumbUrl}
              isAnonymous={post.isAnonymous}
              size="md"
              className="ring-2 ring-[#FFFCF7] dark:ring-[#181714]"
            />
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className={`text-sm font-semibold text-[#171613] dark:text-[#F5EFE3] truncate ${
                    canClickAuthor ? 'group-hover:text-[#C4718E] dark:group-hover:text-[#E5A4BA] transition-colors' : ''
                  }`}
                >
                  {post.authorName}
                </span>
                {post.verified && (
                  <ShieldCheck className="w-3.5 h-3.5 text-[#D98BA5] shrink-0" />
                )}
                <span className="text-xs text-[#82796F] dark:text-[#A89F95] font-mono">{post.authorHandle}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-[#82796F] dark:text-[#A89F95] flex-wrap">
                <span>{post.department}</span>
                <span aria-hidden="true">·</span>
                <span>{post.level}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {post.timestamp}
                  {post.isEdited ? ' · (edited)' : ''}
                </span>
              </div>
            </div>
          </button>

          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
            {post.isTrending && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#C4718E] dark:text-[#E5A4BA] bg-[#F6E2E6]/90 dark:bg-[#D98BA5]/20 border border-[#D98BA5]/45 px-2 py-0.5 rounded-md whitespace-nowrap shrink-0">
                <Flame className="w-3 h-3 shrink-0" />
                <span>Trending</span>
              </span>
            )}
            {post.areaLabel && !post.location && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#171613] dark:text-[#F5EFE3] bg-[#E8DDCC]/75 dark:bg-[#23211C] border border-[#171613]/10 dark:border-[#F5EFE3]/15 px-2 py-0.5 rounded-md whitespace-nowrap shrink-0">
                <MapPin className="w-2.5 h-2.5 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
                <span>{post.areaLabel}</span>
              </span>
            )}
            {(post.schoolTag || post.hostelTag) && (
              <span className="text-[11px] font-semibold text-[#171613] dark:text-[#F5EFE3] bg-[#F6E2E6]/85 dark:bg-[#D98BA5]/20 border border-[#D98BA5]/35 px-2.5 py-0.5 rounded-md whitespace-nowrap shrink-0">
                {post.schoolTag || post.hostelTag}
              </span>
            )}
            {(isPostAuthor || canDeletePost) && !isEditingPost && (
              <div className="flex items-center gap-0.5">
                {isPostAuthor && onEditPost && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setPostEditDraft(post.content);
                      setIsEditingPost(true);
                    }}
                    aria-label="Edit post"
                    title="Edit post"
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/55 dark:hover:bg-[#23211C] cursor-pointer transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                {canDeletePost && onDeletePost && (
                  confirmDeletePost ? (
                    <div className="flex items-center gap-1 ml-1">
                      <button
                        type="button"
                        disabled={isDeletingPost}
                        onClick={handleDeletePostConfirm}
                        className="px-2 py-1 rounded-lg bg-[#C4718E] text-[#FFFCF7] text-[10px] font-semibold cursor-pointer"
                      >
                        {isDeletingPost ? '...' : 'Delete'}
                      </button>
                      <button
                        type="button"
                        disabled={isDeletingPost}
                        onClick={() => setConfirmDeletePost(false)}
                        className="px-2 py-1 rounded-lg glass-subtle text-[10px] text-[#82796F] dark:text-[#A89F95] cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('tap');
                        setConfirmDeletePost(true);
                      }}
                      aria-label="Delete post"
                      title="Delete post"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:text-[#C4718E] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/20 cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        </div>

        {/* Post Content / Inline Edit */}
        {isEditingPost ? (
          <div className="mt-3.5 flex flex-col gap-2">
            <MentionInput
              as="textarea"
              value={postEditDraft}
              onChange={setPostEditDraft}
              communityId={post.communityId}
              placement="below"
              rows={3}
              disabled={isSavingPostEdit}
              autoFocus
              className="w-full p-3 glass-input rounded-xl text-sm text-[#171613] dark:text-[#F5EFE3] resize-none leading-relaxed"
            />
            <div className="flex items-center justify-end gap-2">
              <GlassButton
                variant="ghost"
                size="sm"
                onClick={() => setIsEditingPost(false)}
                disabled={isSavingPostEdit}
              >
                Cancel
              </GlassButton>
              <GlassButton
                variant="pink"
                size="sm"
                loading={isSavingPostEdit}
                disabled={!postEditDraft.trim() || isSavingPostEdit}
                onClick={handleSavePostEdit}
              >
                Save Changes
              </GlassButton>
            </div>
          </div>
        ) : (
          <div className="mt-3.5 text-sm md:text-[15px] leading-relaxed text-[#171613] dark:text-[#F5EFE3] break-words whitespace-pre-wrap">
            <MentionText
              text={post.content}
              mentions={post.mentions}
              onMentionClick={onViewUserProfile}
            />
          </div>
        )}

        {/* Interactive Poll */}
        {post.poll && <PostPollCard postId={post.id} poll={post.poll} onVote={onVotePoll} />}

        {/* Attached Photos */}
        {post.images && post.images.length > 0 && (
          <PostImageGrid
            images={post.images}
            onImageClick={(idx) =>
              onOpenLightbox(
                post.images || [],
                idx,
                `${post.authorName} (${post.department})`
              )
            }
          />
        )}

        {/* Pinned Spot */}
        {post.location && (
          <div className="mt-3">
            <LocationBadge
              location={post.location}
              onClick={() => onPreviewLocation(post.location!, false)}
              onDirectionsClick={() => onPreviewLocation(post.location!, true)}
              showCoordinates
            />
          </div>
        )}

        {/* Action Bar */}
        <div className="mt-4 pt-3 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 flex flex-wrap items-center justify-between gap-x-1 gap-y-1.5 text-xs text-[#82796F] dark:text-[#A89F95]">
          <div className="flex flex-wrap items-center gap-0.5 sm:gap-1.5">
            <button
              type="button"
              onClick={() => onToggleLike(post.id)}
              aria-label="Like post"
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-xl transition-colors cursor-pointer min-h-[40px] tabular-nums whitespace-nowrap shrink-0 ${
                post.isLiked
                  ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#171613] dark:text-[#F5EFE3] font-semibold'
                  : 'hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C]'
              }`}
            >
              <Heart
                className={`w-4 h-4 shrink-0 ${post.isLiked ? 'fill-[#D98BA5] stroke-[#D98BA5]' : ''}`}
              />
              <span className="font-mono">{post.likes}</span>
            </button>

            <button
              type="button"
              onClick={() => onToggleComments(post.id)}
              aria-label="Toggle comments"
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-xl transition-colors cursor-pointer min-h-[40px] tabular-nums whitespace-nowrap shrink-0 ${
                isCommentsOpen
                  ? 'bg-[#E8DDCC]/80 dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3] font-semibold'
                  : 'hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C]'
              }`}
            >
              <MessageCircle className="w-4 h-4 shrink-0" />
              <span className="font-mono">{post.comments.length || post.commentsCount}</span>
            </button>

            <button
              type="button"
              onClick={() => onToggleRepost?.(post.id)}
              aria-label="Repost"
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-xl transition-colors cursor-pointer min-h-[40px] tabular-nums whitespace-nowrap shrink-0 ${
                post.isReposted
                  ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#C4718E] dark:text-[#E5A4BA] font-semibold'
                  : 'hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C]'
              }`}
            >
              <Repeat2 className="w-4 h-4 shrink-0" />
              <span className="font-mono">{post.reposts}</span>
            </button>

            <span
              aria-label={`${post.viewsCount ?? 0} views`}
              title="Unique views"
              className="flex items-center gap-1 px-1.5 sm:px-2 py-1 min-h-[40px] text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono tabular-nums whitespace-nowrap shrink-0"
            >
              <Eye className="w-3.5 h-3.5 shrink-0" />
              <span>{post.viewsCount ?? 0}</span>
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onToggleSave(post.id)}
              aria-label="Bookmark post"
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                post.isSaved
                  ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613]'
                  : 'hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C]'
              }`}
            >
              <Bookmark
                className={`w-4 h-4 ${post.isSaved ? 'fill-current' : ''}`}
              />
            </button>

            <button
              type="button"
              onClick={() => onShare(post)}
              aria-label="Share post"
              className="w-10 h-10 rounded-xl flex items-center justify-center hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] transition-colors cursor-pointer shrink-0"
            >
              {isCopied ? (
                <Check className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
              ) : (
                <Share2 className="w-4 h-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => onOpenReport(post)}
              disabled={isReported}
              aria-label={isReported ? 'Post reported' : 'Report post'}
              title={isReported ? 'Reported to Admin moderation' : 'Report inappropriate content'}
              className={`min-h-[40px] px-2.5 rounded-xl flex items-center gap-1 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                isReported
                  ? 'bg-[#F6E2E6]/80 dark:bg-[#D98BA5]/20 text-[#C4718E] dark:text-[#E5A4BA] border border-[#D98BA5]/40 cursor-default'
                  : 'hover:text-[#C4718E] dark:hover:text-[#E5A4BA] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/15 cursor-pointer'
              }`}
            >
              <Flag className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">{isReported ? 'Reported' : 'Report'}</span>
            </button>
          </div>
        </div>

        {/* Expandable Comments & Reply Threads */}
        {isCommentsOpen && (
          <div className="mt-3 pt-3 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10 flex flex-col gap-3 animate-sb-in">
            <div className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
              Comments ({post.comments.length})
            </div>

            {topLevelComments.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                {topLevelComments.map((comment) => {
                  const childReplies = repliesByParent.get(comment.id) || [];
                  const isExpanded = expandedThreadIds.has(comment.id) || childReplies.length <= 2;
                  const visibleReplies = isExpanded ? childReplies : childReplies.slice(0, 1);
                  const isCommentAuthor = Boolean(
                    currentUserId && comment.authorId && currentUserId === comment.authorId
                  );
                  const canDeleteComment = Boolean(isCommentAuthor || currentUserRole === 'admin');
                  const isEditingThisComment = editingCommentId === comment.id;

                  return (
                    <div key={comment.id} className="flex flex-col gap-1.5">
                      <div className="bg-[#FFFCF7]/75 dark:bg-[#23211C] rounded-xl p-3 text-xs text-[#171613] dark:text-[#F5EFE3] border border-[#171613]/8 dark:border-[#F5EFE3]/10">
                        <div className="flex items-center justify-between text-[#82796F] dark:text-[#A89F95] mb-1 gap-2 flex-wrap">
                          <button
                            type="button"
                            disabled={!comment.authorId || !onViewUserProfile}
                            onClick={() =>
                              comment.authorId && onViewUserProfile?.(comment.authorId)
                            }
                            className={`flex items-center gap-2 font-semibold text-[#171613] dark:text-[#F5EFE3] text-left min-w-0 break-words ${
                              comment.authorId && onViewUserProfile
                                ? 'hover:text-[#C4718E] dark:hover:text-[#E5A4BA] cursor-pointer'
                                : 'cursor-default'
                            }`}
                          >
                            <UserAvatar
                              name={comment.authorName}
                              initials={comment.avatarInitials}
                              bg={comment.avatarBg}
                              avatarUrl={comment.avatarUrl}
                              avatarThumbUrl={comment.avatarThumbUrl}
                              size="xs"
                            />
                            <span className="truncate">
                              {comment.authorName}{' '}
                              <span className="font-normal font-mono text-[11px] text-[#82796F] dark:text-[#A89F95]">
                                {comment.authorHandle}
                              </span>
                            </span>
                          </button>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="font-mono text-[10px]">
                              {comment.timestamp}
                              {comment.isEdited ? ' · (edited)' : ''}
                            </span>
                            {(isCommentAuthor || canDeleteComment) && !isEditingThisComment && !comment.id.startsWith('temp-c-') && (
                              <>
                                {isCommentAuthor && onEditComment && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      triggerHaptic('tap');
                                      setEditingCommentId(comment.id);
                                      setCommentEditDraft(comment.content);
                                    }}
                                    aria-label="Edit comment"
                                    className="p-1 rounded hover:bg-[#E8DDCC]/60 dark:hover:bg-[#2A2722] cursor-pointer"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                                {canDeleteComment && onDeleteComment && (
                                  confirmDeleteCommentId === comment.id ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        onDeleteComment(post.id, comment.id);
                                        setConfirmDeleteCommentId(null);
                                      }}
                                      className="px-1.5 py-0.5 rounded bg-[#C4718E] text-[#FFFCF7] text-[10px] font-semibold cursor-pointer"
                                    >
                                      Confirm
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        triggerHaptic('tap');
                                        setConfirmDeleteCommentId(comment.id);
                                      }}
                                      aria-label="Delete comment"
                                      className="p-1 rounded hover:bg-[#F6E2E6] dark:hover:bg-[#D98BA5]/20 hover:text-[#C4718E] cursor-pointer"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        {isEditingThisComment ? (
                          <div className="flex flex-col gap-2 mt-1">
                            <MentionInput
                              as="input"
                              value={commentEditDraft}
                              onChange={setCommentEditDraft}
                              communityId={post.communityId}
                              placement="above"
                              disabled={isSavingCommentEdit}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  if (commentEditDraft.trim()) handleSaveCommentEdit(comment.id);
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setEditingCommentId(null);
                                }
                              }}
                              className="w-full min-h-[38px] glass-input rounded-lg px-2.5 py-1.5 text-xs text-[#171613] dark:text-[#F5EFE3]"
                            />
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setEditingCommentId(null)}
                                className="px-2 py-1 text-[11px] text-[#82796F] dark:text-[#A89F95] cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={isSavingCommentEdit || !commentEditDraft.trim()}
                                onClick={() => handleSaveCommentEdit(comment.id)}
                                className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] text-[11px] font-semibold cursor-pointer"
                              >
                                {isSavingCommentEdit ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {comment.content && (
                              <p className="leading-relaxed break-words whitespace-pre-wrap">
                                <MentionText
                                  text={comment.content}
                                  mentions={comment.mentions}
                                  onMentionClick={onViewUserProfile}
                                />
                              </p>
                            )}
                            {comment.images && comment.images.length > 0 && (
                              <PostImageGrid
                                images={comment.images}
                                onImageClick={(idx) =>
                                  onOpenLightbox(
                                    comment.images!,
                                    idx,
                                    `${comment.authorName}'s comment photo`
                                  )
                                }
                                className="max-w-sm mt-2"
                              />
                            )}
                          </>
                        )}
                        <div className="mt-1.5 flex items-center gap-3 text-[11px]">
                          <button
                            type="button"
                            onClick={() => onSetReplyTarget(post.id, comment)}
                            className="inline-flex items-center gap-1 font-semibold text-[#82796F] dark:text-[#A89F95] hover:text-[#C4718E] dark:hover:text-[#E5A4BA] cursor-pointer py-0.5"
                          >
                            <CornerDownRight className="w-3 h-3" />
                            <span>Reply</span>
                          </button>
                          {childReplies.length > 0 && (
                            <span className="text-[#82796F] dark:text-[#A89F95] font-mono">
                              {childReplies.length}{' '}
                              {childReplies.length === 1 ? 'reply' : 'replies'}
                            </span>
                          )}
                        </div>
                      </div>

                      {visibleReplies.length > 0 && (
                        <div className="ml-4 pl-3 border-l-2 border-[#D98BA5]/45 flex flex-col gap-1.5">
                          {visibleReplies.map((reply) => {
                            const isReplyAuthor = Boolean(
                              currentUserId && reply.authorId && currentUserId === reply.authorId
                            );
                            const canDeleteReply = Boolean(isReplyAuthor || currentUserRole === 'admin');
                            const isEditingThisReply = editingCommentId === reply.id;

                            return (
                              <div
                                key={reply.id}
                                className="bg-[#F5EFE3]/70 dark:bg-[#1E1C18] rounded-xl p-2.5 text-xs text-[#171613] dark:text-[#F5EFE3] border border-[#171613]/6 dark:border-[#F5EFE3]/10"
                              >
                                <div className="flex items-center justify-between text-[#82796F] dark:text-[#A89F95] mb-0.5 gap-2 flex-wrap">
                                  <button
                                    type="button"
                                    disabled={!reply.authorId || !onViewUserProfile}
                                    onClick={() =>
                                      reply.authorId && onViewUserProfile?.(reply.authorId)
                                    }
                                    className={`flex items-center gap-1.5 font-semibold text-[#171613] dark:text-[#F5EFE3] text-left min-w-0 break-words ${
                                      reply.authorId && onViewUserProfile
                                        ? 'hover:text-[#C4718E] dark:hover:text-[#E5A4BA] cursor-pointer'
                                        : 'cursor-default'
                                    }`}
                                  >
                                    <UserAvatar
                                      name={reply.authorName}
                                      initials={reply.avatarInitials}
                                      bg={reply.avatarBg}
                                      avatarUrl={reply.avatarUrl}
                                      avatarThumbUrl={reply.avatarThumbUrl}
                                      size="xs"
                                      className="w-6 h-6 text-[9px]"
                                    />
                                    <span className="truncate">
                                      {reply.authorName}{' '}
                                      <span className="font-normal font-mono text-[10px] text-[#82796F] dark:text-[#A89F95]">
                                        {reply.authorHandle}
                                      </span>
                                    </span>
                                  </button>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <span className="font-mono text-[10px]">
                                      {reply.timestamp}
                                      {reply.isEdited ? ' · (edited)' : ''}
                                    </span>
                                    {(isReplyAuthor || canDeleteReply) && !isEditingThisReply && !reply.id.startsWith('temp-c-') && (
                                      <>
                                        {isReplyAuthor && onEditComment && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              triggerHaptic('tap');
                                              setEditingCommentId(reply.id);
                                              setCommentEditDraft(reply.content);
                                            }}
                                            aria-label="Edit reply"
                                            className="p-0.5 rounded hover:bg-[#E8DDCC]/60 dark:hover:bg-[#2A2722] cursor-pointer"
                                          >
                                            <Pencil className="w-2.5 h-2.5" />
                                          </button>
                                        )}
                                        {canDeleteReply && onDeleteComment && (
                                          confirmDeleteCommentId === reply.id ? (
                                            <button
                                              type="button"
                                              onClick={() => {
                                                onDeleteComment(post.id, reply.id);
                                                setConfirmDeleteCommentId(null);
                                              }}
                                              className="px-1.5 py-0.5 rounded bg-[#C4718E] text-[#FFFCF7] text-[10px] font-semibold cursor-pointer"
                                            >
                                              Confirm
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() => {
                                                triggerHaptic('tap');
                                                setConfirmDeleteCommentId(reply.id);
                                              }}
                                              aria-label="Delete reply"
                                              className="p-0.5 rounded hover:bg-[#F6E2E6] dark:hover:bg-[#D98BA5]/20 hover:text-[#C4718E] cursor-pointer"
                                            >
                                              <Trash2 className="w-2.5 h-2.5" />
                                            </button>
                                          )
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                                {isEditingThisReply ? (
                                  <div className="flex flex-col gap-2 mt-1">
                                    <MentionInput
                                      as="input"
                                      value={commentEditDraft}
                                      onChange={setCommentEditDraft}
                                      communityId={post.communityId}
                                      placement="above"
                                      disabled={isSavingCommentEdit}
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                          e.preventDefault();
                                          if (commentEditDraft.trim()) handleSaveCommentEdit(reply.id);
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault();
                                          setEditingCommentId(null);
                                        }
                                      }}
                                      className="w-full min-h-[36px] glass-input rounded-lg px-2.5 py-1 text-xs text-[#171613] dark:text-[#F5EFE3]"
                                    />
                                    <div className="flex items-center justify-end gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => setEditingCommentId(null)}
                                        className="px-2 py-0.5 text-[11px] text-[#82796F] dark:text-[#A89F95] cursor-pointer"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isSavingCommentEdit || !commentEditDraft.trim()}
                                        onClick={() => handleSaveCommentEdit(reply.id)}
                                        className="px-2 py-0.5 rounded-lg bg-[#D98BA5] text-[#171613] text-[11px] font-semibold cursor-pointer"
                                      >
                                        {isSavingCommentEdit ? 'Saving...' : 'Save'}
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    {reply.content && (
                                      <p className="leading-relaxed break-words whitespace-pre-wrap">
                                        <MentionText
                                          text={reply.content}
                                          mentions={reply.mentions}
                                          onMentionClick={onViewUserProfile}
                                        />
                                      </p>
                                    )}
                                    {reply.images && reply.images.length > 0 && (
                                      <PostImageGrid
                                        images={reply.images}
                                        onImageClick={(idx) =>
                                          onOpenLightbox(
                                            reply.images!,
                                            idx,
                                            `${reply.authorName}'s reply photo`
                                          )
                                        }
                                        className="max-w-xs mt-1.5"
                                      />
                                    )}
                                  </>
                                )}
                              </div>
                            );
                          })}

                          {childReplies.length > 2 && (
                            <button
                              type="button"
                              onClick={() => toggleThreadExpand(comment.id)}
                              className="self-start text-[11px] font-semibold text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer py-0.5"
                            >
                              {isExpanded
                                ? 'Hide extra replies'
                                : `View all ${childReplies.length} replies`}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-[#82796F] dark:text-[#A89F95] italic py-1">
                No comments yet. Start the conversation below.
              </div>
            )}

            {replyTarget && (
              <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-[#F6E2E6]/75 dark:bg-[#D98BA5]/20 border border-[#D98BA5]/40 text-[11px] text-[#171613] dark:text-[#F5EFE3]">
                <span>
                  Replying to <strong className="font-mono">{replyTarget.authorHandle}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => onSetReplyTarget(post.id, null)}
                  aria-label="Cancel reply"
                  className="text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer p-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="flex flex-col gap-2 mt-0.5">
              {commentImageUpload?.active && (
                <div className="px-3 py-2 rounded-xl glass-subtle text-[11px] flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[#171613] dark:text-[#F5EFE3]">
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin text-[#C4718E]" />
                      <span>{commentImageUpload.label}</span>
                    </span>
                    <span className="font-mono tabular-nums text-[#82796F] dark:text-[#A89F95]">
                      {commentImageUpload.progress}%
                    </span>
                  </div>
                  <div className="w-full h-1 bg-[#E8DDCC] dark:bg-[#2E2B25] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#D98BA5] transition-all duration-200"
                      style={{ width: `${commentImageUpload.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {commentImageError && (
                <div className="px-3 py-2 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-[11px] text-[#171613] dark:text-[#F5EFE3] flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <AlertCircle className="w-3.5 h-3.5 text-[#C4718E] shrink-0" />
                    <span className="truncate">{commentImageError}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onDismissCommentImageError(post.id)}
                    className="underline shrink-0 cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {commentImages.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {commentImages.map((imgUrl, idx) => (
                    <div
                      key={idx}
                      className="relative w-14 h-14 rounded-xl overflow-hidden border border-[#171613]/12 dark:border-[#F5EFE3]/15 group"
                    >
                      <img src={imgUrl} alt={`Attachment ${idx + 1}`} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => onRemoveCommentImage(post.id, idx)}
                        aria-label={`Remove comment image ${idx + 1}`}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-[#171613]/85 text-[#FFFCF7] flex items-center justify-center cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <form
                onSubmit={(e) => onCommentSubmit(post.id, e)}
                className="relative flex items-center gap-2"
              >
                <MentionSuggestionsDropdown
                  isOpen={commentMention.isOpen}
                  candidates={commentMention.candidates}
                  isLoading={commentMention.isLoading}
                  selectedIndex={commentMention.selectedIndex}
                  query={commentMention.activeQuery?.query || ''}
                  placement="above"
                  onSelect={commentMention.selectCandidate}
                />

                <input
                  ref={commentFileInputRef}
                  type="file"
                  accept={IMAGE_UPLOAD_ACCEPT}
                  multiple
                  onChange={(e) => {
                    onAddCommentImages(post.id, e.target.files);
                    e.currentTarget.value = '';
                  }}
                  className="hidden"
                />

                <button
                  type="button"
                  disabled={Boolean(commentImageUpload?.active) || commentImages.length >= MAX_ATTACHMENTS_POST || isCommentSubmitting}
                  onClick={() => {
                    triggerHaptic('tap');
                    commentFileInputRef.current?.click();
                  }}
                  aria-label="Attach image to comment or reply"
                  title={`Attach up to ${MAX_ATTACHMENTS_POST} photos (${IMAGE_UPLOAD_GUIDANCE})`}
                  className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0 disabled:opacity-45 ${
                    commentImages.length > 0
                      ? 'bg-[#D98BA5] text-[#171613]'
                      : 'glass-subtle text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                  }`}
                >
                  {commentImageUpload?.active ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Camera className="w-4 h-4" />
                  )}
                </button>

                <input
                  ref={commentMention.inputRef as React.RefObject<HTMLInputElement>}
                  type="text"
                  value={commentInput}
                  onChange={commentMention.handleValueChange}
                  onClick={commentMention.handleCursorEvent}
                  onKeyUp={commentMention.handleCursorEvent}
                  onKeyDown={(e) => {
                    commentMention.handleKeyDown(e);
                  }}
                  onBlur={() => window.setTimeout(commentMention.dismiss, 160)}
                  placeholder={
                    replyTarget
                      ? `Reply to ${replyTarget.authorHandle} (type @ to tag)...`
                      : 'Write a comment (type @ to tag)...'
                  }
                  disabled={isCommentSubmitting}
                  className="flex-1 min-h-[40px] glass-input rounded-xl px-3.5 py-2 text-xs text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95]"
                />
                <GlassButton
                  type="submit"
                  variant="pink"
                  size="sm"
                  loading={isCommentSubmitting}
                  disabled={
                    (!commentInput.trim() && commentImages.length === 0) ||
                    isCommentSubmitting ||
                    Boolean(commentImageUpload?.active)
                  }
                >
                  {replyTarget ? 'Reply' : 'Post'}
                </GlassButton>
              </form>

              <div className="text-[10px] font-mono text-[#82796F] dark:text-[#A89F95] px-1">
                Photos: {commentImages.length}/{MAX_ATTACHMENTS_POST} · {IMAGE_UPLOAD_GUIDANCE}
              </div>
            </div>
          </div>
        )}
        </GlassCard>
      </div>
    );
  }
);

PostCard.displayName = 'PostCard';

export const HomePage: React.FC<HomePageProps> = ({
  posts,
  notices,
  onToggleLike,
  onToggleRepost,
  onToggleSave,
  onAddComment,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
  onVotePoll,
  onOpenCompose,
  onNavigateToUpdates,
  onReportPost,
  onViewUserProfile,
  onNotify,
  onRequireAuth,
  isAuthenticated,
  profile,
  onlinePresence,
  focusedPostId,
  activeFilter: controlledFilter,
  onFilterChange,
  activeCategory: controlledCategory,
  onCategoryChange,
  activeLocation: controlledLocation,
  onLocationChange,
  onUpdateLocationConsent,
  onTrackViews,
  onSharePostTracked,
  hasMorePosts = false,
  isLoading = false,
  isLoadingMore = false,
  feedError = null,
  onLoadMore,
  onRetryLoad,
}) => {
  const [localFilter, setLocalFilter] = useState<FeedFilter>('all');
  const [localCategory, setLocalCategory] = useState<FeedCategory>('for_you');
  const [localLocation, setLocalLocation] = useState<LocationFilterKey>('all');
  const activeFilter = controlledFilter ?? localFilter;
  const activeCategory = controlledCategory ?? localCategory;
  const activeLocation = controlledLocation ?? localLocation;

  const [isLocationMenuOpen, setIsLocationMenuOpen] = useState(false);
  const [isDetectingArea, setIsDetectingArea] = useState(false);
  const [isUpdatingLocationConsent, setIsUpdatingLocationConsent] = useState(false);
  const { savedLocations } = useSavedLocations();
  const trackedViewsSetRef = useRef<Set<string>>(new Set());
  const pendingViewIdsRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<number | null>(null);

  const [expandedCommentsPostId, setExpandedCommentsPostId] = useState<string | null>(
    focusedPostId || null
  );

  useEffect(() => {
    if (focusedPostId) {
      setExpandedCommentsPostId(focusedPostId);
    }
  }, [focusedPostId]);
  const [commentInputs, setCommentInputs] = useState<Record<string, string>>({});
  const [commentImagesMap, setCommentImagesMap] = useState<Record<string, string[]>>({});
  const [commentImageUploads, setCommentImageUploads] = useState<
    Record<string, { active: boolean; progress: number; label: string }>
  >({});
  const [commentImageErrors, setCommentImageErrors] = useState<Record<string, string>>({});
  const [commentSubmittingIds, setCommentSubmittingIds] = useState<Set<string>>(() => new Set());
  const [replyTargets, setReplyTargets] = useState<Record<string, PostComment | null>>({});
  const [copiedPostId, setCopiedPostId] = useState<string | null>(null);
  const [previewLocation, setPreviewLocation] = useState<CampusLocation | null>(null);
  const [openWithDirections, setOpenWithDirections] = useState(false);
  const [reportTargetPost, setReportTargetPost] = useState<Post | null>(null);
  const [reportedPostIds, setReportedPostIds] = useState<Set<string>>(() => new Set());
  const [lightboxState, setLightboxState] = useState<{
    isOpen: boolean;
    images: string[];
    initialIndex: number;
    title?: string;
  }>({
    isOpen: false,
    images: [],
    initialIndex: 0,
  });

  // People search state (Find friends by @username or name)
  const [friendQuery, setFriendQuery] = useState('');
  const [friendResults, setFriendResults] = useState<UserSearchResult[]>([]);
  const [isSearchingFriends, setIsSearchingFriends] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = friendQuery.trim();
    if (!q && !mobileSearchOpen) {
      setFriendResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearchingFriends(true);
      try {
        const res = await api.searchUsers(q, 8);
        setFriendResults(res);
      } catch {
        // Ignore transient search errors
      } finally {
        setIsSearchingFriends(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [friendQuery, mobileSearchOpen]);

  // Initial suggestions on desktop rail
  useEffect(() => {
    api
      .searchUsers('', 5)
      .then((res) => {
        if (res.length > 0) setFriendResults(res);
      })
      .catch(() => {});
  }, [profile.userId]);

  // Infinite scroll IntersectionObserver
  useEffect(() => {
    if (!hasMorePosts || !onLoadMore || isLoadingMore || feedError) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMore();
        }
      },
      { rootMargin: '250px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [feedError, hasMorePosts, isLoadingMore, onLoadMore, posts.length]);

  const handleSelectFilter = useCallback(
    (filter: FeedFilter) => {
      setLocalFilter(filter);
      onFilterChange?.(filter);
    },
    [onFilterChange]
  );

  const handleSelectCategory = useCallback(
    (category: FeedCategory) => {
      triggerHaptic('tap');
      setLocalCategory(category);
      onCategoryChange?.(category);
    },
    [onCategoryChange]
  );

  const handleSelectLocationFilter = useCallback(
    (location: LocationFilterKey) => {
      triggerHaptic('tap');
      setLocalLocation(location);
      setIsLocationMenuOpen(false);
      onLocationChange?.(location);
    },
    [onLocationChange]
  );

  const handleDetectNearestArea = useCallback(() => {
    if (!onUpdateLocationConsent) return;
    if (!signedIn) {
      onRequireAuth?.();
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      onNotify?.('Location detection is unavailable in this browser. Select an area manually below.');
      return;
    }
    setIsDetectingArea(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const snapped = snapCoordsToArea(pos.coords.latitude, pos.coords.longitude);
          if (!snapped) {
            onNotify?.('Could not match a nearby campus area. Select your area manually.');
            return;
          }
          await onUpdateLocationConsent(true, snapped.key);
          handleSelectLocationFilter('my_area');
          onNotify?.(`Area set to ${snapped.shortLabel} (exact GPS never stored).`);
        } finally {
          setIsDetectingArea(false);
        }
      },
      () => {
        setIsDetectingArea(false);
        onNotify?.('Location permission declined. You can still choose any area manually.');
      },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 180000 }
    );
  }, [handleSelectLocationFilter, onNotify, onRequireAuth, onUpdateLocationConsent]);

  const handlePostVisible = useCallback(
    (postId: string) => {
      if (!onTrackViews || trackedViewsSetRef.current.has(postId)) return;
      trackedViewsSetRef.current.add(postId);
      pendingViewIdsRef.current.add(postId);

      const flush = () => {
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        if (pendingViewIdsRef.current.size === 0) return;
        const batch = Array.from(pendingViewIdsRef.current);
        pendingViewIdsRef.current.clear();
        onTrackViews(batch);
      };

      if (pendingViewIdsRef.current.size >= 8) {
        flush();
      } else if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flush, 650);
      }
    },
    [onTrackViews]
  );

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  const filteredPosts = useMemo(() => {
    if (onFilterChange) return posts;
    return posts.filter((post) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'general') {
        return !post.schoolTag || ['General', 'Campus Life', 'Photos'].includes(post.schoolTag);
      }
      if (activeFilter === 'entertainment') {
        return ['Memes & Fun', 'Entertainment', 'Humor'].includes(post.schoolTag || '');
      }
      if (activeFilter === 'discussions') {
        return ['Discussions', 'Opinions'].includes(post.schoolTag || '');
      }
      if (activeFilter === 'soc') return post.schoolTag === 'SOC' || post.department.includes('Computer');
      if (activeFilter === 'seet') return post.schoolTag === 'SEET' || post.department.includes('Eng');
      if (activeFilter === 'hostel') {
        return (
          post.hostelTag !== undefined ||
          post.schoolTag === 'Hostels' ||
          post.content.toLowerCase().includes('hostel')
        );
      }
      return true;
    });
  }, [activeFilter, onFilterChange, posts]);

  const handleToggleComments = useCallback((postId: string) => {
    triggerHaptic('tap');
    setExpandedCommentsPostId((prev) => (prev === postId ? null : postId));
  }, []);

  const handleCommentInputChange = useCallback((postId: string, val: string) => {
    setCommentInputs((prev) => ({ ...prev, [postId]: val }));
  }, []);

  const handleSetReplyTarget = useCallback((postId: string, target: PostComment | null) => {
    triggerHaptic(target ? 'tap' : 'close');
    setReplyTargets((prev) => ({ ...prev, [postId]: target }));
  }, []);

  const handleDismissCommentImageError = useCallback((postId: string) => {
    setCommentImageErrors((prev) => {
      const next = { ...prev };
      delete next[postId];
      return next;
    });
  }, []);

  const handleRemoveCommentImage = useCallback((postId: string, index: number) => {
    triggerHaptic('close');
    setCommentImagesMap((prev) => {
      const current = prev[postId] || [];
      return { ...prev, [postId]: current.filter((_, i) => i !== index) };
    });
  }, []);

  const handleAddCommentImages = useCallback(
    async (postId: string, files: FileList | null) => {
      if (!files || files.length === 0) return;
      const isSignedIn = isAuthenticated ?? Boolean(profile.userId);
      if (!isSignedIn) {
        onRequireAuth?.();
        return;
      }

      const existing = commentImagesMap[postId] || [];
      const remaining = MAX_ATTACHMENTS_POST - existing.length;
      if (remaining <= 0) {
        setCommentImageErrors((prev) => ({
          ...prev,
          [postId]: `Maximum ${MAX_ATTACHMENTS_POST} photos allowed per comment or reply.`,
        }));
        return;
      }

      setCommentImageErrors((prev) => {
        const next = { ...prev };
        delete next[postId];
        return next;
      });
      setCommentImageUploads((prev) => ({
        ...prev,
        [postId]: { active: true, progress: 5, label: 'Optimizing photo...' },
      }));

      try {
        const { results, error } = await compressMultipleImages(files, remaining, (pct) => {
          setCommentImageUploads((prev) => ({
            ...prev,
            [postId]: {
              active: true,
              progress: Math.max(5, Math.round(pct * 0.5)),
              label: 'Optimizing photo...',
            },
          }));
        });

        if (error) {
          triggerHaptic('error');
          setCommentImageErrors((prev) => ({ ...prev, [postId]: error }));
          return;
        }

        const uploadedUrls: string[] = [];
        for (let i = 0; i < results.length; i++) {
          const item = results[i];
          const uploaded = await api.uploadImage(item.dataUrl, item.thumbnailDataUrl, (pct) => {
            const totalPct = Math.min(99, 50 + Math.round(((i + pct / 100) / Math.max(1, results.length)) * 50));
            setCommentImageUploads((prev) => ({
              ...prev,
              [postId]: { active: true, progress: totalPct, label: 'Uploading photo...' },
            }));
          });
          uploadedUrls.push(uploaded.url);
        }

        if (uploadedUrls.length > 0) {
          setCommentImagesMap((prev) => ({
            ...prev,
            [postId]: [...(prev[postId] || []), ...uploadedUrls].slice(0, MAX_ATTACHMENTS_POST),
          }));
          triggerHaptic('success');
        }
      } catch (err: any) {
        triggerHaptic('error');
        setCommentImageErrors((prev) => ({
          ...prev,
          [postId]: err?.message || 'Failed to upload comment image.',
        }));
      } finally {
        setCommentImageUploads((prev) => ({
          ...prev,
          [postId]: { active: false, progress: 0, label: '' },
        }));
      }
    },
    [commentImagesMap, isAuthenticated, onRequireAuth, profile.userId]
  );

  const handleCommentSubmit = useCallback(
    async (postId: string, e: React.FormEvent) => {
      e.preventDefault();
      if (commentSubmittingIds.has(postId)) return;
      const text = (commentInputs[postId] || '').trim();
      const images = commentImagesMap[postId] || [];
      if (!text && images.length === 0) return;
      const parentId = replyTargets[postId]?.id;

      setCommentSubmittingIds((prev) => {
        const next = new Set(prev);
        next.add(postId);
        return next;
      });
      try {
        const res = await onAddComment(postId, text, parentId, images.length > 0 ? images : undefined);
        if (res !== false) {
          triggerHaptic('success');
          setCommentInputs((prev) => ({ ...prev, [postId]: '' }));
          setCommentImagesMap((prev) => ({ ...prev, [postId]: [] }));
          setReplyTargets((prev) => ({ ...prev, [postId]: null }));
          handleDismissCommentImageError(postId);
        }
      } finally {
        setCommentSubmittingIds((prev) => {
          const next = new Set(prev);
          next.delete(postId);
          return next;
        });
      }
    },
    [
      commentImagesMap,
      commentInputs,
      commentSubmittingIds,
      handleDismissCommentImageError,
      onAddComment,
      replyTargets,
    ]
  );

  const handleShare = useCallback(
    async (post: Post) => {
      triggerHaptic('tap');
      const shareUrl = `${window.location.origin}/?post=${encodeURIComponent(post.id)}`;
      try {
        if (navigator.share) {
          await navigator.share({
            title: `${post.authorName} on Schoolbackdoor`,
            text: post.content.slice(0, 120),
            url: shareUrl,
          });
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(shareUrl);
        }
        onSharePostTracked?.(post.id);
        setCopiedPostId(post.id);
        onNotify?.('Post link copied to clipboard');
        setTimeout(() => setCopiedPostId(null), 2000);
      } catch {
        // User cancelled native share sheet
      }
    },
    [onNotify, onSharePostTracked]
  );

  const handlePreviewLocation = useCallback((loc: CampusLocation, directions: boolean) => {
    triggerHaptic('tap');
    setPreviewLocation(loc);
    setOpenWithDirections(directions);
  }, []);

  const handleOpenLightbox = useCallback((images: string[], idx: number, title: string) => {
    triggerHaptic('tap');
    setLightboxState({
      isOpen: true,
      images,
      initialIndex: idx,
      title,
    });
  }, []);

  const signedIn = isAuthenticated ?? Boolean(profile.userId);

  const handleQuickConnect = async (target: UserSearchResult) => {
    if (!signedIn) {
      triggerHaptic('tap');
      onRequireAuth?.();
      return;
    }
    triggerHaptic('like');
    try {
      const res = await api.toggleConnectUser(target.userId);
      setFriendResults((prev) =>
        prev.map((u) =>
          u.userId === target.userId
            ? { ...u, isConnected: res.isConnected, followersCount: res.followersCount }
            : u
        )
      );
      onNotify?.(
        res.isConnected ? `Connected with ${target.handle}` : `Disconnected from ${target.handle}`
      );
    } catch (e: any) {
      triggerHaptic('error');
      onNotify?.(e?.message || 'Unable to connect right now.');
    }
  };

  const handleOpenReport = useCallback(
    (post: Post) => {
      triggerHaptic('tap');
      if (!signedIn) {
        onRequireAuth?.();
        return;
      }
      setReportTargetPost(post);
    },
    [onRequireAuth, signedIn]
  );

  const handleSubmitReport = useCallback(
    async (postId: string, reason: string, details?: string) => {
      if (onReportPost) {
        await onReportPost(postId, reason, details);
      } else {
        await api.createReport({
          target_type: 'post',
          target_id: postId,
          reason,
          details,
        });
      }
      setReportedPostIds((prev) => {
        const next = new Set(prev);
        next.add(postId);
        return next;
      });
    },
    [onReportPost]
  );

  return (
    <div className="w-full flex justify-center px-4 py-5 md:py-8">
      <div className="w-full max-w-6xl flex gap-7 items-start">
        {/* Main Feed Column */}
        <div className="w-full md:max-w-2xl flex-1 flex flex-col gap-5">
          {/* Editorial Header */}
          <div className="flex flex-col gap-2 pb-3 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10">
            <div className="text-[11px] uppercase tracking-widest text-[#82796F] dark:text-[#A89F95] flex items-center justify-between gap-2 flex-wrap">
              <span>Independent Student Network</span>
              {onlinePresence && (
                <span className="inline-flex items-center gap-1.5 text-[#171613] dark:text-[#F5EFE3] font-semibold normal-case tracking-normal tabular-nums">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      onlinePresence.onlineCount > 0 ? 'bg-[#D98BA5]' : 'bg-[#82796F] dark:bg-[#A89F95]'
                    }`}
                    aria-hidden="true"
                  />
                  <span>{onlinePresence.message}</span>
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <h1 className="font-serif text-2xl md:text-3xl font-bold tracking-tight text-[#171613] dark:text-[#F5EFE3]">
                The Campus Feed
              </h1>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  setMobileSearchOpen((v) => !v);
                }}
                className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[38px] rounded-xl glass-subtle text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Search className="w-3.5 h-3.5 text-[#C4718E]" />
                <span>Find Friends</span>
              </button>
            </div>
            <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
              Share everyday stories, memes, discussions, photos, and school life.
            </p>
          </div>

          {/* Mobile Expandable People Search */}
          {mobileSearchOpen && (
            <GlassCard tone="cream" padding="md" className="lg:hidden space-y-3 animate-sb-in">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-[#82796F] dark:text-[#A89F95] shrink-0" />
                <input
                  type="text"
                  value={friendQuery}
                  onChange={(e) => setFriendQuery(e.target.value)}
                  placeholder="Search friends by @username or name..."
                  className="flex-1 bg-transparent text-xs text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] focus:outline-none"
                />
                {friendQuery && (
                  <button
                    type="button"
                    onClick={() => setFriendQuery('')}
                    className="text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer p-1"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10">
                {isSearchingFriends ? (
                  <div className="py-2 text-xs text-[#82796F] dark:text-[#A89F95]">Searching...</div>
                ) : friendResults.length === 0 ? (
                  <div className="py-2 text-xs text-[#82796F] dark:text-[#A89F95]">No matching users found.</div>
                ) : (
                  friendResults.map((u) => (
                    <div key={u.userId} className="py-2 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onViewUserProfile?.(u.userId)}
                        className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer"
                      >
                        <UserAvatar
                          name={u.name}
                          initials={u.avatarInitials}
                          avatarUrl={u.avatarUrl}
                          avatarThumbUrl={u.avatarThumbUrl}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] truncate">
                            {u.name}
                          </div>
                          <div className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] truncate">
                            {u.handle}
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleQuickConnect(u)}
                        className={`px-3 py-1.5 min-h-[34px] rounded-lg text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                          u.isConnected
                            ? 'glass-subtle text-[#171613] dark:text-[#F5EFE3]'
                            : 'glass-pink text-[#171613]'
                        }`}
                      >
                        {u.isConnected ? 'Connected' : 'Connect'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </GlassCard>
          )}

          {/* Soft-Square Frosted "What's on your mind?" Composer Bar */}
          <div
            onClick={() => {
              triggerHaptic('tap');
              onOpenCompose();
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                triggerHaptic('tap');
                onOpenCompose();
              }
            }}
            className="glass-cream rounded-2xl px-3.5 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-[#FFFCF7]/95 dark:hover:bg-[#23211C] transition-all group"
          >
            <UserAvatar
              name={profile.name}
              initials={profile.avatarInitials || 'SB'}
              bg={profile.avatarBg}
              avatarUrl={profile.avatarUrl}
              avatarThumbUrl={profile.avatarThumbUrl}
              size="md"
              className="w-9 h-9"
            />
            <div className="flex-1 text-xs md:text-sm text-[#82796F] dark:text-[#A89F95] group-hover:text-[#171613] dark:group-hover:text-[#F5EFE3] transition-colors truncate">
              What&apos;s on your mind? Share a story, meme, photo, or discussion...
            </div>
            <span className="glass-pink text-[#171613] w-9 h-9 rounded-xl flex items-center justify-center shrink-0">
              <Feather className="w-4 h-4" />
            </span>
          </div>

          {/* Feed Categories + Location Filter Controls */}
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="overflow-x-auto pb-0.5 scrollbar-none">
                <GlassTab
                  activeId={activeCategory}
                  onChange={(val) => handleSelectCategory(val as FeedCategory)}
                  items={[
                    { id: 'for_you', label: 'For You', icon: <Sparkles className="w-3.5 h-3.5" /> },
                    { id: 'nearby', label: 'Nearby', icon: <Compass className="w-3.5 h-3.5" /> },
                    { id: 'latest', label: 'Latest', icon: <Clock className="w-3.5 h-3.5" /> },
                    { id: 'trending', label: 'Trending', icon: <Flame className="w-3.5 h-3.5" /> },
                  ]}
                />
              </div>

              <div className="relative self-start sm:self-auto shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setIsLocationMenuOpen((v) => !v);
                  }}
                  aria-expanded={isLocationMenuOpen}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] rounded-xl text-xs font-semibold transition-all cursor-pointer whitespace-nowrap border ${
                    activeLocation !== 'all'
                      ? 'bg-[#F6E2E6]/90 dark:bg-[#D98BA5]/25 border-[#D98BA5]/60 text-[#171613] dark:text-[#F5EFE3]'
                      : 'glass-subtle border-[#171613]/10 dark:border-[#F5EFE3]/12 text-[#171613] dark:text-[#F5EFE3] hover:bg-[#FFFCF7]/90 dark:hover:bg-[#23211C]'
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
                  <span>{getLocationFilterLabel(activeLocation, profile.preferredLocationArea)}</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isLocationMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                {isLocationMenuOpen && (
                  <GlassCard
                    tone="cream"
                    padding="md"
                    className="sm:absolute sm:right-0 sm:w-80 w-full mt-2 z-30 shadow-xl border border-[#171613]/12 dark:border-[#F5EFE3]/15 flex flex-col gap-3 animate-sb-in"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-2">
                      <span className="text-xs font-serif font-bold text-[#171613] dark:text-[#F5EFE3]">
                        Filter Feed by Area
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsLocationMenuOpen(false)}
                        aria-label="Close location menu"
                        className="p-1 rounded-lg text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5 text-xs">
                      <button
                        type="button"
                        onClick={() => handleSelectLocationFilter('all')}
                        className={`px-2.5 py-2 rounded-xl text-left font-semibold cursor-pointer transition-colors ${
                          activeLocation === 'all'
                            ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613]'
                            : 'glass-subtle text-[#171613] dark:text-[#F5EFE3]'
                        }`}
                      >
                        All Locations
                      </button>
                      {profile.locationSharingEnabled && profile.preferredLocationArea && (
                        <button
                          type="button"
                          onClick={() => handleSelectLocationFilter('my_area')}
                          className={`px-2.5 py-2 rounded-xl text-left font-semibold cursor-pointer transition-colors ${
                            activeLocation === 'my_area'
                              ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613]'
                              : 'glass-pink text-[#171613]'
                          }`}
                        >
                          My Area
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleSelectLocationFilter('on_campus')}
                        className={`px-2.5 py-2 rounded-xl text-left font-semibold cursor-pointer transition-colors ${
                          activeLocation === 'on_campus'
                            ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613]'
                            : 'glass-subtle text-[#171613] dark:text-[#F5EFE3]'
                        }`}
                      >
                        On Campus
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSelectLocationFilter('off_campus')}
                        className={`px-2.5 py-2 rounded-xl text-left font-semibold cursor-pointer transition-colors ${
                          activeLocation === 'off_campus'
                            ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613]'
                            : 'glass-subtle text-[#171613] dark:text-[#F5EFE3]'
                        }`}
                      >
                        Off Campus
                      </button>
                    </div>

                    <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-0.5">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-[#82796F] dark:text-[#A89F95] px-1">
                        Campus &amp; Communities
                      </span>
                      {CAMPUS_AREA_OPTIONS.map((area) => {
                        const selected = activeLocation === area.key;
                        return (
                          <button
                            key={area.key}
                            type="button"
                            onClick={() => handleSelectLocationFilter(area.key)}
                            className={`px-2.5 py-2 rounded-xl text-left flex items-center justify-between gap-2 text-xs cursor-pointer transition-colors ${
                              selected
                                ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#171613] dark:text-[#F5EFE3] font-semibold'
                                : 'hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] text-[#171613] dark:text-[#F5EFE3]'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="truncate">{area.label}</div>
                              <div className="text-[10px] text-[#82796F] dark:text-[#A89F95] truncate">
                                {area.description}
                              </div>
                            </div>
                            {selected && <Check className="w-3.5 h-3.5 text-[#C4718E] shrink-0" />}
                          </button>
                        );
                      })}
                    </div>

                    {savedLocations.length > 0 && (
                      <div className="pt-2 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10 flex flex-col gap-1">
                        <div className="flex items-center justify-between px-1">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-[#C4718E] dark:text-[#E5A4BA]">
                            Your Saved &amp; Pinned Spots
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setIsLocationMenuOpen(false);
                              onNavigateToUpdates('saved');
                            }}
                            className="text-[10px] font-semibold text-[#171613] dark:text-[#F5EFE3] hover:text-[#C4718E] cursor-pointer"
                          >
                            Manage →
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                          {savedLocations.slice(0, 6).map((spot) => {
                            const targetArea: LocationFilterKey =
                              (spot.areaKey as LocationFilterKey) ||
                              (spot.isOffCampus ? 'off_campus' : 'on_campus');
                            return (
                              <button
                                key={spot.id}
                                type="button"
                                onClick={() => handleSelectLocationFilter(targetArea)}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-[11px] font-medium cursor-pointer transition-colors ${
                                  activeLocation === targetArea
                                    ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613]'
                                    : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]'
                                }`}
                              >
                                {spot.isPinned ? (
                                  <Pin className="w-3 h-3 fill-current text-[#D98BA5]" />
                                ) : (
                                  <Bookmark className="w-3 h-3 text-[#C4718E]" />
                                )}
                                <span className="max-w-[130px] truncate">{spot.displayName}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {onUpdateLocationConsent && (
                      <div className="pt-2.5 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10 flex flex-col gap-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                            Remember My Area (Optional)
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={Boolean(profile.locationSharingEnabled)}
                            disabled={isUpdatingLocationConsent}
                            onClick={async () => {
                              if (!signedIn) {
                                onRequireAuth?.();
                                return;
                              }
                              setIsUpdatingLocationConsent(true);
                              try {
                                const nextEnabled = !profile.locationSharingEnabled;
                                const targetArea =
                                  nextEnabled
                                    ? profile.preferredLocationArea ||
                                      (activeLocation !== 'all' &&
                                      activeLocation !== 'my_area' &&
                                      activeLocation !== 'on_campus' &&
                                      activeLocation !== 'off_campus'
                                        ? activeLocation
                                        : 'obanla')
                                    : null;
                                await onUpdateLocationConsent(nextEnabled, targetArea);
                              } finally {
                                setIsUpdatingLocationConsent(false);
                              }
                            }}
                            className={`w-10 h-6 flex items-center rounded-lg p-0.5 cursor-pointer transition-colors shrink-0 ${
                              profile.locationSharingEnabled
                                ? 'bg-[#D98BA5]'
                                : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                            }`}
                          >
                            <div
                              className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                                profile.locationSharingEnabled ? 'translate-x-4' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={handleDetectNearestArea}
                          disabled={isDetectingArea}
                          className="w-full py-1.5 px-2.5 rounded-xl glass-subtle text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] flex items-center justify-center gap-1.5 cursor-pointer hover:bg-[#FFFCF7]/90 dark:hover:bg-[#23211C]"
                        >
                          <Navigation className="w-3.5 h-3.5 text-[#C4718E]" />
                          <span>{isDetectingArea ? 'Detecting coarse area...' : 'Detect Nearest Area'}</span>
                        </button>

                        <p className="text-[10px] text-[#82796F] dark:text-[#A89F95] leading-snug">
                          Privacy guaranteed: only your chosen coarse campus area is used — never exact GPS coordinates.
                        </p>
                      </div>
                    )}
                  </GlassCard>
                )}
              </div>
            </div>

            {activeCategory === 'nearby' && activeLocation === 'all' && !profile.locationSharingEnabled && (
              <GlassCard
                tone="cream"
                padding="sm"
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs animate-sb-in"
              >
                <div className="flex items-center gap-2 text-[#171613] dark:text-[#F5EFE3]">
                  <Compass className="w-4 h-4 text-[#C4718E] shrink-0" />
                  <span>
                    Pick a campus area or turn on optional area sharing to boost nearby posts.
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSelectLocationFilter('obanla')}
                    className="px-2.5 py-1 rounded-lg glass-subtle text-[11px] font-semibold cursor-pointer"
                  >
                    Obanla
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectLocationFilter('south_gate')}
                    className="px-2.5 py-1 rounded-lg glass-subtle text-[11px] font-semibold cursor-pointer"
                  >
                    South Gate
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectLocationFilter('stateline')}
                    className="px-2.5 py-1 rounded-lg glass-subtle text-[11px] font-semibold cursor-pointer"
                  >
                    Stateline
                  </button>
                </div>
              </GlassCard>
            )}
          </div>

          {/* Channel Filter Tabs */}
          <div className="overflow-x-auto pb-0.5 scrollbar-none">
            <GlassTab
              variant="pink"
              activeId={activeFilter}
              onChange={(val) => handleSelectFilter(val as FeedFilter)}
              items={[
                { id: 'all', label: 'All Posts' },
                { id: 'general', label: 'General & Vibes' },
                { id: 'entertainment', label: 'Memes & Fun' },
                { id: 'discussions', label: 'Discussions' },
                { id: 'soc', label: 'SOC' },
                { id: 'seet', label: 'SEET' },
                { id: 'hostel', label: 'Hostels' },
              ]}
            />
          </div>

          {/* Feed Stream */}
          <div className="flex flex-col gap-4">
            {isLoading && filteredPosts.length === 0 ? (
              <FeedSkeleton count={3} />
            ) : filteredPosts.length === 0 && !feedError ? (
              <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95] flex flex-col items-center gap-2">
                <span>No posts matched this feed view yet. Start the conversation!</span>
                {activeLocation !== 'all' && (
                  <GlassButton
                    variant="glass"
                    size="sm"
                    onClick={() => handleSelectLocationFilter('all')}
                  >
                    Show All Locations
                  </GlassButton>
                )}
              </GlassCard>
            ) : (
              filteredPosts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  currentUserId={profile.userId}
                  currentUserRole={profile.role}
                  isCommentsOpen={expandedCommentsPostId === post.id}
                  commentInput={commentInputs[post.id] || ''}
                  commentImages={commentImagesMap[post.id] || []}
                  commentImageUpload={commentImageUploads[post.id] || null}
                  commentImageError={commentImageErrors[post.id] || null}
                  isCommentSubmitting={commentSubmittingIds.has(post.id)}
                  replyTarget={replyTargets[post.id] || null}
                  isCopied={copiedPostId === post.id}
                  isReported={reportedPostIds.has(post.id)}
                  onToggleLike={onToggleLike}
                  onToggleRepost={onToggleRepost}
                  onToggleSave={onToggleSave}
                  onVotePoll={onVotePoll}
                  onToggleComments={handleToggleComments}
                  onCommentInputChange={handleCommentInputChange}
                  onAddCommentImages={handleAddCommentImages}
                  onRemoveCommentImage={handleRemoveCommentImage}
                  onDismissCommentImageError={handleDismissCommentImageError}
                  onSetReplyTarget={handleSetReplyTarget}
                  onCommentSubmit={handleCommentSubmit}
                  onEditPost={onEditPost}
                  onDeletePost={onDeletePost}
                  onEditComment={onEditComment}
                  onDeleteComment={onDeleteComment}
                  onShare={handleShare}
                  onOpenReport={handleOpenReport}
                  onViewUserProfile={onViewUserProfile}
                  onPreviewLocation={handlePreviewLocation}
                  onOpenLightbox={handleOpenLightbox}
                  onPostVisible={handlePostVisible}
                />
              ))
            )}

            {/* Infinite Scroll Skeleton */}
            {isLoadingMore && <FeedSkeleton count={2} />}

            {/* Network Error + Explicit Retry Banner */}
            {feedError && (
              <GlassCard
                tone="cream"
                padding="md"
                className="flex items-center justify-between gap-3 border border-[#D98BA5]/50"
              >
                <div className="flex items-center gap-2 text-xs text-[#171613] dark:text-[#F5EFE3]">
                  <AlertCircle className="w-4 h-4 text-[#C4718E] shrink-0" />
                  <span>{feedError}</span>
                </div>
                {onRetryLoad && (
                  <GlassButton variant="pink" size="sm" onClick={onRetryLoad}>
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Retry</span>
                  </GlassButton>
                )}
              </GlassCard>
            )}

            {/* Infinite Scroll Observer Sentinel + Manual Fallback */}
            <div ref={sentinelRef} className="h-2 w-full" aria-hidden="true" />

            {hasMorePosts && onLoadMore && !isLoadingMore && !feedError && (
              <GlassButton variant="glass" onClick={onLoadMore} className="w-full">
                Load more posts
              </GlassButton>
            )}

            {!hasMorePosts && filteredPosts.length > 0 && !isLoading && (
              <div className="text-center text-[11px] text-[#82796F] dark:text-[#A89F95] py-2">
                You&apos;re caught up with the last 72 hours of posts.
              </div>
            )}
          </div>
        </div>

        {/* Desktop Side Rail */}
        <aside className="hidden lg:flex flex-col w-80 shrink-0 gap-5 sticky top-6">
          {/* Find Friends Card */}
          <GlassCard tone="cream" padding="md" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">Find Friends</h2>
              <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">@username</span>
            </div>
            <div className="flex items-center gap-2 glass-input rounded-xl px-3 py-2">
              <Search className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95] shrink-0" />
              <input
                type="text"
                value={friendQuery}
                onChange={(e) => setFriendQuery(e.target.value)}
                placeholder="Search by @username or name..."
                className="w-full bg-transparent text-xs text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] focus:outline-none"
              />
            </div>
            <div className="flex flex-col divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10">
              {isSearchingFriends ? (
                <div className="py-2 text-xs text-[#82796F] dark:text-[#A89F95]">Searching...</div>
              ) : friendResults.length === 0 ? (
                <div className="py-2 text-xs text-[#82796F] dark:text-[#A89F95]">
                  No users matched that search.
                </div>
              ) : (
                friendResults.slice(0, 5).map((u) => (
                  <div key={u.userId} className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onViewUserProfile?.(u.userId)}
                      className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer group"
                    >
                      <UserAvatar
                        name={u.name}
                        initials={u.avatarInitials}
                        avatarUrl={u.avatarUrl}
                        avatarThumbUrl={u.avatarThumbUrl}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] truncate group-hover:text-[#C4718E] dark:group-hover:text-[#E5A4BA] transition-colors">
                          {u.name}
                        </div>
                        <div className="text-[10px] font-mono text-[#82796F] dark:text-[#A89F95] truncate">
                          {u.handle}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQuickConnect(u)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[32px] rounded-lg text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                        u.isConnected
                          ? 'glass-subtle text-[#171613] dark:text-[#F5EFE3]'
                          : 'glass-pink text-[#171613]'
                      }`}
                    >
                      {u.isConnected ? (
                        <>
                          <UserCheck className="w-3 h-3 text-[#C4718E]" />
                          <span>Connected</span>
                        </>
                      ) : (
                        <>
                          <UserPlus className="w-3 h-3" />
                          <span>Connect</span>
                        </>
                      )}
                    </button>
                  </div>
                ))
              )}
            </div>
          </GlassCard>

          <GlassCard tone="subtle" padding="md" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                Community Digest
              </h2>
              <button
                type="button"
                onClick={() => onNavigateToUpdates?.()}
                className="text-xs text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] font-semibold cursor-pointer"
              >
                View all →
              </button>
            </div>
            <p className="text-xs text-[#82796F] dark:text-[#A89F95]">
              Student community highlights, events, and updates.
            </p>

            <div className="flex flex-col divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10">
              {notices.slice(0, 3).map((notice) => (
                <div key={notice.id} className="py-2.5 first:pt-0 last:pb-0 flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95]">
                    <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] truncate max-w-[170px]">
                      {notice.source}
                    </span>
                    <span className="font-mono tabular-nums">{notice.date}</span>
                  </div>
                  <h4 className="text-xs font-medium text-[#171613] dark:text-[#F5EFE3] line-clamp-2 leading-snug">
                    {notice.title}
                  </h4>
                </div>
              ))}
            </div>
          </GlassCard>

          <div className="px-2 text-[11px] text-[#82796F] dark:text-[#A89F95] leading-relaxed">
            <p>
              Schoolbackdoor is an independent social network built for students to connect, share, and belong.
            </p>
          </div>
        </aside>
      </div>

      <Suspense fallback={null}>
        {previewLocation && (
          <LocationViewModal
            location={previewLocation}
            initialShowDirections={openWithDirections}
            onClose={() => {
              setPreviewLocation(null);
              setOpenWithDirections(false);
            }}
          />
        )}

        {lightboxState.isOpen && (
          <ImageViewerModal
            isOpen={lightboxState.isOpen}
            images={lightboxState.images}
            initialIndex={lightboxState.initialIndex}
            title={lightboxState.title}
            onClose={() => setLightboxState((prev) => ({ ...prev, isOpen: false }))}
          />
        )}

        {reportTargetPost && (
          <ReportPostModal
            post={reportTargetPost}
            isOpen={Boolean(reportTargetPost)}
            onClose={() => setReportTargetPost(null)}
            onSubmit={handleSubmitReport}
          />
        )}
      </Suspense>
    </div>
  );
};

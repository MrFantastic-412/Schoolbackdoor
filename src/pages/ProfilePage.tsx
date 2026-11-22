import React, { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import {
  Award,
  Bookmark,
  Camera,
  Check,
  Heart,
  Image as ImageIcon,
  Lock,
  MessageCircle,
  Repeat2,
  Settings,
  Share2,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../api/client';
import { CampusLocation, Community, Notice, Post, StudentProfile } from '../types';
import { LocationBadge } from '../components/map/LocationBadge';
import { PostImageGrid } from '../components/common/PostImageGrid';
import { PostPollCard } from '../components/common/PostPollCard';
import { GlassButton, GlassCard, GlassTab } from '../components/glass';
import { MentionText } from '../components/common/MentionText';
import { UserAvatar } from '../components/common/UserAvatar';
import { triggerHaptic } from '../utils/haptics';
import profileCoverImg from '../assets/images/profile_cover_campus_1794596918998.jpg';

const LocationViewModal = lazy(() =>
  import('../components/map/LocationViewModal').then((m) => ({ default: m.LocationViewModal }))
);
const ImageViewerModal = lazy(() =>
  import('../components/common/ImageViewerModal').then((m) => ({ default: m.ImageViewerModal }))
);
const ProfileEditModal = lazy(() =>
  import('../components/profile/ProfileEditModal').then((m) => ({ default: m.ProfileEditModal }))
);
const AvatarCropModal = lazy(() =>
  import('../components/profile/AvatarCropModal').then((m) => ({ default: m.AvatarCropModal }))
);

interface ProfilePageProps {
  profile: StudentProfile;
  posts: Post[];
  notices: Notice[];
  communities: Community[];
  onToggleLike: (postId: string) => void;
  onToggleRepost?: (postId: string) => void;
  onToggleSave?: (postId: string) => void;
  onVotePoll?: (postId: string, optionId: string) => void;
  onViewUserProfile?: (userId: string) => void;
  onNavigateToSettings: () => void;
  onProfileUpdated?: (updated: StudentProfile) => void;
  onNotify?: (message: string) => void;
}

export const ProfilePage: React.FC<ProfilePageProps> = ({
  profile,
  posts,
  communities,
  onToggleLike,
  onToggleRepost,
  onToggleSave,
  onVotePoll,
  onViewUserProfile,
  onNavigateToSettings,
  onProfileUpdated,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<'dispatches' | 'media' | 'saved' | 'guilds'>('dispatches');
  const [copiedPostId, setCopiedPostId] = useState<string | null>(null);
  const [previewLocation, setPreviewLocation] = useState<CampusLocation | null>(null);
  const [openWithDirections, setOpenWithDirections] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);
  const [lightboxState, setLightboxState] = useState<{
    images: string[];
    index: number;
    title?: string;
  } | null>(null);

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
        setCopiedPostId(post.id);
        onNotify?.('Post link copied to clipboard');
        setTimeout(() => setCopiedPostId(null), 2000);
      } catch {
        // User cancelled share dialog
      }
    },
    [onNotify]
  );

  const myPosts = useMemo(
    () =>
      posts.filter((p) => p.authorHandle === profile.handle || p.authorName === profile.name),
    [posts, profile.handle, profile.name]
  );
  const myMediaPosts = useMemo(
    () => myPosts.filter((p) => p.images && p.images.length > 0),
    [myPosts]
  );
  const savedPosts = useMemo(() => posts.filter((p) => p.isSaved), [posts]);
  const joinedCommunities = useMemo(() => communities.filter((c) => c.isJoined), [communities]);

  return (
    <div className="w-full flex justify-center px-4 py-6 md:py-8">
      <div className="w-full max-w-3xl flex flex-col gap-6">
        {/* Student Dossier Hero Card with Generated Campus Banner */}
        <GlassCard tone="cream" padding="none" className="overflow-hidden">
          <div className="relative h-36 sm:h-44 w-full bg-[#171613]">
            <img
              src={profileCoverImg}
              alt="Campus library walkway"
              decoding="async"
              className="w-full h-full object-cover"
            />
            <div
              className="absolute inset-0 bg-gradient-to-t from-[#171613]/75 via-[#171613]/20 to-transparent"
              aria-hidden="true"
            />
            <div className="absolute top-3.5 left-4 right-4 flex items-center justify-between gap-2">
              <span className="px-2.5 py-1 rounded-lg glass-dark text-[10px] font-mono uppercase tracking-wider text-[#F5EFE3]">
                Independent Member Profile
              </span>
              {profile.isPrivate && (
                <span className="px-2.5 py-1 rounded-lg glass-dark text-[10px] font-mono text-[#F6E2E6] flex items-center gap-1">
                  <Lock className="w-3 h-3 text-[#D98BA5]" />
                  <span>Private</span>
                </span>
              )}
            </div>
          </div>

          <div className="px-5 pb-6 md:px-7">
            {/* Centered Overlapping Circular Avatar */}
            <div className="flex flex-col items-center text-center -mt-12 relative z-10">
              <div className="relative">
                {profile.avatarUrl ? (
                  <UserAvatar
                    name={profile.name}
                    initials={profile.avatarInitials}
                    bg={profile.avatarBg}
                    avatarUrl={profile.avatarUrl}
                    avatarThumbUrl={profile.avatarThumbUrl}
                    size="2xl"
                    className="border-4 border-[#FFFCF7] dark:border-[#181714] shadow-[0_12px_28px_-8px_rgba(23,22,19,0.35)]"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-full bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613] flex flex-col items-center justify-center font-serif font-bold text-2xl shrink-0 border-4 border-[#FFFCF7] dark:border-[#181714] shadow-[0_12px_28px_-8px_rgba(23,22,19,0.35)]">
                    <span>{profile.avatarInitials || 'SB'}</span>
                    <span className="text-[9px] font-mono font-normal tracking-wider text-[#D98BA5] dark:text-[#C4718E]">
                      {profile.matricNumber ? profile.matricNumber.split('/')[0] : 'MEMBER'}
                    </span>
                  </div>
                )}
                {profile.userId && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setIsAvatarModalOpen(true);
                    }}
                    aria-label={profile.avatarUrl ? 'Change or remove profile picture' : 'Upload profile picture'}
                    className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-[#D98BA5] text-[#171613] border-2 border-[#FFFCF7] dark:border-[#181714] flex items-center justify-center shadow-md hover:scale-105 transition-transform cursor-pointer"
                  >
                    <Camera className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-center gap-1.5 flex-wrap">
                  <h1 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3]">
                    {profile.name}
                  </h1>
                  {profile.verified !== false && (
                    <ShieldCheck className="w-4 h-4 text-[#C4718E] shrink-0" />
                  )}
                </div>
                <div className="text-xs text-[#82796F] dark:text-[#A89F95] font-mono mt-0.5">
                  {profile.handle}{profile.matricNumber ? ` · ${profile.matricNumber}` : ''}
                </div>
              </div>

              {profile.bio && (
                <p className="text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed mt-3 max-w-lg">
                  {profile.bio}
                </p>
              )}

              {/* Stats Row */}
              <div className="w-full max-w-lg grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-2 my-4 py-3 border-y border-[#171613]/8 dark:border-[#F5EFE3]/10 text-center tabular-nums">
                <div>
                  <div className="font-serif text-lg font-bold text-[#171613] dark:text-[#F5EFE3]">
                    {profile.dispatchesCount ?? myPosts.length}
                  </div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95]">Posts</div>
                </div>
                <div className="sm:border-l border-[#171613]/8 dark:border-[#F5EFE3]/10">
                  <div className="font-serif text-lg font-bold text-[#171613] dark:text-[#F5EFE3]">
                    {profile.followersCount ?? 0}
                  </div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95]">Followers</div>
                </div>
                <div className="sm:border-x border-[#171613]/8 dark:border-[#F5EFE3]/10">
                  <div className="font-serif text-lg font-bold text-[#171613] dark:text-[#F5EFE3]">
                    {profile.followingCount ?? 0}
                  </div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95]">Following</div>
                </div>
                <div>
                  <div className="font-serif text-lg font-bold text-[#171613] dark:text-[#F5EFE3]">
                    {profile.guildsCount ?? joinedCommunities.length}
                  </div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95]">Communities</div>
                </div>
              </div>

              {/* Edit Profile Soft-Square Action + Settings Button */}
              <div className="flex items-center justify-center gap-2.5 w-full max-w-sm">
                <GlassButton
                  variant="pink"
                  size="md"
                  onClick={() => setIsEditModalOpen(true)}
                  className="flex-1"
                >
                  Edit Profile
                </GlassButton>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    onNavigateToSettings();
                  }}
                  aria-label="Open settings and preferences"
                  className="w-[42px] h-[42px] rounded-xl glass-cream text-[#171613] dark:text-[#F5EFE3] hover:bg-[#FFFCF7] dark:hover:bg-[#23211C] flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                >
                  <Settings className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-4 mt-5 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10">
              <div>
                <span className="text-[#82796F] dark:text-[#A89F95] block text-[10px] uppercase">Department</span>
                <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                  {profile.department} · {profile.level}
                </span>
              </div>
              <div>
                <span className="text-[#82796F] dark:text-[#A89F95] block text-[10px] uppercase">School</span>
                <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{profile.school}</span>
              </div>
              <div>
                <span className="text-[#82796F] dark:text-[#A89F95] block text-[10px] uppercase">Residence</span>
                <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{profile.hallOfResidence}</span>
              </div>
              <div>
                <span className="text-[#82796F] dark:text-[#A89F95] block text-[10px] uppercase">Campus</span>
                <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{profile.campus}</span>
              </div>
            </div>

            {profile.badges.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-4">
                {profile.badges.map((badge) => (
                  <span
                    key={badge}
                    className="text-[10px] font-semibold text-[#171613] dark:text-[#F5EFE3] bg-[#F6E2E6]/85 dark:bg-[#D98BA5]/20 border border-[#D98BA5]/40 px-2.5 py-0.5 rounded-md inline-flex items-center gap-1"
                  >
                    <Award className="w-3 h-3 text-[#C4718E]" />
                    <span>{badge}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </GlassCard>

        {/* Tab Selector */}
        <div className="overflow-x-auto scrollbar-none">
          <GlassTab
            variant="pink"
            activeId={activeTab}
            onChange={(val) => setActiveTab(val as any)}
            items={[
              { id: 'dispatches', label: 'Posts', count: myPosts.length },
              { id: 'media', label: 'Media', count: myMediaPosts.length, icon: <ImageIcon className="w-3.5 h-3.5" /> },
              { id: 'saved', label: 'Saved', count: savedPosts.length },
              { id: 'guilds', label: 'Communities', count: joinedCommunities.length },
            ]}
          />
        </div>

        {/* Tab Content */}
        <div className="flex flex-col gap-4">
          {activeTab === 'dispatches' && (
            <>
              {myPosts.length > 0 ? (
                myPosts.map((post) => (
                  <GlassCard key={post.id} tone="subtle" padding="md">
                    <div className="flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] font-mono mb-2">
                      <span>
                        {post.timestamp}
                        {post.isEdited ? ' · (edited)' : ''}
                      </span>
                      {post.schoolTag && (
                        <span className="bg-[#F6E2E6] dark:bg-[#D98BA5]/20 text-[#171613] dark:text-[#F5EFE3] px-2.5 py-0.5 rounded-md font-sans font-semibold text-[10px]">
                          {post.schoolTag}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[#171613] dark:text-[#F5EFE3] leading-relaxed whitespace-pre-wrap break-words">
                      <MentionText text={post.content} mentions={post.mentions} onMentionClick={onViewUserProfile} />
                    </p>
                    {post.poll && (
                      <PostPollCard postId={post.id} poll={post.poll} onVote={onVotePoll} />
                    )}
                    {post.images && post.images.length > 0 && (
                      <div className="mt-3">
                        <PostImageGrid
                          images={post.images}
                          onImageClick={(idx) => {
                            triggerHaptic('tap');
                            setLightboxState({
                              images: post.images!,
                              index: idx,
                              title: `Dispatch by ${post.authorName}`,
                            });
                          }}
                        />
                      </div>
                    )}
                    {post.location && (
                      <div className="mt-2.5">
                        <LocationBadge
                          location={post.location}
                          onClick={() => {
                            triggerHaptic('tap');
                            setPreviewLocation(post.location || null);
                            setOpenWithDirections(false);
                          }}
                          onDirectionsClick={() => {
                            triggerHaptic('tap');
                            setPreviewLocation(post.location || null);
                            setOpenWithDirections(true);
                          }}
                          showCoordinates
                        />
                      </div>
                    )}
                    <div className="mt-3 pt-2.5 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] tabular-nums">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onToggleLike(post.id)}
                          aria-label="Like post"
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl min-h-[38px] cursor-pointer transition-colors ${
                            post.isLiked
                              ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#171613] dark:text-[#F5EFE3] font-semibold'
                              : 'hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                          }`}
                        >
                          <Heart className={`w-3.5 h-3.5 ${post.isLiked ? 'fill-[#D98BA5] stroke-[#D98BA5]' : ''}`} />
                          <span className="font-mono">{post.likes}</span>
                        </button>
                        <span className="flex items-center gap-1.5 px-2 py-1 min-h-[38px]">
                          <MessageCircle className="w-3.5 h-3.5" />
                          <span className="font-mono">{post.comments.length || post.commentsCount}</span>
                        </span>
                        {onToggleRepost && (
                          <button
                            type="button"
                            onClick={() => onToggleRepost(post.id)}
                            aria-label="Repost"
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl min-h-[38px] cursor-pointer transition-colors ${
                              post.isReposted
                                ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#C4718E] dark:text-[#E5A4BA] font-semibold'
                                : 'hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                            }`}
                          >
                            <Repeat2 className="w-3.5 h-3.5" />
                            <span className="font-mono">{post.reposts}</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {onToggleSave && (
                          <button
                            type="button"
                            onClick={() => onToggleSave(post.id)}
                            aria-label="Bookmark post"
                            className={`w-9 h-9 rounded-xl flex items-center justify-center cursor-pointer transition-colors ${
                              post.isSaved
                                ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613]'
                                : 'hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                            }`}
                          >
                            <Bookmark className={`w-3.5 h-3.5 ${post.isSaved ? 'fill-current' : ''}`} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleShare(post)}
                          aria-label="Share post"
                          className="w-9 h-9 rounded-xl flex items-center justify-center hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer transition-colors"
                        >
                          {copiedPostId === post.id ? (
                            <Check className="w-3.5 h-3.5 text-[#C4718E]" />
                          ) : (
                            <Share2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </GlassCard>
                ))
              ) : (
                <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                  You have not published any posts yet.
                </GlassCard>
              )}
            </>
          )}

          {activeTab === 'media' && (
            <>
              {myMediaPosts.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {myMediaPosts.map((post) => (
                    <GlassCard key={post.id} tone="subtle" padding="sm">
                      <PostImageGrid
                        images={post.images!}
                        onImageClick={(idx) =>
                          setLightboxState({
                            images: post.images!,
                            index: idx,
                            title: `Photo by ${post.authorName}`,
                          })
                        }
                      />
                      <p className="text-xs text-[#171613] dark:text-[#F5EFE3] mt-2 line-clamp-2">
                        <MentionText text={post.content} mentions={post.mentions} onMentionClick={onViewUserProfile} />
                      </p>
                    </GlassCard>
                  ))}
                </div>
              ) : (
                <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                  No photo posts uploaded yet.
                </GlassCard>
              )}
            </>
          )}

          {activeTab === 'saved' && (
            <>
              {savedPosts.length > 0 ? (
                savedPosts.map((post) => (
                  <GlassCard key={post.id} tone="subtle" padding="md">
                    <div className="flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] mb-1">
                      <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                        {post.authorName} · {post.department}
                      </span>
                      <span className="font-mono text-[11px]">
                        {post.timestamp}
                        {post.isEdited ? ' · (edited)' : ''}
                      </span>
                    </div>
                    <p className="text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] leading-relaxed mt-1 whitespace-pre-wrap break-words">
                      <MentionText text={post.content} mentions={post.mentions} onMentionClick={onViewUserProfile} />
                    </p>
                    {post.poll && (
                      <PostPollCard postId={post.id} poll={post.poll} onVote={onVotePoll} />
                    )}
                    <div className="mt-3 pt-2 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center justify-between text-xs text-[#82796F] dark:text-[#A89F95] tabular-nums">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onToggleLike(post.id)}
                          aria-label="Like post"
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl min-h-[38px] cursor-pointer transition-colors ${
                            post.isLiked
                              ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#171613] dark:text-[#F5EFE3] font-semibold'
                              : 'hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                          }`}
                        >
                          <Heart className={`w-3.5 h-3.5 ${post.isLiked ? 'fill-[#D98BA5] stroke-[#D98BA5]' : ''}`} />
                          <span className="font-mono">{post.likes}</span>
                        </button>
                        {onToggleRepost && (
                          <button
                            type="button"
                            onClick={() => onToggleRepost(post.id)}
                            aria-label="Repost"
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl min-h-[38px] cursor-pointer transition-colors ${
                              post.isReposted
                                ? 'bg-[#F6E2E6] dark:bg-[#D98BA5]/25 text-[#C4718E] dark:text-[#E5A4BA] font-semibold'
                                : 'hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                            }`}
                          >
                            <Repeat2 className="w-3.5 h-3.5" />
                            <span className="font-mono">{post.reposts}</span>
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {onToggleSave && (
                          <button
                            type="button"
                            onClick={() => onToggleSave(post.id)}
                            aria-label="Remove bookmark"
                            className="w-9 h-9 rounded-xl bg-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:text-[#171613] flex items-center justify-center cursor-pointer transition-colors"
                          >
                            <Bookmark className="w-3.5 h-3.5 fill-current" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleShare(post)}
                          aria-label="Share post"
                          className="w-9 h-9 rounded-xl flex items-center justify-center hover:bg-[#E8DDCC]/50 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer transition-colors"
                        >
                          {copiedPostId === post.id ? (
                            <Check className="w-3.5 h-3.5 text-[#C4718E]" />
                          ) : (
                            <Share2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </GlassCard>
                ))
              ) : (
                <GlassCard tone="subtle" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                  No saved posts yet. Tap the bookmark icon on any post to save it here.
                </GlassCard>
              )}
            </>
          )}

          {activeTab === 'guilds' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {joinedCommunities.map((c) => (
                <GlassCard key={c.id} tone="subtle" padding="md" className="flex flex-col justify-between">
                  <div>
                    <span className="font-mono text-xs font-bold bg-[#F6E2E6] dark:bg-[#D98BA5]/20 text-[#171613] dark:text-[#F5EFE3] px-2.5 py-0.5 rounded-md">
                      {c.acronym}
                    </span>
                    <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] mt-2">{c.name}</h3>
                    <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-1 line-clamp-2">{c.description}</p>
                  </div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-3 pt-2 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 font-mono">
                    {c.location}
                  </div>
                </GlassCard>
              ))}
            </div>
          )}
        </div>
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

        {lightboxState && (
          <ImageViewerModal
            isOpen={!!lightboxState}
            images={lightboxState.images}
            initialIndex={lightboxState.index}
            title={lightboxState.title}
            onClose={() => setLightboxState(null)}
          />
        )}

        {isEditModalOpen && (
          <ProfileEditModal
            isOpen={isEditModalOpen}
            onClose={() => setIsEditModalOpen(false)}
            profile={profile}
            onProfileUpdated={(updated) => onProfileUpdated?.(updated)}
          />
        )}

        {isAvatarModalOpen && (
          <AvatarCropModal
            isOpen={isAvatarModalOpen}
            currentAvatarUrl={profile.avatarUrl}
            currentAvatarThumbUrl={profile.avatarThumbUrl}
            userName={profile.name}
            initials={profile.avatarInitials}
            avatarBg={profile.avatarBg}
            onClose={() => setIsAvatarModalOpen(false)}
            onSave={async (cropped, onProgress) => {
              onProgress(55);
              const updated = await api.updateProfile({
                avatarDataUrl: cropped.dataUrl,
                avatarThumbnailDataUrl: cropped.thumbnailDataUrl,
              });
              onProgress(100);
              if (updated) {
                triggerHaptic('success');
                onProfileUpdated?.(updated);
                onNotify?.('Profile picture updated');
              }
            }}
            onRemove={
              profile.avatarUrl
                ? async () => {
                    const updated = await api.updateProfile({ removeAvatar: true });
                    if (updated) {
                      triggerHaptic('success');
                      onProfileUpdated?.(updated);
                      onNotify?.('Profile picture removed');
                    }
                  }
                : undefined
            }
          />
        )}
      </Suspense>
    </div>
  );
};

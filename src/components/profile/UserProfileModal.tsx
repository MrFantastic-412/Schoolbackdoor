import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  Flag,
  Lock,
  MapPin,
  MessageSquare,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import { api } from '../../api/client';
import { Post, StudentProfile } from '../../types';
import { GlassButton, GlassCard, GlassModal } from '../glass';
import { PostImageGrid } from '../common/PostImageGrid';
import { ImageViewerModal } from '../common/ImageViewerModal';
import { MentionText } from '../common/MentionText';
import { UserAvatar } from '../common/UserAvatar';
import { triggerHaptic } from '../../utils/haptics';

interface UserProfileModalProps {
  userId: string | null;
  currentUserId?: string;
  currentUserRole?: string;
  onClose: () => void;
  onMessageUser: (targetUserId: string) => void;
  onViewUserProfile?: (targetUserId: string) => void;
  onRequireAuth: () => void;
  onNotify?: (message: string) => void;
}

const REPORT_REASONS = [
  'Harassment or bullying',
  'Impersonation or fake account',
  'Spam or scam links',
  'Inappropriate or abusive content',
  'Privacy violation / sharing personal info',
];

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  userId,
  currentUserId,
  currentUserRole,
  onClose,
  onMessageUser,
  onViewUserProfile,
  onRequireAuth,
  onNotify,
}) => {
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBusyAction, setIsBusyAction] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState(REPORT_REASONS[0]);
  const [reportDetails, setReportDetails] = useState('');
  const [hasReported, setHasReported] = useState(false);
  const [lightboxState, setLightboxState] = useState<{
    images: string[];
    index: number;
    title?: string;
  } | null>(null);

  const loadUser = useCallback(async (uid: string) => {
    setIsLoading(true);
    setIsReportOpen(false);
    setHasReported(false);
    try {
      const [p, userPosts] = await Promise.all([
        api.getPublicProfile(uid),
        api.getUserPosts(uid, 15),
      ]);
      setProfile(p);
      setPosts(userPosts || []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userId) {
      loadUser(userId);
    } else {
      setProfile(null);
      setPosts([]);
    }
  }, [userId, loadUser]);

  if (!userId) return null;

  const isOwnProfile = Boolean(currentUserId && userId === currentUserId);
  const isPrivateLocked = Boolean(
    profile?.isPrivate && !isOwnProfile && currentUserRole !== 'admin' && !profile?.isConnected
  );

  const handleToggleConnect = async () => {
    if (!currentUserId) {
      onRequireAuth();
      return;
    }
    if (!profile) return;
    triggerHaptic('like');
    setIsBusyAction(true);
    try {
      const res = await api.toggleConnectUser(userId);
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              isConnected: res.isConnected,
              followersCount: res.followersCount,
            }
          : prev
      );
      onNotify?.(
        res.isConnected
          ? `Connected with ${profile.name}`
          : `Disconnected from ${profile.name}`
      );
      const updatedPosts = await api.getUserPosts(userId, 15);
      setPosts(updatedPosts || []);
    } catch (e: any) {
      triggerHaptic('error');
      onNotify?.(e?.message || 'Unable to update connection.');
    } finally {
      setIsBusyAction(false);
    }
  };

  const handleBlockToggle = async () => {
    if (!currentUserId) {
      onRequireAuth();
      return;
    }
    if (!profile) return;
    triggerHaptic('tap');
    setIsBusyAction(true);
    try {
      if (profile.isBlocked) {
        await api.unblockUser(userId);
        triggerHaptic('success');
        onNotify?.(`Unblocked ${profile.handle}`);
      } else {
        await api.blockUser(userId);
        triggerHaptic('success');
        onNotify?.(`Blocked ${profile.handle}`);
      }
      await loadUser(userId);
    } catch (e: any) {
      triggerHaptic('error');
      onNotify?.(e?.message || 'Unable to update block setting.');
    } finally {
      setIsBusyAction(false);
    }
  };

  const handleReportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUserId) {
      onRequireAuth();
      return;
    }
    setIsBusyAction(true);
    try {
      await api.createReport({
        target_type: 'user',
        target_id: userId,
        reason: reportReason,
        details: reportDetails.trim() || undefined,
      });
      triggerHaptic('success');
      setHasReported(true);
      setIsReportOpen(false);
      setReportDetails('');
      onNotify?.('User report sent to Admin moderation.');
    } catch (err: any) {
      triggerHaptic('error');
      onNotify?.(err?.message || 'Unable to submit report.');
    } finally {
      setIsBusyAction(false);
    }
  };

  return (
    <GlassModal
      isOpen={Boolean(userId)}
      onClose={onClose}
      maxWidthClass="max-w-xl"
      title={profile ? profile.name : 'Student Profile'}
      subtitle={profile ? `${profile.handle} · Independent Student Profile` : 'Loading profile...'}
    >
      <div className="p-4 sm:p-6 space-y-4">
        {isLoading || !profile ? (
          <div className="py-12 text-center text-xs text-[#82796F] dark:text-[#A89F95]">
            {isLoading ? 'Loading profile details...' : 'Profile could not be found.'}
          </div>
        ) : (
          <>
            <GlassCard tone="cream" padding="md" className="space-y-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <UserAvatar
                    name={profile.name}
                    initials={profile.avatarInitials || 'SB'}
                    bg={profile.avatarBg}
                    avatarUrl={profile.avatarUrl}
                    avatarThumbUrl={profile.avatarThumbUrl}
                    size="xl"
                    className="w-14 h-14 text-lg ring-2 ring-[#FFFCF7] dark:ring-[#23211C]"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h3 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3] truncate">
                        {profile.name}
                      </h3>
                      {profile.verified && (
                        <ShieldCheck className="w-4 h-4 text-[#D98BA5] shrink-0" />
                      )}
                      {profile.isPrivate && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[#E8DDCC]/80 dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3]">
                          <Lock className="w-2.5 h-2.5" />
                          Private
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[#82796F] dark:text-[#A89F95] font-mono">
                      {profile.handle}
                    </div>
                    <div className="text-xs text-[#171613]/80 dark:text-[#F5EFE3]/80 mt-0.5">
                      {profile.department || 'Student Community'}
                      {profile.level ? ` · ${profile.level}` : ''}
                    </div>
                  </div>
                </div>

                {!isOwnProfile && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {!profile.isBlockedEitherWay && (
                      <>
                        <GlassButton
                          variant={profile.isConnected ? 'glass' : 'pink'}
                          size="sm"
                          disabled={isBusyAction}
                          onClick={handleToggleConnect}
                        >
                          {profile.isConnected ? (
                            <>
                              <UserCheck className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                              <span>Connected</span>
                            </>
                          ) : (
                            <>
                              <UserPlus className="w-3.5 h-3.5" />
                              <span>Connect</span>
                            </>
                          )}
                        </GlassButton>

                        <GlassButton
                          variant="black"
                          size="sm"
                          disabled={isBusyAction}
                          onClick={() => {
                            if (!currentUserId) {
                              onRequireAuth();
                              return;
                            }
                            onClose();
                            onMessageUser(userId);
                          }}
                        >
                          <MessageSquare className="w-3.5 h-3.5 text-[#D98BA5]" />
                          <span>Message</span>
                        </GlassButton>
                      </>
                    )}
                  </div>
                )}
              </div>

              {profile.bio && (
                <p className="text-xs sm:text-sm text-[#171613] dark:text-[#F5EFE3]/90 leading-relaxed">
                  {profile.bio}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[#82796F] dark:text-[#A89F95]">
                {profile.hallOfResidence && profile.hallOfResidence !== 'Private' && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <span>{profile.hallOfResidence}</span>
                  </span>
                )}
                {profile.joinedDate && <span>Joined {profile.joinedDate}</span>}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3 border-t border-[#171613]/10 dark:border-white/10 text-center">
                <div className="p-2 rounded-xl bg-[#FFFCF7]/70 dark:bg-white/5">
                  <div className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    {profile.postsCount ?? posts.length}
                  </div>
                  <div className="text-[10px] text-[#82796F] dark:text-[#A89F95]">Posts</div>
                </div>
                <div className="p-2 rounded-xl bg-[#FFFCF7]/70 dark:bg-white/5">
                  <div className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    {profile.followersCount ?? 0}
                  </div>
                  <div className="text-[10px] text-[#82796F] dark:text-[#A89F95]">Followers</div>
                </div>
                <div className="p-2 rounded-xl bg-[#FFFCF7]/70 dark:bg-white/5">
                  <div className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    {profile.followingCount ?? 0}
                  </div>
                  <div className="text-[10px] text-[#82796F] dark:text-[#A89F95]">Following</div>
                </div>
                <div className="p-2 rounded-xl bg-[#FFFCF7]/70 dark:bg-white/5">
                  <div className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    {profile.guildsCount ?? 0}
                  </div>
                  <div className="text-[10px] text-[#82796F] dark:text-[#A89F95]">Communities</div>
                </div>
              </div>

              {!isOwnProfile && (
                <div className="flex items-center justify-between pt-2 border-t border-[#171613]/8 dark:border-white/10 text-xs">
                  <button
                    type="button"
                    disabled={isBusyAction}
                    onClick={handleBlockToggle}
                    className="inline-flex items-center gap-1.5 text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer min-h-[36px]"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    <span>{profile.isBlocked ? 'Unblock user' : 'Block user'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={hasReported}
                    onClick={() => {
                      triggerHaptic('tap');
                      setIsReportOpen((v) => !v);
                    }}
                    className="inline-flex items-center gap-1.5 text-[#82796F] dark:text-[#A89F95] hover:text-[#C4718E] dark:hover:text-[#E5A4BA] cursor-pointer disabled:opacity-60 min-h-[36px]"
                  >
                    {hasReported ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                        <span className="text-[#C4718E] dark:text-[#E5A4BA]">Reported</span>
                      </>
                    ) : (
                      <>
                        <Flag className="w-3.5 h-3.5" />
                        <span>Report user</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </GlassCard>

            {isReportOpen && (
              <form
                onSubmit={handleReportSubmit}
                className="p-4 rounded-2xl glass-subtle space-y-3 border border-[#D98BA5]/40"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                  <AlertTriangle className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                  <span>Report {profile.handle} to Platform Admin</span>
                </div>
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  className="w-full glass-input rounded-xl px-3 py-2 text-xs text-[#171613] dark:text-[#F5EFE3]"
                >
                  {REPORT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <textarea
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  rows={2}
                  placeholder="Optional context for moderation review..."
                  className="w-full glass-input rounded-xl p-2.5 text-xs text-[#171613] dark:text-[#F5EFE3] resize-none"
                />
                <div className="flex justify-end gap-2">
                  <GlassButton type="button" variant="ghost" size="sm" onClick={() => setIsReportOpen(false)}>
                    Cancel
                  </GlassButton>
                  <GlassButton type="submit" variant="pink" size="sm" disabled={isBusyAction}>
                    Submit Report
                  </GlassButton>
                </div>
              </form>
            )}

            {profile.isBlockedEitherWay ? (
              <GlassCard tone="subtle" padding="md" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                Interactions between you and this account are restricted due to an active block.
              </GlassCard>
            ) : isPrivateLocked ? (
              <GlassCard tone="subtle" padding="md" className="text-center space-y-2">
                <Lock className="w-5 h-5 text-[#82796F] dark:text-[#A89F95] mx-auto" />
                <div className="font-serif font-bold text-sm text-[#171613] dark:text-[#F5EFE3]">
                  This account is private
                </div>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95]">
                  Connect with {profile.handle} to view their recent 72-hour posts and updates.
                </p>
              </GlassCard>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <span>Recent Public Posts (72h Window)</span>
                  </span>
                  <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">{posts.length}</span>
                </div>

                {posts.length === 0 ? (
                  <GlassCard tone="subtle" padding="md" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                    No active public posts in the last 72 hours.
                  </GlassCard>
                ) : (
                  <div className="space-y-2.5">
                    {posts.map((post) => (
                      <GlassCard key={post.id} tone="subtle" padding="sm" className="space-y-2">
                        <div className="flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95]">
                          <span className="font-mono">
                            {post.timestamp}
                            {post.isEdited ? ' · (edited)' : ''}
                          </span>
                          {post.schoolTag && (
                            <span className="px-2 py-0.5 rounded-md bg-[#F6E2E6] dark:bg-[#4A2532]/75 text-[#171613] dark:text-[#F5EFE3] font-semibold text-[10px]">
                              {post.schoolTag}
                            </span>
                          )}
                        </div>
                        <p className="text-xs sm:text-sm text-[#171613] dark:text-[#F5EFE3]/90 leading-relaxed break-words whitespace-pre-wrap">
                          <MentionText
                            text={post.content}
                            mentions={post.mentions}
                            onMentionClick={onViewUserProfile}
                          />
                        </p>
                        {post.images && post.images.length > 0 && (
                          <PostImageGrid
                            images={post.images}
                            onImageClick={(idx) => {
                              triggerHaptic('tap');
                              setLightboxState({
                                images: post.images!,
                                index: idx,
                                title: `Photo by ${profile.name}`,
                              });
                            }}
                          />
                        )}
                      </GlassCard>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {lightboxState && (
        <ImageViewerModal
          isOpen={Boolean(lightboxState)}
          images={lightboxState.images}
          initialIndex={lightboxState.index}
          title={lightboxState.title}
          onClose={() => setLightboxState(null)}
        />
      )}
    </GlassModal>
  );
};

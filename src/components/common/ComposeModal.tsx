import React, { useRef, useState } from 'react';
import { BarChart3, Bookmark, Camera, Loader2, MapPin, Pin, Plus, X } from 'lucide-react';
import { api } from '../../api/client';
import { CampusLocation, PlatformConfig, Post, StudentProfile } from '../../types';
import {
  compressImageFile,
  IMAGE_UPLOAD_ACCEPT,
  IMAGE_UPLOAD_GUIDANCE,
  MAX_ATTACHMENTS_POST,
  validateImageFile,
} from '../../utils/imageCompression';
import { useSavedLocations } from '../../utils/useSavedLocations';
import { LocationPickerModal } from '../map/LocationPickerModal';
import { GlassButton, GlassModal } from '../glass';
import { MentionInput } from './MentionInput';
import { UserAvatar } from './UserAvatar';
import { triggerHaptic } from '../../utils/haptics';

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddPost: (newPost: Omit<Post, 'id' | 'timestamp' | 'likes' | 'commentsCount' | 'reposts' | 'comments'>) => Promise<boolean> | void;
  profile: StudentProfile;
  onProfileUpdated?: (updated: StudentProfile) => void;
  initialLocation?: CampusLocation | null;
  communityId?: string;
  communityName?: string;
  isAnnouncementMode?: boolean;
  platformConfig?: PlatformConfig | null;
}

export const ComposeModal: React.FC<ComposeModalProps> = ({
  isOpen,
  onClose,
  onAddPost,
  profile,
  onProfileUpdated,
  initialLocation = null,
  communityId,
  communityName,
  isAnnouncementMode = false,
  platformConfig,
}) => {
  const postsFeature = platformConfig?.features?.find((f) => f.key === 'posts');
  const anonAllowed = platformConfig?.features?.find((f) => f.key === 'anonymous_posting')?.enabled !== false;
  const landmarksAllowed = platformConfig?.features?.find((f) => f.key === 'campus_landmarks')?.enabled !== false;
  const maxPostChars = Math.min(2000, Math.max(100, Number(postsFeature?.limits?.maxPostLength || 400)));
  const maxImagesLimit = Math.min(MAX_ATTACHMENTS_POST, Math.max(1, Number(postsFeature?.limits?.maxImagesPerPost || MAX_ATTACHMENTS_POST)));
  const [content, setContent] = useState('');
  const [tag, setTag] = useState<string>('General');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [attachedLocation, setAttachedLocation] = useState<CampusLocation | null>(initialLocation);
  const [announcementUrgency, setAnnouncementUrgency] = useState<'normal' | 'high'>('normal');
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [isCompressingImages, setIsCompressingImages] = useState(false);
  const [compressProgress, setCompressProgress] = useState<number>(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPollOpen, setIsPollOpen] = useState(false);
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollAllowMultiple, setPollAllowMultiple] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [isAcceptingTerms, setIsAcceptingTerms] = useState(false);

  const needsTermsAcceptance = Boolean(profile?.userId && !profile?.acceptedTermsVersion);
  const { savedLocations, pinLocation } = useSavedLocations();

  const fileInputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (initialLocation) {
      setAttachedLocation(initialLocation);
    }
    if (isOpen) {
      setSubmitError(null);
    }
  }, [initialLocation, isOpen]);

  if (!isOpen) return null;

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setImageError(null);

    const availableSlots = maxImagesLimit - attachedImages.length;
    if (availableSlots <= 0) {
      setImageError(`You have already attached the maximum of ${maxImagesLimit} photos.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const filesToProcess = Array.from(files).slice(0, availableSlots);

    for (const file of filesToProcess) {
      try {
        validateImageFile(file);
      } catch (err: any) {
        triggerHaptic('error');
        setImageError(err?.message || 'Selected image exceeds the 20MB upload limit.');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
    }

    setIsCompressingImages(true);
    setCompressProgress(0);
    const newCompressedList: string[] = [];

    for (let i = 0; i < filesToProcess.length; i++) {
      const file = filesToProcess[i];
      try {
        const compressed = await compressImageFile(file, (p) => {
          const overall = Math.round(((i + p / 100) / filesToProcess.length) * 100);
          setCompressProgress(overall);
        });
        newCompressedList.push(compressed.dataUrl);
      } catch (err: any) {
        setImageError(err.message || 'Error preparing image for dispatch.');
        break;
      }
    }

    setAttachedImages((prev) => [...prev, ...newCompressedList]);
    setIsCompressingImages(false);
    setCompressProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveImage = (indexToRemove: number) => {
    setAttachedImages((prev) => prev.filter((_, idx) => idx !== indexToRemove));
  };

  const handleTogglePoll = () => {
    triggerHaptic('tap');
    setPollError(null);
    setIsPollOpen((prev) => {
      const next = !prev;
      if (next && pollOptions.length < 2) {
        setPollOptions(['', '']);
      }
      return next;
    });
  };

  const handlePollOptionChange = (idx: number, value: string) => {
    setPollError(null);
    setPollOptions((prev) => prev.map((opt, i) => (i === idx ? value : opt)));
  };

  const handleAddPollOption = () => {
    setPollError(null);
    setPollOptions((prev) => (prev.length >= 6 ? prev : [...prev, '']));
  };

  const handleRemovePollOption = (idx: number) => {
    setPollError(null);
    setPollOptions((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx)));
  };

  const getValidPollOptions = () => {
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const raw of pollOptions) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      valid.push(trimmed);
    }
    return valid;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isCompressingImages) return;

    setSubmitError(null);
    const validPollOptions = isPollOpen ? getValidPollOptions() : [];
    if (isPollOpen) {
      if (!content.trim()) {
        setPollError('Please enter your poll question in the post text box above.');
        return;
      }
      if (validPollOptions.length < 2) {
        setPollError('Please provide at least 2 distinct poll options.');
        return;
      }
    }

    if (!content.trim() && attachedImages.length === 0) return;

    const basePostData = {
      content: content.trim(),
      schoolTag: communityName || (tag === 'General' ? undefined : tag),
      communityId: communityId || undefined,
      isAnnouncement: isAnnouncementMode,
      announcementUrgency: isAnnouncementMode ? announcementUrgency : 'normal',
      isPinned: isAnnouncementMode,
      location: attachedLocation || undefined,
      images: attachedImages.length > 0 ? attachedImages : undefined,
      poll:
        isPollOpen && validPollOptions.length >= 2
          ? {
              options: validPollOptions.map((label, idx) => ({
                id: `opt-${idx + 1}`,
                label,
                votes: 0,
              })),
              allowMultiple: pollAllowMultiple,
              totalVotes: 0,
              userVotedOptionIds: [],
            }
          : undefined,
      isAnonymous: isAnnouncementMode ? false : isAnonymous,
    };

    const payload =
      isAnonymous && !isAnnouncementMode
        ? {
            ...basePostData,
            authorName: 'Anonymous Member',
            authorHandle: '@anonymous',
            department: 'Anonymous',
            level: 'Hidden',
            avatarBg: 'bg-stone-700 text-stone-100',
            avatarInitials: 'AN',
            verified: false,
            operatorNote: 'Identity masked from peers. Traceable by authorized platform admins.',
          }
        : {
            ...basePostData,
            authorName: profile.name,
            authorHandle: profile.handle,
            department: profile.department,
            level: profile.level,
            avatarBg: profile.avatarBg || 'bg-[#171613] text-[#F5EFE3]',
            avatarInitials: profile.avatarInitials || 'SB',
            verified: profile.verified !== false,
          };

    setIsSubmitting(true);
    try {
      const result = await onAddPost(payload);
      if (result === false) {
        setSubmitError('Unable to publish your post right now. Your draft has been kept safe.');
        return;
      }
      if (attachedLocation) {
        void pinLocation(attachedLocation, 'post', { silent: true });
      }
      setContent('');
      setAttachedLocation(null);
      setAttachedImages([]);
      setImageError(null);
      setIsPollOpen(false);
      setPollOptions(['', '']);
      setPollAllowMultiple(false);
      setPollError(null);
      setSubmitError(null);
      onClose();
    } catch (err: any) {
      setSubmitError(err?.message || 'Unable to publish your post. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const tagOptions = [
    'General',
    'Memes & Fun',
    'Discussions',
    'Campus Life',
    'Photos',
    'SOC',
    'SEET',
    'Hostels',
  ];

  return (
    <>
      <GlassModal
        isOpen={isOpen}
        onClose={onClose}
        title={isAnnouncementMode ? 'Publish Community Announcement' : communityName ? `Post to ${communityName}` : 'Create a Post'}
        subtitle={
          isAnnouncementMode
            ? 'Community announcements are pinned to the group board and notify members.'
            : 'Share everyday updates, memes, opinions, photos, or school life'
        }
      >
        <form onSubmit={handleSubmit} className="p-4 sm:p-5 flex flex-col gap-3.5">
          {/* Identity Bar */}
          <div className="flex items-center justify-between pb-1 gap-2 flex-wrap">
            <div className="flex items-center gap-2.5">
              <UserAvatar
                name={isAnonymous && !isAnnouncementMode ? 'Anonymous Member' : profile.name}
                initials={profile.avatarInitials}
                bg={profile.avatarBg}
                avatarUrl={profile.avatarUrl}
                avatarThumbUrl={profile.avatarThumbUrl}
                isAnonymous={isAnonymous && !isAnnouncementMode}
                size="md"
              />
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                  {isAnonymous ? 'Anonymous Member' : profile.name}
                </span>
                <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                  {isAnonymous ? 'Identity masked from peers' : `${profile.handle} · ${profile.department}`}
                </span>
              </div>
            </div>

            {isAnnouncementMode ? (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-medium">Urgency:</span>
                <button
                  type="button"
                  onClick={() => setAnnouncementUrgency('normal')}
                  className={`px-2.5 py-1.5 min-h-[34px] rounded-xl text-[11px] font-medium cursor-pointer transition-colors ${
                    announcementUrgency === 'normal'
                      ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613]'
                      : 'glass-subtle text-[#82796F] dark:text-[#A89F95]'
                  }`}
                >
                  Standard
                </button>
                <button
                  type="button"
                  onClick={() => setAnnouncementUrgency('high')}
                  className={`px-2.5 py-1.5 min-h-[34px] rounded-xl text-[11px] font-semibold cursor-pointer transition-colors ${
                    announcementUrgency === 'high'
                      ? 'bg-[#D98BA5] text-[#171613]'
                      : 'bg-[#F6E2E6] text-[#171613] dark:bg-[#D98BA5]/20 dark:text-[#F5EFE3]'
                  }`}
                >
                  Urgent
                </button>
              </div>
            ) : anonAllowed ? (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  setIsAnonymous(!isAnonymous);
                }}
                className={`text-xs px-3 py-1.5 min-h-[36px] rounded-xl border transition-colors cursor-pointer ${
                  isAnonymous
                    ? 'bg-[#171613] text-[#F5EFE3] border-[#171613] dark:bg-[#F5EFE3] dark:text-[#171613] dark:border-[#F5EFE3] font-medium'
                    : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/15'
                }`}
              >
                {isAnonymous ? '✓ Anonymous Active' : 'Post Anonymously'}
              </button>
            ) : null}
          </div>

          {/* Text Area with @mention autocomplete */}
          <div className="relative">
            <MentionInput
              as="textarea"
              value={content}
              onChange={(nextVal) => {
                setContent(nextVal);
                if (pollError) setPollError(null);
                if (submitError) setSubmitError(null);
              }}
              communityId={communityId}
              placement="below"
              placeholder={
                isPollOpen
                  ? 'Ask your poll question or add survey context...'
                  : "What's on your mind? Share a story, joke, discussion, photo, or tag @username..."
              }
              rows={3}
              maxLength={maxPostChars}
              className="w-full p-3.5 glass-input rounded-2xl text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] text-xs sm:text-sm resize-none leading-relaxed"
              autoFocus
            />
            <div className="flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95] mt-1">
              <span>Type @username to tag someone</span>
              <span className="font-mono tabular-nums">
                {content.length}/{maxPostChars}
              </span>
            </div>
          </div>

          {/* Compression Progress */}
          {isCompressingImages && (
            <div className="p-3 rounded-2xl glass-subtle space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-[#171613] dark:text-[#F5EFE3]">
                <span className="font-medium flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#C4718E]" />
                  Optimizing photo for campus network...
                </span>
                <span className="font-mono tabular-nums text-[#82796F] dark:text-[#A89F95]">{compressProgress}%</span>
              </div>
              <div className="h-1.5 w-full rounded-sm bg-[#E8DDCC] dark:bg-[#2A2722] overflow-hidden">
                <div
                  className="h-full bg-[#D98BA5] transition-all duration-150 ease-out"
                  style={{ width: `${Math.max(8, compressProgress)}%` }}
                />
              </div>
            </div>
          )}

          {/* Image Thumbnails Grid */}
          {attachedImages.length > 0 && (
            <div className="flex flex-col gap-2 p-3 glass-subtle rounded-2xl">
              <div className="flex items-center justify-between text-[11px] text-[#82796F] dark:text-[#A89F95]">
                <span className="font-medium text-[#171613] dark:text-[#F5EFE3]">
                  Attached Photos ({attachedImages.length}/{MAX_ATTACHMENTS_POST})
                </span>
                <span className="text-[10px] text-[#C4718E] dark:text-[#E5A4BA] font-mono font-semibold">
                  ✓ Compressed for campus network
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {attachedImages.map((imgUrl, idx) => (
                  <div
                    key={idx}
                    className="relative aspect-square rounded-xl overflow-hidden border border-[#171613]/15 dark:border-[#F5EFE3]/15 bg-[#E8DDCC] dark:bg-[#23211C] group"
                  >
                    <img
                      src={imgUrl}
                      alt={`Upload ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('close');
                        handleRemoveImage(idx);
                      }}
                      aria-label="Remove image"
                      className="absolute top-1.5 right-1.5 w-6 h-6 rounded-lg bg-[#171613]/85 hover:bg-[#D98BA5] text-[#F5EFE3] hover:text-[#171613] flex items-center justify-center transition-colors shadow-xs cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {imageError && (
            <div className="p-2.5 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-[#171613] dark:text-[#F5EFE3] text-xs flex items-center justify-between gap-2">
              <span className="leading-snug">{imageError}</span>
              <button
                type="button"
                onClick={() => setImageError(null)}
                className="text-[#171613] dark:text-[#F5EFE3] hover:text-[#C4718E] font-bold text-xs cursor-pointer px-1"
              >
                ✕
              </button>
            </div>
          )}

          {/* Multi-choice Poll Builder */}
          {isPollOpen && (
            <div className="flex flex-col gap-2.5 p-3.5 glass-subtle rounded-2xl border border-[#D98BA5]/45">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                  <BarChart3 className="w-3.5 h-3.5 text-[#C4718E]" />
                  <span>Multi-choice Poll</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsPollOpen(false);
                    setPollOptions(['', '']);
                    setPollAllowMultiple(false);
                    setPollError(null);
                  }}
                  className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                >
                  Remove Poll
                </button>
              </div>

              <div className="flex flex-col gap-2">
                {pollOptions.map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={opt}
                      onChange={(e) => handlePollOptionChange(idx, e.target.value)}
                      placeholder={`Choice ${idx + 1}${idx < 2 ? ' (required)' : ' (optional)'}`}
                      maxLength={80}
                      className="flex-1 min-h-[42px] glass-input rounded-xl px-3 py-2 text-xs text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95]"
                    />
                    {pollOptions.length > 2 && (
                      <button
                        type="button"
                        onClick={() => handleRemovePollOption(idx)}
                        aria-label={`Remove choice ${idx + 1}`}
                        className="w-10 h-10 rounded-xl glass-subtle text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] flex items-center justify-center shrink-0 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
                {pollOptions.length < 6 ? (
                  <button
                    type="button"
                    onClick={handleAddPollOption}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer py-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Choice ({pollOptions.length}/6)</span>
                  </button>
                ) : (
                  <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">Maximum 6 choices reached</span>
                )}

                <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={pollAllowMultiple}
                    onChange={(e) => setPollAllowMultiple(e.target.checked)}
                    className="w-3.5 h-3.5 accent-[#D98BA5] cursor-pointer"
                  />
                  <span>Allow multiple answers</span>
                </label>
              </div>

              {pollError && (
                <div className="text-[11px] text-[#171613] dark:text-[#F5EFE3] bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] rounded-xl px-2.5 py-1.5">
                  {pollError}
                </div>
              )}
            </div>
          )}

          {/* Focus Channel Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#82796F] dark:text-[#A89F95]">Select Focus Channel:</label>
            <div className="flex flex-wrap gap-1.5">
              {tagOptions.map((opt) => (
                <button
                  type="button"
                  key={opt}
                  onClick={() => {
                    triggerHaptic('tap');
                    setTag(opt);
                  }}
                  className={`text-xs px-3 py-1.5 min-h-[34px] rounded-xl transition-colors cursor-pointer ${
                    tag === opt
                      ? 'bg-[#D98BA5] text-[#171613] font-semibold'
                      : 'glass-subtle text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          {/* Location & Image Action Toolbar */}
          <div className="flex flex-col gap-2 pt-2 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={IMAGE_UPLOAD_ACCEPT}
                  multiple
                  onChange={handleImageFileChange}
                  className="hidden"
                />

                <button
                  type="button"
                  disabled={attachedImages.length >= maxImagesLimit || isCompressingImages}
                  onClick={() => {
                    triggerHaptic('tap');
                    fileInputRef.current?.click();
                  }}
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 min-h-[38px] rounded-xl border transition-colors cursor-pointer ${
                    attachedImages.length > 0
                      ? 'bg-[#171613] text-[#F5EFE3] border-[#171613] dark:bg-[#F5EFE3] dark:text-[#171613] dark:border-[#F5EFE3]'
                      : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/15'
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {isCompressingImages ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Camera className="w-3.5 h-3.5 text-[#C4718E]" />
                  )}
                  <span>
                    {isCompressingImages
                      ? 'Compressing...'
                      : attachedImages.length > 0
                      ? `Photos (${attachedImages.length}/${maxImagesLimit})`
                      : 'Attach Photos'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleTogglePoll}
                  aria-pressed={isPollOpen}
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 min-h-[38px] rounded-xl border transition-colors cursor-pointer ${
                    isPollOpen
                      ? 'bg-[#171613] text-[#F5EFE3] border-[#171613] dark:bg-[#F5EFE3] dark:text-[#171613] dark:border-[#F5EFE3]'
                      : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/15'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5 text-[#C4718E]" />
                  <span>{isPollOpen ? 'Poll Active' : 'Poll'}</span>
                </button>

                {landmarksAllowed && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setIsLocationPickerOpen(true);
                    }}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 min-h-[38px] rounded-xl border transition-colors cursor-pointer ${
                      attachedLocation
                        ? 'bg-[#171613] text-[#F5EFE3] border-[#171613] dark:bg-[#F5EFE3] dark:text-[#171613] dark:border-[#F5EFE3]'
                        : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/15'
                    }`}
                  >
                    <MapPin className="w-3.5 h-3.5 text-[#C4718E]" />
                    <span>{attachedLocation ? 'Change Spot' : 'Pin Campus Spot'}</span>
                  </button>
                )}
              </div>

              <span className="text-[10px] text-[#82796F] dark:text-[#A89F95] font-mono">
                Max {maxImagesLimit} photos · {IMAGE_UPLOAD_GUIDANCE}
              </span>
            </div>

            {landmarksAllowed && savedLocations.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[#82796F] dark:text-[#A89F95] shrink-0">
                  Saved:
                </span>
                {savedLocations.slice(0, 6).map((item) => {
                  const isAttached =
                    attachedLocation &&
                    Number(attachedLocation.coordinates[0]).toFixed(4) ===
                      Number(item.coordinates[0]).toFixed(4) &&
                    Number(attachedLocation.coordinates[1]).toFixed(4) ===
                      Number(item.coordinates[1]).toFixed(4);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        triggerHaptic('tap');
                        if (isAttached) {
                          setAttachedLocation(null);
                        } else {
                          setAttachedLocation({
                            id: item.landmarkId || item.id,
                            name: item.displayName,
                            category: item.category,
                            coordinates: item.coordinates,
                            description: item.notes || item.description || item.address,
                            address: item.address,
                            isOffCampus: item.isOffCampus,
                          });
                        }
                      }}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 min-h-[30px] rounded-xl text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer border transition-colors ${
                        isAttached
                          ? 'bg-[#171613] text-[#F5EFE3] border-[#171613] dark:bg-[#D98BA5] dark:text-[#171613] dark:border-[#D98BA5]'
                          : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/20'
                      }`}
                    >
                      {item.isPinned ? (
                        <Pin className="w-3 h-3 fill-current text-[#D98BA5]" />
                      ) : (
                        <Bookmark className="w-3 h-3 text-[#C4718E]" />
                      )}
                      <span className="max-w-[140px] truncate">{item.displayName}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {attachedLocation && (
              <div className="flex items-center justify-between p-2.5 glass-subtle rounded-xl text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-lg bg-[#D98BA5] text-[#171613] flex items-center justify-center shrink-0">
                    <MapPin className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] truncate">
                      {attachedLocation.name}
                    </span>
                    <span className="text-[10px] text-[#82796F] dark:text-[#A89F95] font-mono truncate">
                      {attachedLocation.coordinates[0].toFixed(4)}° N, {attachedLocation.coordinates[1].toFixed(4)}° E
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('close');
                    setAttachedLocation(null);
                  }}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                  title="Remove location"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {!isAnnouncementMode && anonAllowed && (
              <div className="flex flex-col gap-1.5 p-3 rounded-2xl glass-subtle">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isAnonymous}
                    onChange={(e) => {
                      triggerHaptic('tap');
                      setIsAnonymous(e.target.checked);
                    }}
                    className="w-4 h-4 accent-[#D98BA5] cursor-pointer"
                  />
                  <span className="text-xs font-medium text-[#171613] dark:text-[#F5EFE3]">
                    Post Anonymously (hide my name &amp; @username from peers)
                  </span>
                </label>

                {isAnonymous && (
                  <div className="text-[10px] text-[#171613]/85 dark:text-[#F5EFE3]/90 bg-[#F6E2E6]/70 dark:bg-[#D98BA5]/15 p-2.5 rounded-xl border border-[#D98BA5]/50 leading-relaxed">
                    <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block mb-0.5">Anonymous Posting Policy:</span>
                    Your identity is hidden from other users. To prevent harassment, threats, and abuse, anonymous posts remain auditable by authorized platform moderators.
                  </div>
                )}
              </div>
            )}
          </div>

          {needsTermsAcceptance && (
            <div className="p-3 rounded-xl bg-[#F6E2E6]/85 dark:bg-[#4A2532]/70 border border-[#C4718E]/60 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="text-[#171613] dark:text-[#F5EFE3] leading-relaxed">
                Please accept our{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                  Terms &amp; Community Guidelines
                </a>{' '}
                before publishing posts or replies.
              </div>
              <GlassButton
                type="button"
                variant="pink"
                size="sm"
                loading={isAcceptingTerms}
                onClick={async () => {
                  setIsAcceptingTerms(true);
                  setSubmitError(null);
                  try {
                    const res = await api.acceptTerms();
                    onProfileUpdated?.({ ...profile, acceptedTermsVersion: res.acceptedTermsVersion });
                    triggerHaptic('success');
                  } catch (err: any) {
                    setSubmitError(err?.message || 'Unable to record Terms acceptance right now.');
                  } finally {
                    setIsAcceptingTerms(false);
                  }
                }}
              >
                Accept &amp; Enable Posting
              </GlassButton>
            </div>
          )}

          {submitError && (
            <div className="p-2.5 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#C4718E] text-[#171613] dark:text-[#F5EFE3] text-xs font-medium">
              {submitError}
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10 shrink-0 gap-2 flex-wrap">
            <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">Expires automatically after 72 hours</span>
            <div className="flex items-center gap-2 ml-auto">
              <GlassButton variant="ghost" size="sm" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </GlassButton>
              <GlassButton
                type="submit"
                variant="pink"
                size="sm"
                loading={isSubmitting}
                disabled={
                  isSubmitting ||
                  needsTermsAcceptance ||
                  (!content.trim() && attachedImages.length === 0) ||
                  (isPollOpen && getValidPollOptions().length < 2) ||
                  isCompressingImages
                }
              >
                {isSubmitting ? 'Publishing...' : 'Publish Post'}
              </GlassButton>
            </div>
          </div>
        </form>
      </GlassModal>

      <LocationPickerModal
        isOpen={isLocationPickerOpen}
        onClose={() => setIsLocationPickerOpen(false)}
        currentLocation={attachedLocation}
        onSelectLocation={(loc) => setAttachedLocation(loc)}
      />
    </>
  );
};

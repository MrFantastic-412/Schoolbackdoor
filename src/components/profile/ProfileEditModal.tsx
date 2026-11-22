import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  EyeOff,
  Globe,
  Lock,
  Shield,
  ShieldAlert,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import { api } from '../../api/client';
import { BlockedUser, StudentProfile } from '../../types';
import { GlassButton, GlassInput, GlassModal, GlassTab } from '../glass';
import { UserAvatar } from '../common/UserAvatar';
import { AvatarCropModal } from './AvatarCropModal';
import { IMAGE_UPLOAD_GUIDANCE } from '../../utils/imageCompression';
import { triggerHaptic } from '../../utils/haptics';

interface ProfileEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: StudentProfile;
  onProfileUpdated: (updated: StudentProfile) => void;
}

export const ProfileEditModal: React.FC<ProfileEditModalProps> = ({
  isOpen,
  onClose,
  profile,
  onProfileUpdated,
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'privacy' | 'blocked'>('details');

  const [name, setName] = useState(profile.name || '');
  const [bio, setBio] = useState(profile.bio || '');
  const [department, setDepartment] = useState(profile.department || '');
  const [level, setLevel] = useState(profile.level || '');
  const [hallOfResidence, setHallOfResidence] = useState(profile.hallOfResidence || '');
  const [campus, setCampus] = useState(profile.campus || 'Obanla');
  const [avatarBg, setAvatarBg] = useState(profile.avatarBg || 'bg-[#171613] text-[#F5EFE3]');

  const [isPrivate, setIsPrivate] = useState<boolean>(profile.isPrivate || false);
  const [allowAnonymousPosts, setAllowAnonymousPosts] = useState<boolean>(
    profile.allowAnonymousPosts !== false
  );
  const [showOnlineStatus, setShowOnlineStatus] = useState<boolean>(
    profile.showOnlineStatus !== false
  );

  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(profile.name || '');
      setBio(profile.bio || '');
      setDepartment(profile.department || '');
      setLevel(profile.level || '');
      setHallOfResidence(profile.hallOfResidence || '');
      setCampus(profile.campus || 'Obanla');
      setAvatarBg(profile.avatarBg || 'bg-[#171613] text-[#F5EFE3]');
      setIsPrivate(profile.isPrivate || false);
      setAllowAnonymousPosts(profile.allowAnonymousPosts !== false);
      setShowOnlineStatus(profile.showOnlineStatus !== false);
      setFeedback(null);
    } else {
      setIsAvatarModalOpen(false);
    }
  }, [isOpen, profile]);

  useEffect(() => {
    if (activeTab === 'blocked' && isOpen) {
      api.getBlockedUsers().then((users) => setBlockedUsers(users));
    }
  }, [activeTab, isOpen]);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setFeedback(null);

    try {
      const updated = await api.updateProfile({
        name: name.trim(),
        bio: bio.trim(),
        department: department.trim(),
        level: level.trim(),
        hallOfResidence: hallOfResidence.trim(),
        campus: campus.trim(),
        avatarBg,
        isPrivate,
        allowAnonymousPosts,
        showOnlineStatus,
      });

      if (updated) {
        triggerHaptic('success');
        onProfileUpdated(updated);
        setFeedback({ type: 'success', message: 'Dossier preferences saved successfully.' });
        setTimeout(() => {
          onClose();
        }, 1200);
      }
    } catch (err: any) {
      triggerHaptic('error');
      setFeedback({ type: 'error', message: err.message || 'Failed to update profile.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnblock = async (blockedId: string) => {
    triggerHaptic('tap');
    try {
      await api.unblockUser(blockedId);
      triggerHaptic('success');
      setBlockedUsers((prev) => prev.filter((u) => u.userId !== blockedId));
      setFeedback({ type: 'success', message: 'Student unblocked successfully.' });
    } catch (err: any) {
      triggerHaptic('error');
      setFeedback({ type: 'error', message: err.message || 'Failed to unblock user.' });
    }
  };

  const avatarColorOptions = [
    { label: 'Obsidian Ink', class: 'bg-[#171613] text-[#F5EFE3]' },
    { label: 'Charcoal Glass', class: 'bg-[#2B2924] text-[#F5EFE3]' },
    { label: 'Burnt Pink', class: 'bg-[#D98BA5] text-[#171613]' },
    { label: 'Deep Rose', class: 'bg-[#C4718E] text-[#FFFCF7]' },
    { label: 'Warm Beige', class: 'bg-[#E8DDCC] text-[#171613]' },
  ];

  return (
    <>
      <GlassModal
        isOpen={isOpen}
        onClose={onClose}
        title="Edit Profile & Privacy Controls"
        subtitle="Manage your profile details, privacy visibility, and safety controls"
        maxWidthClass="max-w-xl"
      >
      <div className="p-4 sm:p-5 flex flex-col gap-4">
        <GlassTab
          items={[
            { id: 'details', label: 'Profile Details' },
            { id: 'privacy', label: 'Privacy & Anonymity', icon: <Shield className="w-3.5 h-3.5" /> },
            { id: 'blocked', label: 'Blocked', icon: <UserX className="w-3.5 h-3.5" /> },
          ]}
          activeId={activeTab}
          onChange={(id) => setActiveTab(id as any)}
          className="w-full"
        />

        {feedback && (
          <div
            className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
              feedback.type === 'success'
                ? 'bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] border border-transparent dark:border-white/15'
                : 'bg-[#F6E2E6] dark:bg-[#4A2532]/70 border border-[#C4718E] text-[#171613] dark:text-[#F5EFE3]'
            }`}
          >
            {feedback.type === 'success' ? (
              <Check className="w-4 h-4 text-[#D98BA5] shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
            )}
            <span>{feedback.message}</span>
          </div>
        )}

        {activeTab === 'details' && (
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <div className="p-3.5 glass-subtle rounded-2xl flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <UserAvatar
                  name={profile.name}
                  initials={profile.avatarInitials}
                  bg={avatarBg}
                  avatarUrl={profile.avatarUrl}
                  avatarThumbUrl={profile.avatarThumbUrl}
                  size="xl"
                  className="ring-2 ring-[#FFFCF7] dark:ring-[#23211C]"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                    Profile Picture
                  </div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5">
                    {IMAGE_UPLOAD_GUIDANCE}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <GlassButton
                  type="button"
                  variant="pink"
                  size="sm"
                  onClick={() => {
                    triggerHaptic('tap');
                    setIsAvatarModalOpen(true);
                  }}
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{profile.avatarUrl ? 'Change Photo' : 'Upload Photo'}</span>
                </GlassButton>
                {profile.avatarUrl && (
                  <GlassButton
                    type="button"
                    variant="glass"
                    size="sm"
                    disabled={isSaving}
                    onClick={async () => {
                      setIsSaving(true);
                      setFeedback(null);
                      try {
                        const updated = await api.updateProfile({ removeAvatar: true });
                        if (updated) {
                          triggerHaptic('success');
                          onProfileUpdated(updated);
                          setFeedback({ type: 'success', message: 'Profile picture removed.' });
                        }
                      } catch (err: any) {
                        triggerHaptic('error');
                        setFeedback({ type: 'error', message: err?.message || 'Unable to remove profile picture.' });
                      } finally {
                        setIsSaving(false);
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Remove</span>
                  </GlassButton>
                )}
              </div>
            </div>

            <div className="p-3.5 glass-subtle rounded-2xl text-xs flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[#171613] dark:text-[#F5EFE3] font-semibold text-[11px] uppercase tracking-wider font-mono">
                <Lock className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                <span>Account Credentials</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[#82796F] dark:text-[#A89F95] text-xs pt-1.5 border-t border-[#171613]/10 dark:border-white/10">
                <div>
                  <span className="text-[#82796F] dark:text-[#A89F95] block text-[10px]">Verified Gmail</span>
                  <span className="font-mono font-semibold text-[#171613] dark:text-[#F5EFE3] truncate block">
                    {profile.email || 'Unlinked'}
                  </span>
                </div>
                <div>
                  <span className="text-[#82796F] dark:text-[#A89F95] block text-[10px]">Username Handle</span>
                  <span className="font-mono font-semibold text-[#171613] dark:text-[#F5EFE3]">
                    {profile.handle}
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-[#82796F] dark:text-[#A89F95] mt-0.5">
                Unique @usernames and registered Gmail addresses are locked for account security.
              </p>
            </div>

            <GlassInput
              label="Display Name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#82796F] dark:text-[#A89F95] mb-1.5">
                Biography & Interests
              </label>
              <textarea
                rows={3}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full px-3.5 py-2.5 glass-input rounded-xl text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <GlassInput
                label="Department"
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              />
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#82796F] dark:text-[#A89F95] mb-1.5">
                  Level
                </label>
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  className="w-full px-3.5 py-2.5 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3]"
                >
                  <option value="100L">100L</option>
                  <option value="200L">200L</option>
                  <option value="300L">300L</option>
                  <option value="400L">400L</option>
                  <option value="500L">500L</option>
                  <option value="Postgraduate">Postgraduate</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <GlassInput
                label="Hall / Area"
                type="text"
                value={hallOfResidence}
                onChange={(e) => setHallOfResidence(e.target.value)}
                placeholder="Titans Hostel (South Gate)"
              />
              <GlassInput
                label="Campus Zone"
                type="text"
                value={campus}
                onChange={(e) => setCampus(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#82796F] dark:text-[#A89F95] mb-1.5">
                Avatar Palette
              </label>
              <div className="flex gap-2">
                {avatarColorOptions.map((opt) => (
                  <button
                    key={opt.class}
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setAvatarBg(opt.class);
                    }}
                    className={`w-10 h-10 rounded-xl border border-[#171613]/15 dark:border-white/20 flex items-center justify-center cursor-pointer transition-transform ${
                      opt.class
                    } ${avatarBg === opt.class ? 'ring-2 ring-[#D98BA5] scale-105' : 'opacity-80 hover:opacity-100'}`}
                    title={opt.label}
                  >
                    {avatarBg === opt.class && <Check className="w-4 h-4" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-[#171613]/10 dark:border-white/10 flex justify-end">
              <GlassButton type="submit" variant="pink" disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save Dossier Details'}
              </GlassButton>
            </div>
          </form>
        )}

        {activeTab === 'privacy' && (
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <div className="p-4 rounded-2xl glass-subtle flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  {isPrivate ? (
                    <EyeOff className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                  ) : (
                    <Globe className="w-4 h-4 text-[#82796F] dark:text-[#A89F95]" />
                  )}
                  <span className="font-semibold text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3]">
                    Private Student Profile
                  </span>
                </div>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                  When enabled, student peers who are not your study connections can only see your public username and department. Your matriculation and detailed residence dossier are shielded.
                </p>
              </div>
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => {
                  triggerHaptic('tap');
                  setIsPrivate(e.target.checked);
                }}
                className="w-5 h-5 accent-[#D98BA5] cursor-pointer mt-1"
              />
            </div>

            <div className="p-4 rounded-2xl glass-subtle flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <UserCheck className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                  <span className="font-semibold text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3]">
                    Show Online Status in Messenger
                  </span>
                </div>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                  Display an active indicator dot to your coursemates and roommates when you are connected to the campus network.
                </p>
              </div>
              <input
                type="checkbox"
                checked={showOnlineStatus}
                onChange={(e) => {
                  triggerHaptic('tap');
                  setShowOnlineStatus(e.target.checked);
                }}
                className="w-5 h-5 accent-[#D98BA5] cursor-pointer mt-1"
              />
            </div>

            <div className="p-4 rounded-2xl glass-subtle flex flex-col gap-2.5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <span className="font-semibold text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] block mb-1">
                    Allow Anonymous Dispatch Compose Option
                  </span>
                  <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                    Enable the option to post anonymous questions and hostel tips to the Campus Commons without displaying your handle.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={allowAnonymousPosts}
                  onChange={(e) => {
                    triggerHaptic('tap');
                    setAllowAnonymousPosts(e.target.checked);
                  }}
                  className="w-5 h-5 accent-[#D98BA5] cursor-pointer mt-1"
                />
              </div>

              <div className="p-3 bg-[#F6E2E6]/75 dark:bg-[#4A2532]/50 rounded-xl border border-[#D98BA5]/50 text-[11px] text-[#171613] dark:text-[#F5EFE3] flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold block">Independent Platform Moderation Notice:</span>
                  <span>
                    Anonymous posts hide your name and @username from other users. To prevent harassment, doxxing, and illegal threats, anonymous posts remain auditable internally by the authorized Schoolbackdoor Admin.
                  </span>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-[#171613]/10 dark:border-white/10 flex justify-end">
              <GlassButton type="submit" variant="pink" disabled={isSaving}>
                {isSaving ? 'Updating...' : 'Save Privacy Preferences'}
              </GlassButton>
            </div>
          </form>
        )}

        {activeTab === 'blocked' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-[#82796F] dark:text-[#A89F95] mb-1">
              Blocked students cannot send you direct messages or contact you through restricted messenger threads. Public bulletins and commons dispatches remain subject to institutional guidelines.
            </p>

            {blockedUsers.length > 0 ? (
              <div className="divide-y divide-[#171613]/8 dark:divide-white/8 border border-[#171613]/10 dark:border-white/10 rounded-2xl overflow-hidden glass-subtle">
                {blockedUsers.map((b) => (
                  <div
                    key={b.blockId}
                    className="p-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <UserAvatar
                        name={b.name}
                        initials={b.avatarInitials}
                        avatarUrl={b.avatarUrl}
                        avatarThumbUrl={b.avatarThumbUrl}
                        size="md"
                      />
                      <div className="min-w-0">
                        <span className="font-semibold text-xs text-[#171613] dark:text-[#F5EFE3] block truncate">
                          {b.name}
                        </span>
                        <span className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono block">
                          {b.handle} · {b.department}
                        </span>
                      </div>
                    </div>

                    <GlassButton
                      variant="glass"
                      size="sm"
                      onClick={() => handleUnblock(b.userId)}
                    >
                      Unblock
                    </GlassButton>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-[#82796F] dark:text-[#A89F95] glass-subtle rounded-2xl">
                You have not blocked any students. Your direct messenger is open to coursemates.
              </div>
            )}
          </div>
        )}
      </div>
    </GlassModal>

      <AvatarCropModal
        isOpen={isAvatarModalOpen}
        currentAvatarUrl={profile.avatarUrl}
        currentAvatarThumbUrl={profile.avatarThumbUrl}
        userName={profile.name}
        initials={profile.avatarInitials}
        avatarBg={avatarBg}
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
            onProfileUpdated(updated);
            setFeedback({ type: 'success', message: 'Profile picture updated.' });
          }
        }}
        onRemove={
          profile.avatarUrl
            ? async () => {
                const updated = await api.updateProfile({ removeAvatar: true });
                if (updated) {
                  triggerHaptic('success');
                  onProfileUpdated(updated);
                  setFeedback({ type: 'success', message: 'Profile picture removed.' });
                }
              }
            : undefined
        }
      />
    </>
  );
};

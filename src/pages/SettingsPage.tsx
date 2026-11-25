import React, { Suspense, lazy, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Camera,
  Check,
  Copy,
  Download,
  FileText,
  Fingerprint,
  KeyRound,
  Laptop,
  Lock,
  MapPin,
  Monitor,
  Moon,
  Navigation,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  Smartphone,
  Sun,
  Tablet,
  Trash2,
  UserMinus,
} from 'lucide-react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  BlockedUser,
  DeviceSession,
  PasskeySummary,
  RecoveryCodeStatus,
  StudentProfile,
} from '../types';
import { api } from '../api/client';
import { CAMPUS_AREA_OPTIONS, snapCoordsToArea } from '../data/locationAreas';
import { GlassButton, GlassCard, GlassTab } from '../components/glass';
import { UserAvatar } from '../components/common/UserAvatar';
import { downloadRecoveryCodesTxt } from '../components/auth/AuthModal';
import { IMAGE_UPLOAD_GUIDANCE } from '../utils/imageCompression';
import { ThemePreference, useTheme } from '../utils/useTheme';
import { triggerHaptic } from '../utils/haptics';
import { formatPasskeyError, isPasskeySupported } from '../utils/webauthn';

const AvatarCropModal = lazy(() =>
  import('../components/profile/AvatarCropModal').then((m) => ({ default: m.AvatarCropModal }))
);

interface SettingsPageProps {
  profile?: StudentProfile;
  onProfileUpdated?: (updated: StudentProfile) => void;
  onOpenAuth?: (mode?: 'login' | 'register') => void;
  onLogout?: () => void;
  onNavigateToTab?: (tab: any) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  profile,
  onProfileUpdated,
  onOpenAuth,
  onLogout,
  onNavigateToTab,
}) => {
  const { preference: themePreference, resolvedTheme, setTheme } = useTheme();

  const [activeSettingsTab, setActiveSettingsTab] = useState<
    'privacy' | 'devices' | 'blocked' | 'notifications' | 'erasure'
  >('privacy');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteConfirmationInput, setDeleteConfirmationInput] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [sessionLimits, setSessionLimits] = useState({
    maxActiveDevices: 5,
    accessTtlMinutes: 15,
    refreshTtlDays: 30,
    maxLifetimeDays: 90,
  });
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);

  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; otpauthUri: string; sampleCurrentCode?: string } | null>(null);
  const [mfaCodeInput, setMfaCodeInput] = useState('');
  const [mfaDisablePassword, setMfaDisablePassword] = useState('');
  const [isMfaBusy, setIsMfaBusy] = useState(false);

  const [notifyMentions, setNotifyMentions] = useState<boolean>(profile?.notifyMentions !== false);
  const [examAlerts, setExamAlerts] = useState<boolean>(profile?.notifyCommunityAlerts !== false);
  const [hostelAlerts, setHostelAlerts] = useState<boolean>(profile?.notifyHostelAlerts !== false);
  const [messagePings, setMessagePings] = useState<boolean>(
    profile?.notifyMessages !== false && profile?.notifyReplies !== false
  );

  const [isPrivate, setIsPrivate] = useState<boolean>(profile?.isPrivate ?? false);
  const [allowAnon, setAllowAnon] = useState<boolean>(profile?.allowAnonymousPosts ?? true);
  const [showOnline, setShowOnline] = useState<boolean>(profile?.showOnlineStatus ?? true);
  const [locationSharingEnabled, setLocationSharingEnabled] = useState<boolean>(
    Boolean(profile?.locationSharingEnabled)
  );
  const [preferredLocationArea, setPreferredLocationArea] = useState<string>(
    profile?.preferredLocationArea || 'obanla'
  );
  const [isDetectingArea, setIsDetectingArea] = useState(false);

  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [isLoadingBlocks, setIsLoadingBlocks] = useState(false);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);

  const [savedSuccess, setSavedSuccess] = useState(false);
  const [notifSavedSuccess, setNotifSavedSuccess] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryCodeStatus | null>(null);
  const [regenPassword, setRegenPassword] = useState('');
  const [isRegeneratingCodes, setIsRegeneratingCodes] = useState(false);
  const [freshRecoveryCodes, setFreshRecoveryCodes] = useState<string[] | null>(null);
  const [copiedFreshCodes, setCopiedFreshCodes] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [passkeyLabelInput, setPasskeyLabelInput] = useState('');
  const [isAddingPasskey, setIsAddingPasskey] = useState(false);
  const [removingPasskeyId, setRemovingPasskeyId] = useState<string | null>(null);
  const [reauthPasskeyTargetId, setReauthPasskeyTargetId] = useState<string | null>(null);
  const [passkeyReauthPassword, setPasskeyReauthPassword] = useState('');
  const [isPasskeyReauthing, setIsPasskeyReauthing] = useState(false);
  const webauthnSupported = isPasskeySupported();
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);
  const [isUpdatingAvatar, setIsUpdatingAvatar] = useState(false);

  useEffect(() => {
    if (profile) {
      setIsPrivate(Boolean(profile.isPrivate));
      setAllowAnon(profile.allowAnonymousPosts !== false);
      setShowOnline(profile.showOnlineStatus !== false);
      setLocationSharingEnabled(Boolean(profile.locationSharingEnabled));
      setPreferredLocationArea(profile.preferredLocationArea || 'obanla');
      setNotifyMentions(profile.notifyMentions !== false);
      setExamAlerts(profile.notifyCommunityAlerts !== false);
      setHostelAlerts(profile.notifyHostelAlerts !== false);
      setMessagePings(profile.notifyMessages !== false && profile.notifyReplies !== false);
    }
  }, [profile]);

  const loadBlockedUsers = async () => {
    setIsLoadingBlocks(true);
    try {
      const data = await api.getBlockedUsers();
      setBlockedUsers(data);
    } catch (e) {
      console.warn('Failed to load blocked users:', e);
    } finally {
      setIsLoadingBlocks(false);
    }
  };

  const loadSessionsAndSecurity = async () => {
    if (!profile?.userId) return;
    setIsLoadingSessions(true);
    try {
      const [data, rcStatus, passkeyList] = await Promise.all([
        api.getMySessions(),
        api.getRecoveryCodeStatus().catch(() => null),
        api.listPasskeys().catch(() => []),
      ]);
      setSessions(data.sessions || []);
      setSessionLimits({
        maxActiveDevices: data.maxActiveDevices || 5,
        accessTtlMinutes: data.accessTtlMinutes || 15,
        refreshTtlDays: data.refreshTtlDays || 30,
        maxLifetimeDays: data.maxLifetimeDays || 90,
      });
      if (rcStatus) {
        setRecoveryStatus(rcStatus);
      }
      setPasskeys(passkeyList || []);
      if (profile.role === 'admin' || profile.role === 'moderator') {
        const mfaRes = await api.getMfaStatus();
        setMfaEnabled(Boolean(mfaRes.mfaEnabled));
      }
    } catch (e) {
      console.warn('Failed to load active sessions:', e);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  useEffect(() => {
    loadBlockedUsers();
  }, []);

  useEffect(() => {
    if (profile?.userId && activeSettingsTab === 'devices') {
      loadSessionsAndSecurity();
    }
  }, [profile?.userId, activeSettingsTab]);

  const showNotice = (msg: string) => {
    setActionNotice(msg);
    setTimeout(() => setActionNotice(null), 3000);
  };

  const handleUnblock = async (blockedUserId: string, name: string) => {
    setUnblockingId(blockedUserId);
    try {
      await api.unblockUser(blockedUserId);
      setBlockedUsers((prev) => prev.filter((b) => b.userId !== blockedUserId));
      triggerHaptic('success');
      showNotice(`Unblocked ${name}. Direct messaging is restored.`);
    } catch (e: any) {
      triggerHaptic('error');
      showNotice(e.message || 'Failed to unblock user.');
    } finally {
      setUnblockingId(null);
    }
  };

  const handleSavePrivacyAndPrefs = async () => {
    try {
      const updated = await api.updateProfile({
        isPrivate: isPrivate,
        allowAnonymousPosts: allowAnon,
        showOnlineStatus: showOnline,
        locationSharingEnabled,
        preferredLocationArea: locationSharingEnabled ? preferredLocationArea : null,
      });

      if (updated && onProfileUpdated) {
        onProfileUpdated(updated);
      }
      setSavedSuccess(true);
      triggerHaptic('success');
      showNotice('Privacy preferences saved.');
      setTimeout(() => setSavedSuccess(false), 2500);
    } catch (e: any) {
      console.error('Failed to sync privacy preferences:', e);
      triggerHaptic('error');
      showNotice(e?.message || 'Unable to save privacy preferences right now.');
    }
  };

  const handlePersistNotificationPrefs = async (
    patch: Partial<StudentProfile>,
    noticeLabel = 'Notification preferences saved.'
  ) => {
    if (!profile?.userId) {
      showNotice('Sign in to save notification preferences permanently.');
      return;
    }
    try {
      const updated = await api.updateProfile(patch);
      if (updated && onProfileUpdated) {
        onProfileUpdated(updated);
      }
      setNotifSavedSuccess(true);
      triggerHaptic('success');
      showNotice(noticeLabel);
      setTimeout(() => setNotifSavedSuccess(false), 2500);
    } catch (e: any) {
      triggerHaptic('error');
      showNotice(e?.message || 'Unable to update notification settings.');
    }
  };

  const themeOptions: {
    id: ThemePreference;
    label: string;
    description: string;
    icon: React.ReactNode;
  }[] = [
    {
      id: 'light',
      label: 'Light Mode',
      description: 'Warm Cream & Translucent Silk',
      icon: <Sun className="w-4 h-4" />,
    },
    {
      id: 'dark',
      label: 'Dark Mode',
      description: 'Warm Obsidian & Rose Accent',
      icon: <Moon className="w-4 h-4" />,
    },
    {
      id: 'system',
      label: 'System Default',
      description: `Follows device (${resolvedTheme === 'dark' ? 'Dark' : 'Light'})`,
      icon: <Monitor className="w-4 h-4" />,
    },
  ];

  const settingsTabItems = [
    { id: 'privacy' as const, label: 'Privacy', icon: <Shield className="w-3.5 h-3.5" /> },
    { id: 'devices' as const, label: 'Security & Devices', icon: <KeyRound className="w-3.5 h-3.5" /> },
    {
      id: 'blocked' as const,
      label: 'Blocked',
      count: blockedUsers.length,
      icon: <UserMinus className="w-3.5 h-3.5" />,
    },
    { id: 'notifications' as const, label: 'Notifications', icon: <Bell className="w-3.5 h-3.5" /> },
    { id: 'erasure' as const, label: 'Data & NDPA', icon: <Trash2 className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="w-full flex justify-center px-4 py-6 md:py-8">
      <div className="w-full max-w-3xl flex flex-col gap-6">
        {/* Header */}
        <div className="border-b border-[#171613]/10 dark:border-[#F5EFE3]/12 pb-5">
          <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#82796F] dark:text-[#A89F95]">
            Account Preferences
          </div>
          <h1 className="font-serif text-2xl md:text-3xl font-bold tracking-tight text-[#171613] dark:text-[#F5EFE3] mt-1">
            Settings &amp; Appearance
          </h1>
          <p className="text-xs md:text-sm text-[#82796F] dark:text-[#A89F95] mt-1">
            Customize theme appearance, privacy shielding, blocked users, notifications, and NDPA data rights. All Schoolbackdoor features are 100% free.
          </p>
        </div>

        {/* Action Notice Banner */}
        {actionNotice && (
          <div className="p-3.5 glass-dark text-[#F5EFE3] rounded-2xl text-xs font-medium flex items-center justify-between animate-sb-in">
            <span>{actionNotice}</span>
            <button
              type="button"
              onClick={() => setActionNotice(null)}
              className="text-[#D98BA5] hover:text-[#F5EFE3] text-xs cursor-pointer font-semibold"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Appearance & Theme Selector */}
        <GlassCard tone="cream" padding="lg" className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
            <div className="flex items-center gap-2">
              {resolvedTheme === 'dark' ? (
                <Moon className="w-4 h-4 text-[#D98BA5]" />
              ) : (
                <Sun className="w-4 h-4 text-[#C4718E]" />
              )}
              <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                Appearance &amp; Theme
              </h2>
            </div>
            <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] capitalize">
              Active: {themePreference}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5" role="radiogroup" aria-label="Theme appearance">
            {themeOptions.map((opt) => {
              const selected = themePreference === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    triggerHaptic('tap');
                    setTheme(opt.id);
                    showNotice(`Appearance set to ${opt.label}`);
                  }}
                  className={`p-3.5 rounded-2xl border text-left transition-all cursor-pointer flex items-start gap-3 min-h-[56px] ${
                    selected
                      ? 'bg-[#F6E2E6]/85 dark:bg-[#D98BA5]/20 border-[#C4718E] dark:border-[#D98BA5] shadow-xs'
                      : 'bg-[#FFFCF7]/75 dark:bg-[#23211C]/75 border-[#171613]/10 dark:border-[#F5EFE3]/10 hover:bg-[#FFFCF7] dark:hover:bg-[#2A2722]'
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                      selected
                        ? 'bg-[#D98BA5] text-[#171613]'
                        : 'bg-[#E8DDCC]/75 dark:bg-[#F5EFE3]/10 text-[#171613] dark:text-[#F5EFE3]'
                    }`}
                  >
                    {opt.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                        {opt.label}
                      </span>
                      {selected && <Check className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />}
                    </div>
                    <p className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5 leading-snug">
                      {opt.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </GlassCard>

        {/* Profile Picture Management */}
        {profile?.userId && (
          <GlassCard tone="cream" padding="lg" className="flex flex-col gap-3.5">
            <div className="flex items-center justify-between gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                  Profile Picture
                </h2>
              </div>
              <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">
                {IMAGE_UPLOAD_GUIDANCE}
              </span>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3.5 min-w-0">
                <UserAvatar
                  name={profile.name}
                  initials={profile.avatarInitials}
                  bg={profile.avatarBg}
                  avatarUrl={profile.avatarUrl}
                  avatarThumbUrl={profile.avatarThumbUrl}
                  size="xl"
                  className="ring-2 ring-[#FFFCF7] dark:ring-[#23211C]"
                />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[#171613] dark:text-[#F5EFE3] truncate">
                    {profile.name}
                  </div>
                  <div className="text-xs text-[#82796F] dark:text-[#A89F95] font-mono truncate">
                    {profile.handle}
                  </div>
                  <p className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5">
                    Displayed across posts, comments, chats, and community spaces.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap shrink-0">
                <GlassButton
                  type="button"
                  variant="pink"
                  size="sm"
                  disabled={isUpdatingAvatar}
                  onClick={() => {
                    triggerHaptic('tap');
                    setIsAvatarModalOpen(true);
                  }}
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{profile.avatarUrl ? 'Replace Photo' : 'Upload Photo'}</span>
                </GlassButton>
                {profile.avatarUrl && (
                  <GlassButton
                    type="button"
                    variant="glass"
                    size="sm"
                    disabled={isUpdatingAvatar}
                    onClick={async () => {
                      setIsUpdatingAvatar(true);
                      try {
                        const updated = await api.updateProfile({ removeAvatar: true });
                        if (updated && onProfileUpdated) {
                          onProfileUpdated(updated);
                        }
                        triggerHaptic('success');
                        showNotice('Profile picture removed.');
                      } catch (err: any) {
                        triggerHaptic('error');
                        showNotice(err?.message || 'Unable to remove profile picture.');
                      } finally {
                        setIsUpdatingAvatar(false);
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isUpdatingAvatar ? 'Removing...' : 'Remove Photo'}</span>
                  </GlassButton>
                )}
              </div>
            </div>
          </GlassCard>
        )}

        {/* Settings Navigation Tabs */}
        <GlassTab
          items={settingsTabItems}
          activeId={activeSettingsTab}
          onChange={(id) => setActiveSettingsTab(id)}
        />

        {/* 1. PRIVACY & DOSSIER SHIELDING */}
        {activeSettingsTab === 'privacy' && (
          <GlassCard tone="cream" padding="lg" className="flex flex-col gap-4 animate-sb-in">
            <div className="flex items-center gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
              <Shield className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
              <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                Privacy Shielding &amp; Anonymous Posting
              </h2>
            </div>

            <div className="flex flex-col divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10 text-xs">
              <div className="flex items-center justify-between py-3.5 gap-4">
                <div>
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block">Private Account Profile</span>
                  <span className="text-[#82796F] dark:text-[#A89F95] text-[11px] leading-relaxed">
                    When active, non-connected members cannot view your detailed profile or post history. The platform Admin retains safety audit traceability.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPrivate}
                  onClick={() => {
                    triggerHaptic('tap');
                    setIsPrivate(!isPrivate);
                  }}
                  className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                    isPrivate ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                  }`}
                >
                  <div
                    className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                      isPrivate ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between py-3.5 gap-4">
                <div>
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block">Allow Anonymous Posts</span>
                  <span className="text-[#82796F] dark:text-[#A89F95] text-[11px] leading-relaxed">
                    Publish posts masked as &quot;Anonymous Member&quot; (@anonymous). Hidden from peers, traceable internally by the Admin only for safety investigations.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={allowAnon}
                  onClick={() => {
                    triggerHaptic('tap');
                    setAllowAnon(!allowAnon);
                  }}
                  className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                    allowAnon ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                  }`}
                >
                  <div
                    className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                      allowAnon ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between py-3.5 gap-4">
                <div>
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block">Show Live Presence Status</span>
                  <span className="text-[#82796F] dark:text-[#A89F95] text-[11px] leading-relaxed">
                    Display your active status dot to friends and count toward the live online member count.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showOnline}
                  onClick={() => {
                    triggerHaptic('tap');
                    setShowOnline(!showOnline);
                  }}
                  className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                    showOnline ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                  }`}
                >
                  <div
                    className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                      showOnline ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex flex-col py-3.5 gap-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
                      <span>Area-Based Feed Personalization (Optional)</span>
                    </span>
                    <span className="text-[#82796F] dark:text-[#A89F95] text-[11px] leading-relaxed block mt-0.5">
                      Optionally boost nearby campus and community posts. Only your chosen coarse area is saved — exact GPS coordinates are never collected or stored.
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="Toggle area-based feed personalization"
                    aria-checked={locationSharingEnabled}
                    onClick={() => {
                      triggerHaptic('tap');
                      setLocationSharingEnabled(!locationSharingEnabled);
                    }}
                    className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                      locationSharingEnabled ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                    }`}
                  >
                    <div
                      className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                        locationSharingEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {locationSharingEnabled && (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-xl glass-subtle animate-sb-in">
                    <select
                      value={preferredLocationArea}
                      onChange={(e) => setPreferredLocationArea(e.target.value)}
                      aria-label="Preferred campus or surrounding area"
                      className="flex-1 min-h-[38px] px-3 py-1.5 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3]"
                    >
                      {CAMPUS_AREA_OPTIONS.map((area) => (
                        <option key={area.key} value={area.key}>
                          {area.label}
                        </option>
                      ))}
                    </select>
                    <GlassButton
                      type="button"
                      variant="glass"
                      size="sm"
                      disabled={isDetectingArea}
                      onClick={() => {
                        if (typeof navigator === 'undefined' || !navigator.geolocation) {
                          showNotice('Geolocation is unavailable in this browser.');
                          return;
                        }
                        setIsDetectingArea(true);
                        navigator.geolocation.getCurrentPosition(
                          (pos) => {
                            setIsDetectingArea(false);
                            const snapped = snapCoordsToArea(pos.coords.latitude, pos.coords.longitude);
                            if (snapped) {
                              setPreferredLocationArea(snapped.key);
                              showNotice(`Snapped to ${snapped.shortLabel}. Click Save Privacy Settings to apply.`);
                            } else {
                              showNotice('Could not match a nearby campus zone.');
                            }
                          },
                          () => {
                            setIsDetectingArea(false);
                            showNotice('Location permission declined. Select an area manually.');
                          },
                          { enableHighAccuracy: false, timeout: 7000, maximumAge: 180000 }
                        );
                      }}
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      <span>{isDetectingArea ? 'Detecting...' : 'Detect Nearest Area'}</span>
                    </GlassButton>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              {savedSuccess && (
                <span className="text-xs text-[#C4718E] dark:text-[#E5A4BA] font-semibold flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  <span>Saved</span>
                </span>
              )}
              <GlassButton variant="black" size="sm" onClick={handleSavePrivacyAndPrefs}>
                Save Privacy Settings
              </GlassButton>
            </div>
          </GlassCard>
        )}

        {/* 1B. SECURITY & ACTIVE DEVICES */}
        {activeSettingsTab === 'devices' && (
          <div className="flex flex-col gap-4 animate-sb-in">
            <GlassCard tone="cream" padding="lg" className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
                <div className="flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                  <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                    Devices &amp; Active Sessions ({sessions.length}/{sessionLimits.maxActiveDevices})
                  </h2>
                </div>
                {profile?.userId && sessions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {sessions.length > 1 && (
                      <GlassButton
                        variant="glass"
                        size="sm"
                        onClick={async () => {
                          try {
                            const res = await api.revokeOtherSessions();
                            showNotice(`Signed out ${res.revokedCount} other device(s).`);
                            await loadSessionsAndSecurity();
                          } catch (e: any) {
                            showNotice(e?.message || 'Unable to sign out other devices.');
                          }
                        }}
                      >
                        Sign Out All Other Devices
                      </GlassButton>
                    )}
                    <GlassButton
                      variant="black"
                      size="sm"
                      onClick={async () => {
                        try {
                          await api.revokeAllSessions();
                          triggerHaptic('success');
                          onLogout?.();
                        } catch (e: any) {
                          showNotice(e?.message || 'Unable to sign out everywhere.');
                        }
                      }}
                    >
                      Sign Out Everywhere
                    </GlassButton>
                  </div>
                )}
              </div>

              <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] bg-[#E8DDCC]/50 dark:bg-white/5 px-3.5 py-2.5 rounded-xl leading-relaxed">
                Up to <strong>{sessionLimits.maxActiveDevices}</strong> concurrent devices are allowed per account. Sessions rotate silently every <strong>{sessionLimits.accessTtlMinutes}m</strong>, expire after <strong>{sessionLimits.refreshTtlDays} days</strong> of inactivity, and require fresh sign-in after <strong>{sessionLimits.maxLifetimeDays} days</strong>.
              </div>

              {!profile?.userId ? (
                <div className="py-6 text-center text-xs text-[#82796F] dark:text-[#A89F95] glass-subtle rounded-xl">
                  Sign in to manage active sessions and connected devices.
                </div>
              ) : isLoadingSessions ? (
                <div className="py-6 text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                  Loading active devices...
                </div>
              ) : sessions.length === 0 ? (
                <div className="py-6 text-center text-xs text-[#82796F] dark:text-[#A89F95] glass-subtle rounded-xl">
                  No active device sessions found.
                </div>
              ) : (
                <div className="divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10 text-xs">
                  {sessions.map((s) => (
                    <div key={s.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-xl bg-[#E8DDCC]/75 dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3] flex items-center justify-center shrink-0 mt-0.5">
                          {s.deviceType === 'phone' ? (
                            <Smartphone className="w-4 h-4" />
                          ) : s.deviceType === 'tablet' ? (
                            <Tablet className="w-4 h-4" />
                          ) : (
                            <Laptop className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{s.deviceName}</span>
                            {s.isCurrent && (
                              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-[#D98BA5] text-[#171613]">
                                Current Device
                              </span>
                            )}
                            {s.isSuspicious && (
                              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-[#171613] text-[#F5EFE3] dark:bg-[#4A2532]">
                                New / Unfamiliar
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono mt-0.5 truncate">
                            IP {s.ipAddress} · Last active {new Date(s.lastActiveAt || s.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </div>

                      <GlassButton
                        variant="glass"
                        size="sm"
                        disabled={revokingSessionId === s.id}
                        onClick={async () => {
                          setRevokingSessionId(s.id);
                          try {
                            const res = await api.revokeMySession(s.id);
                            triggerHaptic('success');
                            if (res.revokedSelf && onLogout) {
                              onLogout();
                              return;
                            }
                            showNotice(`Signed out ${s.deviceName}.`);
                            await loadSessionsAndSecurity();
                          } catch (e: any) {
                            showNotice(e?.message || 'Unable to revoke session.');
                          } finally {
                            setRevokingSessionId(null);
                          }
                        }}
                      >
                        {revokingSessionId === s.id ? 'Signing out...' : s.isCurrent ? 'Sign Out Here' : 'Sign Out'}
                      </GlassButton>
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>

            {profile?.userId && (
              <GlassCard tone="cream" padding="lg" className="flex flex-col gap-3.5 text-xs">
                <div className="flex items-center justify-between gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
                  <div className="flex items-center gap-2">
                    <Fingerprint className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                      Passkeys (Biometric &amp; Security Keys)
                    </h3>
                  </div>
                  <span className="font-mono text-[11px] px-2.5 py-0.5 rounded-md glass-subtle text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    {passkeys.length} registered
                  </span>
                </div>

                <p className="text-[11px] text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                  Sign in faster and recover your password without SMS or email. Schoolbackdoor stores only your public key credential metadata — biometric data never leaves your device.
                </p>

                {!webauthnSupported && (
                  <div className="p-3 rounded-xl bg-[#E8DDCC]/60 dark:bg-white/5 text-[11px] text-[#82796F] dark:text-[#A89F95]">
                    Passkeys are unavailable in this browser or non-HTTPS context. You can still manage previously added passkeys below or use your password.
                  </div>
                )}

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!webauthnSupported || isAddingPasskey) return;
                    setIsAddingPasskey(true);
                    try {
                      const options = await api.getPasskeyRegisterOptions();
                      const attestation = await startRegistration({ optionsJSON: options });
                      const res = await api.verifyPasskeyRegister(
                        attestation,
                        passkeyLabelInput.trim() || undefined
                      );
                      setPasskeys((prev) => [res.passkey, ...prev]);
                      setPasskeyLabelInput('');
                      triggerHaptic('success');
                      showNotice(`Passkey "${res.passkey.label}" added.`);
                    } catch (err: any) {
                      triggerHaptic('error');
                      showNotice(formatPasskeyError(err, 'Unable to add passkey.'));
                    } finally {
                      setIsAddingPasskey(false);
                    }
                  }}
                  className="flex flex-col sm:flex-row gap-2.5"
                >
                  <input
                    type="text"
                    maxLength={60}
                    value={passkeyLabelInput}
                    onChange={(e) => setPasskeyLabelInput(e.target.value)}
                    placeholder="Device label (e.g. Pixel Chrome, MacBook Touch ID)"
                    className="flex-1 px-3.5 py-2 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3]"
                  />
                  <GlassButton
                    type="submit"
                    variant="pink"
                    size="sm"
                    disabled={!webauthnSupported || isAddingPasskey}
                    loading={isAddingPasskey}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Passkey</span>
                  </GlassButton>
                </form>

                {passkeys.length === 0 ? (
                  <div className="py-5 text-center text-xs text-[#82796F] dark:text-[#A89F95] glass-subtle rounded-xl">
                    No passkeys registered yet. Add one above for passwordless sign-in and Method B recovery.
                  </div>
                ) : (
                  <div className="divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10">
                    {passkeys.map((pk) => (
                      <div key={pk.id} className="py-3 flex flex-col gap-2.5">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                                {pk.label}
                              </span>
                              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-[#E8DDCC]/75 dark:bg-white/10 text-[#171613] dark:text-[#F5EFE3]">
                                {pk.backedUp ? 'Synced Passkey' : pk.deviceType === 'singleDevice' ? 'Device / Key' : 'Passkey'}
                              </span>
                            </div>
                            <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono mt-0.5">
                              Added {new Date(pk.createdAt).toLocaleDateString()}
                              {pk.lastUsedAt
                                ? ` · Last used ${new Date(pk.lastUsedAt).toLocaleString()}`
                                : ' · Never used yet'}
                            </div>
                          </div>

                          <GlassButton
                            type="button"
                            variant="glass"
                            size="sm"
                            disabled={removingPasskeyId === pk.id}
                            onClick={async () => {
                              setRemovingPasskeyId(pk.id);
                              try {
                                const res = await api.deletePasskey(pk.id);
                                setPasskeys((prev) => prev.filter((item) => item.id !== pk.id));
                                setReauthPasskeyTargetId(null);
                                triggerHaptic('success');
                                showNotice(res.message || 'Passkey removed.');
                              } catch (err: any) {
                                if (err?.code === 'REAUTH_REQUIRED' || err?.status === 403) {
                                  setReauthPasskeyTargetId(pk.id);
                                  setPasskeyReauthPassword('');
                                  showNotice('Confirm your identity below before removing this passkey.');
                                } else {
                                  triggerHaptic('error');
                                  showNotice(err?.message || 'Unable to remove passkey.');
                                }
                              } finally {
                                setRemovingPasskeyId(null);
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>{removingPasskeyId === pk.id ? 'Removing...' : 'Remove'}</span>
                          </GlassButton>
                        </div>

                        {reauthPasskeyTargetId === pk.id && (
                          <div className="p-3 rounded-xl glass-subtle border border-[#D98BA5]/55 space-y-2 animate-sb-in">
                            <div className="text-[11px] font-semibold text-[#171613] dark:text-[#F5EFE3]">
                              Re-authentication required to remove &ldquo;{pk.label}&rdquo;:
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <input
                                type="password"
                                autoComplete="current-password"
                                value={passkeyReauthPassword}
                                onChange={(e) => setPasskeyReauthPassword(e.target.value)}
                                placeholder="Enter current password"
                                className="flex-1 px-3 py-1.5 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3]"
                              />
                              <GlassButton
                                type="button"
                                variant="black"
                                size="sm"
                                disabled={!passkeyReauthPassword || isPasskeyReauthing}
                                onClick={async () => {
                                  setIsPasskeyReauthing(true);
                                  try {
                                    const res = await api.deletePasskey(pk.id, passkeyReauthPassword);
                                    setPasskeys((prev) => prev.filter((item) => item.id !== pk.id));
                                    setReauthPasskeyTargetId(null);
                                    setPasskeyReauthPassword('');
                                    triggerHaptic('success');
                                    showNotice(res.message || 'Passkey removed.');
                                  } catch (err: any) {
                                    triggerHaptic('error');
                                    showNotice(err?.message || 'Password verification failed.');
                                  } finally {
                                    setIsPasskeyReauthing(false);
                                  }
                                }}
                              >
                                Confirm &amp; Remove
                              </GlassButton>
                              {webauthnSupported && (
                                <GlassButton
                                  type="button"
                                  variant="pink"
                                  size="sm"
                                  disabled={isPasskeyReauthing}
                                  onClick={async () => {
                                    setIsPasskeyReauthing(true);
                                    try {
                                      const opts = await api.getPasskeyReauthOptions();
                                      const assertion = await startAuthentication({ optionsJSON: opts });
                                      await api.verifyPasskeyReauth(assertion);
                                      const res = await api.deletePasskey(pk.id);
                                      setPasskeys((prev) => prev.filter((item) => item.id !== pk.id));
                                      setReauthPasskeyTargetId(null);
                                      triggerHaptic('success');
                                      showNotice(res.message || 'Passkey verified and removed.');
                                    } catch (err: any) {
                                      triggerHaptic('error');
                                      showNotice(formatPasskeyError(err, 'Passkey verification failed.'));
                                    } finally {
                                      setIsPasskeyReauthing(false);
                                    }
                                  }}
                                >
                                  <Fingerprint className="w-3.5 h-3.5" />
                                  <span>Use Passkey</span>
                                </GlassButton>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </GlassCard>
            )}

            {profile?.userId && (
              <GlassCard tone="cream" padding="lg" className="flex flex-col gap-3.5 text-xs">
                <div className="flex items-center gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
                  <Lock className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                  <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                    Password &amp; Privileged MFA
                  </h3>
                </div>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!currentPasswordInput || !newPasswordInput) return;
                    setIsChangingPassword(true);
                    try {
                      const res = await api.changePassword(currentPasswordInput, newPasswordInput);
                      setCurrentPasswordInput('');
                      setNewPasswordInput('');
                      triggerHaptic('success');
                      showNotice(
                        res.revokedOtherSessions > 0
                          ? `Password updated and ${res.revokedOtherSessions} other device session(s) signed out.`
                          : 'Password updated securely.'
                      );
                      await loadSessionsAndSecurity();
                    } catch (err: any) {
                      triggerHaptic('error');
                      showNotice(err?.message || 'Unable to change password.');
                    } finally {
                      setIsChangingPassword(false);
                    }
                  }}
                  className="grid grid-cols-1 sm:grid-cols-3 gap-2.5"
                >
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={currentPasswordInput}
                    onChange={(e) => setCurrentPasswordInput(e.target.value)}
                    placeholder="Current password"
                    className="px-3.5 py-2 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3]"
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={newPasswordInput}
                    onChange={(e) => setNewPasswordInput(e.target.value)}
                    placeholder="New strong password (8+ chars)"
                    className="px-3.5 py-2 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3]"
                  />
                  <GlassButton type="submit" variant="black" size="sm" loading={isChangingPassword}>
                    Update Password
                  </GlassButton>
                </form>

                {(profile.role === 'admin' || profile.role === 'moderator') && (
                  <div className="pt-3 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-semibold text-[#171613] dark:text-[#F5EFE3]">
                        <ShieldAlert className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                        <span>Authenticator Two-Factor Authentication ({profile.role === 'admin' ? 'Admin' : 'Moderator'})</span>
                      </div>
                      <span className="font-mono text-[11px] uppercase px-2 py-0.5 rounded-md glass-subtle">
                        {mfaEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>

                    {!mfaEnabled ? (
                      !mfaSetup ? (
                        <GlassButton
                          variant="pink"
                          size="sm"
                          disabled={isMfaBusy}
                          onClick={async () => {
                            setIsMfaBusy(true);
                            try {
                              const res = await api.setupMfa();
                              setMfaSetup(res);
                              if (res.sampleCurrentCode) setMfaCodeInput(res.sampleCurrentCode);
                            } catch (err: any) {
                              showNotice(err?.message || 'Unable to generate authenticator secret.');
                            } finally {
                              setIsMfaBusy(false);
                            }
                          }}
                        >
                          Configure TOTP Authenticator
                        </GlassButton>
                      ) : (
                        <div className="p-3 rounded-xl glass-subtle space-y-2">
                          <div className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                            Add this secret to your authenticator app, then verify the 6-digit code:
                          </div>
                          <code className="font-mono font-bold block select-all text-[#171613] dark:text-[#F5EFE3]">
                            {mfaSetup.secret}
                          </code>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={mfaCodeInput}
                              onChange={(e) => setMfaCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                              placeholder="6-digit code"
                              maxLength={6}
                              className="flex-1 px-3 py-1.5 glass-input rounded-xl font-mono"
                            />
                            <GlassButton
                              variant="pink"
                              size="sm"
                              disabled={isMfaBusy || mfaCodeInput.length !== 6}
                              onClick={async () => {
                                setIsMfaBusy(true);
                                try {
                                  await api.verifyMfa(mfaCodeInput);
                                  setMfaEnabled(true);
                                  setMfaSetup(null);
                                  setMfaCodeInput('');
                                  showNotice('Two-factor authentication enabled for your privileged account.');
                                } catch (err: any) {
                                  showNotice(err?.message || 'Verification failed.');
                                } finally {
                                  setIsMfaBusy(false);
                                }
                              }}
                            >
                              Verify &amp; Enable
                            </GlassButton>
                          </div>
                        </div>
                      )
                    ) : (
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="password"
                          value={mfaDisablePassword}
                          onChange={(e) => setMfaDisablePassword(e.target.value)}
                          placeholder="Enter current password to disable 2FA"
                          className="flex-1 px-3 py-1.5 glass-input rounded-xl"
                        />
                        <GlassButton
                          variant="black"
                          size="sm"
                          disabled={isMfaBusy || !mfaDisablePassword}
                          onClick={async () => {
                            setIsMfaBusy(true);
                            try {
                              await api.disableMfa(mfaDisablePassword);
                              setMfaEnabled(false);
                              setMfaDisablePassword('');
                              showNotice('Two-factor authentication disabled.');
                            } catch (err: any) {
                              showNotice(err?.message || 'Unable to disable 2FA.');
                            } finally {
                              setIsMfaBusy(false);
                            }
                          }}
                        >
                          Disable 2FA
                        </GlassButton>
                      </div>
                    )}
                  </div>
                )}
              </GlassCard>
            )}

            {profile?.userId && (
              <GlassCard tone="cream" padding="lg" className="flex flex-col gap-3.5 text-xs">
                <div className="flex items-center justify-between gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                      Single-Use Recovery Codes
                    </h3>
                  </div>
                  <span className="font-mono text-[11px] px-2.5 py-0.5 rounded-md glass-subtle text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    {recoveryStatus ? `${recoveryStatus.remainingCount}/${recoveryStatus.totalCount} unused` : 'Checking...'}
                  </span>
                </div>

                <p className="text-[11px] text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                  Existing recovery codes are stored as cryptographic hashes and cannot be viewed again. Regenerating invalidates all unused codes and issues 10 fresh single-use codes shown once.
                </p>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!regenPassword) return;
                    setIsRegeneratingCodes(true);
                    try {
                      const res = await api.regenerateRecoveryCodes(regenPassword);
                      setFreshRecoveryCodes(res.recoveryCodes);
                      setRecoveryStatus({
                        remainingCount: res.remainingCount,
                        totalCount: res.totalCount,
                        generatedAt: res.generatedAt,
                      });
                      setRegenPassword('');
                      setCopiedFreshCodes(false);
                      triggerHaptic('success');
                      showNotice('10 new recovery codes generated. Save them immediately.');
                    } catch (err: any) {
                      triggerHaptic('error');
                      showNotice(err?.message || 'Unable to regenerate recovery codes.');
                    } finally {
                      setIsRegeneratingCodes(false);
                    }
                  }}
                  className="flex flex-col sm:flex-row gap-2.5"
                >
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={regenPassword}
                    onChange={(e) => setRegenPassword(e.target.value)}
                    placeholder="Enter current password to regenerate codes"
                    className="flex-1 px-3.5 py-2 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3]"
                  />
                  <GlassButton type="submit" variant="pink" size="sm" loading={isRegeneratingCodes}>
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Regenerate 10 Codes</span>
                  </GlassButton>
                </form>

                {freshRecoveryCodes && freshRecoveryCodes.length > 0 && (
                  <div className="p-3.5 rounded-2xl glass-subtle border border-[#D98BA5]/50 space-y-3 animate-sb-in">
                    <div className="text-[11px] font-semibold text-[#171613] dark:text-[#F5EFE3]">
                      New Single-Use Recovery Codes (shown once — copy or download now):
                    </div>
                    <div className="grid grid-cols-2 gap-2 font-mono text-xs">
                      {freshRecoveryCodes.map((code, idx) => (
                        <div
                          key={code}
                          className="px-2.5 py-1.5 rounded-lg bg-[#FFFCF7]/85 dark:bg-[#1E1C18] border border-[#171613]/8 dark:border-white/8 text-[#171613] dark:text-[#F5EFE3] flex items-center justify-between gap-1.5"
                        >
                          <span className="text-[10px] text-[#82796F] dark:text-[#A89F95]">
                            {String(idx + 1).padStart(2, '0')}
                          </span>
                          <span className="font-semibold tracking-tight select-all">{code}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <GlassButton
                        type="button"
                        variant="glass"
                        size="sm"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(freshRecoveryCodes.join('\n'));
                            setCopiedFreshCodes(true);
                            triggerHaptic('success');
                          } catch {
                            showNotice('Clipboard unavailable; please use Download .txt.');
                          }
                        }}
                      >
                        {copiedFreshCodes ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedFreshCodes ? 'Copied All' : 'Copy Codes'}</span>
                      </GlassButton>
                      <GlassButton
                        type="button"
                        variant="black"
                        size="sm"
                        onClick={() => {
                          downloadRecoveryCodesTxt(profile.handle, freshRecoveryCodes);
                          triggerHaptic('success');
                        }}
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download .txt</span>
                      </GlassButton>
                    </div>
                  </div>
                )}
              </GlassCard>
            )}
          </div>
        )}

        {/* 2. BLOCKED USERS */}
        {activeSettingsTab === 'blocked' && (
          <GlassCard tone="cream" padding="lg" className="flex flex-col gap-4 animate-sb-in">
            <div className="flex items-center justify-between border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
              <div className="flex items-center gap-2">
                <UserMinus className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                  Restricted / Blocked Direct Communications
                </h2>
              </div>
              <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] tabular-nums">
                {blockedUsers.length} blocked
              </span>
            </div>

            <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
              Blocked users cannot send you direct chat messages or initiate private conversations.
            </p>

            {isLoadingBlocks ? (
              <div className="py-6 text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                Loading blocked users...
              </div>
            ) : blockedUsers.length > 0 ? (
              <div className="divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10">
                {blockedUsers.map((b) => (
                  <div key={b.blockId} className="py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5">
                      <UserAvatar
                        name={b.name}
                        initials={b.avatarInitials}
                        avatarUrl={b.avatarUrl}
                        avatarThumbUrl={b.avatarThumbUrl}
                        size="sm"
                      />
                      <div className="flex flex-col">
                        <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{b.name}</span>
                        <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                          {b.handle} · {b.department}
                        </span>
                      </div>
                    </div>

                    <GlassButton
                      variant="glass"
                      size="sm"
                      onClick={() => handleUnblock(b.userId, b.name)}
                      disabled={unblockingId === b.userId}
                    >
                      {unblockingId === b.userId ? 'Unblocking...' : 'Unblock'}
                    </GlassButton>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-[#82796F] dark:text-[#A89F95] glass-subtle rounded-xl">
                You haven&apos;t blocked any users.
              </div>
            )}
          </GlassCard>
        )}

        {/* 3. NOTIFICATIONS */}
        {activeSettingsTab === 'notifications' && (
          <GlassCard tone="cream" padding="lg" className="flex flex-col gap-4 animate-sb-in">
            <div className="flex items-center justify-between gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                  Activity &amp; Mention Notifications
                </h2>
              </div>
              {notifSavedSuccess && (
                <span className="text-xs text-[#C4718E] dark:text-[#E5A4BA] font-semibold flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  <span>Saved</span>
                </span>
              )}
            </div>

            <div className="flex flex-col divide-y divide-[#171613]/8 dark:divide-[#F5EFE3]/10 text-xs">
              <div className="flex items-center justify-between py-3.5 gap-4">
                <div>
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block">
                    Mentions &amp; @Tags
                  </span>
                  <span className="text-[#82796F] dark:text-[#A89F95] text-[11px]">
                    Notify when someone tags you with @username in posts, comments, replies, or chats.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Toggle Mentions and @Tags notifications"
                  aria-checked={notifyMentions}
                  onClick={() => {
                    triggerHaptic('tap');
                    const next = !notifyMentions;
                    setNotifyMentions(next);
                    handlePersistNotificationPrefs(
                      { notifyMentions: next },
                      next ? 'Mention alerts enabled.' : 'Mention alerts muted.'
                    );
                  }}
                  className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                    notifyMentions ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                  }`}
                >
                  <div
                    className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                      notifyMentions ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between py-3.5 gap-4">
                <div>
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block">
                    Direct Messages &amp; Thread Replies
                  </span>
                  <span className="text-[#82796F] dark:text-[#A89F95] text-[11px]">
                    Alerts when friends message you or reply to your posts and comments.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Toggle Direct Messages and Thread Replies notifications"
                  aria-checked={messagePings}
                  onClick={() => {
                    triggerHaptic('tap');
                    const next = !messagePings;
                    setMessagePings(next);
                    handlePersistNotificationPrefs(
                      { notifyMessages: next, notifyReplies: next },
                      next ? 'Message & reply alerts enabled.' : 'Message & reply alerts muted.'
                    );
                  }}
                  className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                    messagePings ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                  }`}
                >
                  <div
                    className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                      messagePings ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between py-3.5 gap-4">
                <div>
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block">
                    Community Digest &amp; Event Alerts
                  </span>
                  <span className="text-[#82796F] dark:text-[#A89F95] text-[11px]">
                    Priority notifications for student events, community announcements, and local schedules.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Toggle Community Digest notifications"
                  aria-checked={examAlerts}
                  onClick={() => {
                    triggerHaptic('tap');
                    const next = !examAlerts;
                    setExamAlerts(next);
                    handlePersistNotificationPrefs({ notifyCommunityAlerts: next });
                  }}
                  className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                    examAlerts ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                  }`}
                >
                  <div
                    className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                      examAlerts ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between py-3.5 gap-4">
                <div>
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] block">
                    Hostel &amp; Akure Local Updates
                  </span>
                  <span className="text-[#82796F] dark:text-[#A89F95] text-[11px]">
                    Community advisories around South Gate, Jibowu, and nearby residences.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Toggle Hostel and Local Updates notifications"
                  aria-checked={hostelAlerts}
                  onClick={() => {
                    triggerHaptic('tap');
                    const next = !hostelAlerts;
                    setHostelAlerts(next);
                    handlePersistNotificationPrefs({ notifyHostelAlerts: next });
                  }}
                  className={`w-12 h-7 flex items-center rounded-lg p-1 cursor-pointer transition-colors shrink-0 ${
                    hostelAlerts ? 'bg-[#D98BA5]' : 'bg-[#E8DDCC] dark:bg-[#2E2B25]'
                  }`}
                >
                  <div
                    className={`bg-[#FFFCF7] w-5 h-5 rounded-md shadow-sm transform transition-transform ${
                      hostelAlerts ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </GlassCard>
        )}

        {/* 4. DATA ERASURE & NDPA 2023 RIGHTS */}
        {activeSettingsTab === 'erasure' && (
          <GlassCard tone="cream" padding="lg" className="flex flex-col gap-5 animate-sb-in">
            <div className="flex items-center gap-2 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-3">
              <Trash2 className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
              <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                Data Retention, Lifecycle &amp; Right to be Forgotten (NDPA 2023)
              </h2>
            </div>

            <div className="flex flex-col gap-3 text-xs leading-relaxed text-[#82796F] dark:text-[#A89F95]">
              <p>
                In strict compliance with the <strong className="text-[#171613] dark:text-[#F5EFE3]">Nigeria Data Protection Act 2023 (NDPA)</strong> and privacy standards, Schoolbackdoor enforces ephemeral retention and permanent erasure rights.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 glass-subtle rounded-xl">
                <div className="flex flex-col gap-1">
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] font-mono text-[11px] uppercase">
                    72-Hour Ephemeral Lifecycle
                  </span>
                  <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                    All direct chat messages and standard unpinned posts automatically expire and are purged from database storage after 72 hours.
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="font-semibold text-[#171613] dark:text-[#F5EFE3] font-mono text-[11px] uppercase">
                    Zero Orphaned Artifacts
                  </span>
                  <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                    When you request erasure, all personal profile records, posts, comments, chat histories, likes, and media are scrubbed with cryptographic tombstones.
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                {onNavigateToTab && (
                  <GlassButton variant="glass" size="sm" onClick={() => onNavigateToTab('policies')}>
                    <FileText className="w-3.5 h-3.5" />
                    <span>View Complete Platform Policies &amp; Charters</span>
                  </GlassButton>
                )}

                {profile?.role === 'admin' && onNavigateToTab && (
                  <GlassButton variant="pink" size="sm" onClick={() => onNavigateToTab('admin')}>
                    <Shield className="w-3.5 h-3.5" />
                    <span>Open Admin Console</span>
                  </GlassButton>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px]">
                <span className="text-[#82796F] dark:text-[#A89F95] font-mono uppercase">Public Store &amp; Legal Links:</span>
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                  Privacy Policy
                </a>
                <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                  Terms of Service
                </a>
                <a href="/support" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                  Support Desk
                </a>
                <a href="/account-deletion" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                  Web Account Deletion
                </a>
              </div>
            </div>

            <div className="p-4 rounded-2xl border border-[#D98BA5] dark:border-[#D98BA5]/40 bg-[#F6E2E6]/65 dark:bg-[#D98BA5]/12 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
                <span className="font-serif font-bold text-sm text-[#171613] dark:text-[#F5EFE3]">
                  Permanent Account Deletion (Self-Service)
                </span>
              </div>

              <p className="text-xs text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                This action is irreversible. Enter your current password and type <code className="font-mono font-bold">PERMANENTLY_DELETE</code> to erase your profile, content, sessions, and place a SHA-256 deletion tombstone.
              </p>

              {deleteError && (
                <div className="p-2.5 rounded-xl bg-[#FFFCF7] dark:bg-[#23211C] border border-[#C4718E] text-[#171613] dark:text-[#F5EFE3] text-xs font-medium">
                  {deleteError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                <input
                  type="password"
                  autoComplete="current-password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="Current password"
                  className="px-3.5 py-2 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3] min-h-[42px]"
                />
                <input
                  type="text"
                  value={deleteConfirmationInput}
                  onChange={(e) => setDeleteConfirmationInput(e.target.value)}
                  placeholder="Type PERMANENTLY_DELETE"
                  className="px-3.5 py-2 rounded-xl glass-input text-xs font-mono text-[#171613] dark:text-[#F5EFE3] min-h-[42px]"
                />

                <GlassButton
                  variant="black"
                  size="sm"
                  disabled={deleteConfirmationInput.trim() !== 'PERMANENTLY_DELETE' || isDeletingAccount}
                  onClick={async () => {
                    if (deleteConfirmationInput.trim() !== 'PERMANENTLY_DELETE') return;
                    setIsDeletingAccount(true);
                    setDeleteError(null);
                    try {
                      await api.deleteAccountPermanently(
                        'User self-service deletion via Settings',
                        deletePassword.trim() || undefined
                      );
                      if (onLogout) onLogout();
                    } catch (e: any) {
                      setDeleteError(e.message || 'Failed to delete account.');
                      setIsDeletingAccount(false);
                    }
                  }}
                >
                  {isDeletingAccount ? 'Erasing Records...' : 'Permanently Delete'}
                </GlassButton>
              </div>
            </div>
          </GlassCard>
        )}

        {/* Account & Auth Footer Bar */}
        <GlassCard tone="subtle" padding="md" className="text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="font-bold text-[#171613] dark:text-[#F5EFE3]">
              {profile?.userId ? `Authenticated Session: ${profile.handle}` : 'Guest Preview Mode'}
            </span>
            <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
              {profile?.email ? `${profile.email} · ` : ''}100% Free Independent Social Network
            </span>
          </div>

          <div className="flex items-center gap-2">
            {onOpenAuth && (
              <GlassButton variant="glass" size="sm" onClick={() => onOpenAuth('login')}>
                {profile?.userId ? 'Switch Account' : 'Sign In'}
              </GlassButton>
            )}
            {onLogout && profile?.userId && (
              <GlassButton variant="black" size="sm" onClick={onLogout}>
                Sign Out
              </GlassButton>
            )}
          </div>
        </GlassCard>
      </div>

      <Suspense fallback={null}>
        {isAvatarModalOpen && profile?.userId && (
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
              if (updated && onProfileUpdated) {
                onProfileUpdated(updated);
              }
              triggerHaptic('success');
              showNotice('Profile picture updated.');
            }}
            onRemove={
              profile.avatarUrl
                ? async () => {
                    const updated = await api.updateProfile({ removeAvatar: true });
                    if (updated && onProfileUpdated) {
                      onProfileUpdated(updated);
                    }
                    triggerHaptic('success');
                    showNotice('Profile picture removed.');
                  }
                : undefined
            }
          />
        )}
      </Suspense>
    </div>
  );
};

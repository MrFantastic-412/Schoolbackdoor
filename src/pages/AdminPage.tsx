import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  CheckCircle2,
  CreditCard,
  Download,
  Edit3,
  Eye,
  EyeOff,
  Fingerprint,
  Flag,
  Globe,
  HardDrive,
  KeyRound,
  Laptop,
  Lock,
  Megaphone,
  MessageSquare,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Smartphone,
  Star,
  Tablet,
  TrendingUp,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  AdminAnalyticsReport,
  AdminAuditLog,
  AdminChatOverview,
  AdminCommunityRecord,
  AdminContentComment,
  AdminContentPost,
  AdminDashboardStats,
  AdminNotificationRecord,
  AdminReport,
  AdminSecurityOverview,
  AdminStorageOverview,
  AdminUserRecord,
  AdvertisementRecord,
  AnalyticsRange,
  AppealRecord,
  BackupSnapshot,
  DeviceSession,
  ModeratorAccount,
  ModeratorPermissions,
  PaymentRecordsResponse,
  PlatformConfig,
  PlatformFeature,
  SecurityEventRecord,
  StudentProfile,
} from '../types';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '../api/client';
import { GlassButton, GlassCard, GlassInput, GlassModal } from '../components/glass';
import { AdminDashboardSkeleton } from '../components/common/Skeletons';
import { CAMPUS_AREA_OPTIONS } from '../data/locationAreas';
import { useDebounce } from '../utils/useDebounce';
import { triggerHaptic } from '../utils/haptics';
import { formatPasskeyError, isPasskeySupported } from '../utils/webauthn';

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
  | 'settings';

type RequestedAdminSection =
  | AdminSection
  | 'content'
  | 'communities'
  | 'moderation'
  | 'performance'
  | 'security'
  | 'features';

interface AdminPageProps {
  profile: StudentProfile;
  onNavigateToTab?: (tab: any) => void;
  onConfigChanged?: (cfg: PlatformConfig) => void;
  latestReport?: AdminReport | null;
  requestedSection?: RequestedAdminSection | null;
  onClearRequestedSection?: () => void;
}

function normalizeSection(s?: RequestedAdminSection | null): AdminSection {
  switch (s) {
    case 'content':
    case 'communities':
    case 'posts':
      return 'posts';
    case 'moderation':
    case 'reports':
      return 'reports';
    case 'moderators':
      return 'moderators';
    case 'analytics':
      return 'analytics';
    case 'advertisements':
      return 'advertisements';
    case 'payments':
      return 'payments';
    case 'storage':
      return 'storage';
    case 'performance':
    case 'security':
    case 'features':
    case 'settings':
      return 'settings';
    default:
      return 'overview';
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNaira(amount: number): string {
  return `₦${Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export const AdminPage: React.FC<AdminPageProps> = ({
  profile,
  onNavigateToTab,
  onConfigChanged,
  latestReport,
  requestedSection,
  onClearRequestedSection,
}) => {
  const [section, setSection] = useState<AdminSection>(() => normalizeSection(requestedSection));
  const [isLoading, setIsLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Core Data States
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('all');
  const [userStatusFilter, setUserStatusFilter] = useState('all');

  const [posts, setPosts] = useState<AdminContentPost[]>([]);
  const [comments, setComments] = useState<AdminContentComment[]>([]);
  const [contentSearch, setContentSearch] = useState('');
  const [chats, setChats] = useState<AdminChatOverview[]>([]);
  const [notifications, setNotifications] = useState<AdminNotificationRecord[]>([]);
  const [communities, setCommunities] = useState<AdminCommunityRecord[]>([]);

  const [reports, setReports] = useState<AdminReport[]>([]);
  const [reportFilter, setReportFilter] = useState<'all' | 'pending' | 'escalated'>('all');
  const [appeals, setAppeals] = useState<AppealRecord[]>([]);
  const [moderators, setModerators] = useState<ModeratorAccount[]>([]);
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>('7d');
  const [analytics, setAnalytics] = useState<AdminAnalyticsReport | null>(null);
  const [advertisements, setAdvertisements] = useState<AdvertisementRecord[]>([]);
  const [paymentData, setPaymentData] = useState<PaymentRecordsResponse>({
    records: [],
    retainedArchives: [],
    summary: { totalRecords: 0, confirmedNaira: 0, pendingNaira: 0, retainedCount: 0 },
  });
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('all');
  const [paymentSearch, setPaymentSearch] = useState('');

  const [storage, setStorage] = useState<AdminStorageOverview | null>(null);
  const [backups, setBackups] = useState<BackupSnapshot[]>([]);
  const [security, setSecurity] = useState<AdminSecurityOverview | null>(null);
  const [adminSessions, setAdminSessions] = useState<DeviceSession[]>([]);
  const [securityEvents, setSecurityEvents] = useState<SecurityEventRecord[]>([]);
  const [securitySeverityFilter, setSecuritySeverityFilter] = useState<'all' | 'critical' | 'warning' | 'info'>('all');
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [features, setFeatures] = useState<PlatformFeature[]>([]);
  const [siteSettings, setSiteSettings] = useState<Record<string, string>>({});

  // Sub-tabs
  const [contentSubTab, setContentSubTab] = useState<
    'posts' | 'comments' | 'communities' | 'chats' | 'notifications'
  >(requestedSection === 'communities' ? 'communities' : 'posts');
  const [settingsSubTab, setSettingsSubTab] = useState<'website' | 'features' | 'security'>(
    requestedSection === 'features'
      ? 'features'
      : requestedSection === 'security' || requestedSection === 'performance'
      ? 'security'
      : 'website'
  );

  // Official Admin Post Composer & Editor
  const [adminPostForm, setAdminPostForm] = useState({
    content: '',
    areaKey: '',
    isAnnouncement: true,
    announcementUrgency: 'high' as 'normal' | 'high',
    isPinned: true,
    isFeatured: true,
    distributionScope: 'all' as 'feed' | 'nearby' | 'all',
  });
  const [isPublishingAdminPost, setIsPublishingAdminPost] = useState(false);
  const [editPostTarget, setEditPostTarget] = useState<AdminContentPost | null>(null);
  const [editPostForm, setEditPostForm] = useState({
    content: '',
    isPinned: false,
    isFeatured: false,
    isAnnouncement: false,
    distributionScope: 'feed' as 'feed' | 'nearby' | 'all',
  });

  // User Modals
  const [showCreateUserModal, setShowCreateUserModal] = useState(false);
  const [createUserForm, setCreateUserForm] = useState({
    name: '',
    username: '@',
    password: '',
    role: 'student' as 'student' | 'staff' | 'moderator',
    department: 'Computer Science',
    level: '200L',
    hallOfResidence: 'Off-Campus',
  });
  const [editUserTarget, setEditUserTarget] = useState<AdminUserRecord | null>(null);
  const [editUserForm, setEditUserForm] = useState({
    name: '',
    department: '',
    level: '',
    hallOfResidence: '',
    campus: 'Main Campus',
    bio: '',
    verified: true,
  });
  const [roleModalTarget, setRoleModalTarget] = useState<AdminUserRecord | null>(null);
  const [selectedNewRole, setSelectedNewRole] = useState<'student' | 'staff' | 'moderator'>('student');
  const [warningTarget, setWarningTarget] = useState<AdminUserRecord | null>(null);
  const [warningReason, setWarningReason] = useState('');
  const [warningSeverity, setWarningSeverity] = useState<'minor' | 'standard' | 'severe'>('standard');
  const [suspendTarget, setSuspendTarget] = useState<AdminUserRecord | null>(null);
  const [suspendDays, setSuspendDays] = useState(7);
  const [suspendReason, setSuspendReason] = useState('');
  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUserRecord | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Moderator Assign Modal
  const [showAssignModModal, setShowAssignModModal] = useState(false);
  const [assignModMode, setAssignModMode] = useState<'promote' | 'create'>('promote');
  const [assignModForm, setAssignModForm] = useState({
    userId: '',
    username: '@',
    password: '',
    name: '',
    department: 'Community Moderation',
    canReviewReports: true,
    canHideContent: true,
    canWarnUsers: true,
    canRestrictUsers: true,
    maxRestrictionHours: 72,
    canReviewCommunities: true,
    canEscalate: true,
  });

  // Advertisements Modals
  const [showAdModal, setShowAdModal] = useState(false);
  const [editAdTarget, setEditAdTarget] = useState<AdvertisementRecord | null>(null);
  const [adForm, setAdForm] = useState({
    title: '',
    sponsorName: '',
    body: '',
    targetUrl: '',
    placement: 'feed' as 'feed' | 'communities' | 'updates' | 'sidebar',
    targetArea: 'all',
    status: 'active' as 'draft' | 'active' | 'paused' | 'ended',
    budgetNaira: 15000,
  });

  // Payment Record Modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentForm, setPaymentForm] = useState({
    amountNaira: 10000,
    purpose: 'campus_trade_listing' as 'subscription' | 'campus_trade_listing' | 'ticket',
    channel: 'moniepoint',
    payerName: '',
    payerBankName: '',
    reference: '',
    note: '',
    status: 'confirmed' as 'pending' | 'awaiting_verification' | 'confirmed',
  });

  // Other Modals
  const [inspectChatTarget, setInspectChatTarget] = useState<AdminChatOverview | null>(null);
  const [inspectReason, setInspectReason] = useState('');
  const [inspectedMessages, setInspectedMessages] = useState<any[] | null>(null);
  const [broadcastForm, setBroadcastForm] = useState({ title: '', body: '', targetUserId: '' });
  const [editCommTarget, setEditCommTarget] = useState<AdminCommunityRecord | null>(null);
  const [editCommForm, setEditCommForm] = useState({ name: '', description: '', location: '', isVerified: false });
  const [appealTarget, setAppealTarget] = useState<AppealRecord | null>(null);
  const [appealDecision, setAppealDecision] = useState<'accepted' | 'rejected'>('accepted');
  const [appealNotes, setAppealNotes] = useState('');
  const [showCleanOrphansConfirm, setShowCleanOrphansConfirm] = useState(false);
  const [purgeSummary, setPurgeSummary] = useState<any | null>(null);
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; otpauthUri: string; sampleCurrentCode?: string } | null>(null);
  const [mfaVerifyCode, setMfaVerifyCode] = useState('');
  const [mfaDisablePassword, setMfaDisablePassword] = useState('');
  const [showAddFeatureModal, setShowAddFeatureModal] = useState(false);
  const [newFeatureForm, setNewFeatureForm] = useState({
    key: '',
    name: '',
    description: '',
    category: 'discovery' as 'core' | 'social' | 'discovery' | 'governance',
  });
  const [editingLimitsKey, setEditingLimitsKey] = useState<string | null>(null);
  const [editingLimitsJson, setEditingLimitsJson] = useState('{}');
  const [reauthPendingAction, setReauthPendingAction] = useState<{
    label: string;
    retry: () => Promise<void>;
  } | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [isReauthBusy, setIsReauthBusy] = useState(false);

  const isAdmin = profile.role === 'admin';

  const showFeedback = useCallback((msg: string, isErr = false) => {
    triggerHaptic(isErr ? 'error' : 'success');
    if (isErr) {
      setActionError(msg);
      setTimeout(() => setActionError(null), 4500);
    } else {
      setActionMessage(msg);
      setTimeout(() => setActionMessage(null), 4000);
    }
  }, []);

  const executeWithReauth = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err: any) {
        if (err?.code === 'REAUTH_REQUIRED') {
          setReauthPassword('');
          setReauthError(null);
          setReauthPendingAction({ label, retry: fn });
          return;
        }
        showFeedback(err?.message || 'Action failed.', true);
      }
    },
    [showFeedback]
  );

  const syncPublicConfig = useCallback(async () => {
    const cfg = await api.getPlatformConfig();
    if (cfg && onConfigChanged) onConfigChanged(cfg);
  }, [onConfigChanged]);

  const debouncedUserSearch = useDebounce(userSearch, 300);
  const debouncedContentSearch = useDebounce(contentSearch, 300);
  const debouncedPaymentSearch = useDebounce(paymentSearch, 300);

  const didInitialLoadRef = useRef(false);
  const filtersRef = useRef({
    userSearch: '',
    userRoleFilter: 'all',
    userStatusFilter: 'all',
    contentSearch: '',
    analyticsRange: '7d' as AnalyticsRange,
    paymentStatusFilter: 'all',
    paymentSearch: '',
  });
  filtersRef.current = {
    userSearch: debouncedUserSearch,
    userRoleFilter,
    userStatusFilter,
    contentSearch: debouncedContentSearch,
    analyticsRange,
    paymentStatusFilter,
    paymentSearch: debouncedPaymentSearch,
  };

  const loadAll = useCallback(async () => {
    if (!isAdmin) {
      setIsLoading(false);
      return;
    }
    const f = filtersRef.current;
    setIsLoading(true);
    try {
      const [
        statsRes,
        usersRes,
        contentRes,
        chatsRes,
        notifsRes,
        commsRes,
        reportsRes,
        appealsRes,
        modsRes,
        analyticsRes,
        adsRes,
        paymentsRes,
        storageRes,
        backupsRes,
        securityRes,
        auditRes,
        featuresRes,
        settingsRes,
      ] = await Promise.all([
        api.getAdminDashboard(),
        api.adminListUsers({ search: f.userSearch, role: f.userRoleFilter, status: f.userStatusFilter }),
        api.adminListContent(f.contentSearch),
        api.adminListChats(),
        api.adminListNotifications(),
        api.adminListCommunities(),
        api.getAdminReports(),
        api.getAppeals(),
        api.adminListModerators(),
        api.adminGetAnalytics(f.analyticsRange),
        api.adminListAdvertisements(),
        api.adminListPaymentRecords({
          status: f.paymentStatusFilter === 'all' ? undefined : f.paymentStatusFilter,
          search: f.paymentSearch,
        }),
        api.adminGetStorageOverview(),
        api.getBackups(),
        api.adminGetSecurityOverview(),
        api.getAdminAuditLogs(),
        api.adminListFeatures(),
        api.adminGetWebsiteSettings(),
      ]);

      if (statsRes) setStats(statsRes);
      setUsers(usersRes);
      setPosts(contentRes.posts);
      setComments(contentRes.comments);
      setChats(chatsRes);
      setNotifications(notifsRes);
      setCommunities(commsRes);
      setReports(reportsRes);
      setAppeals(appealsRes);
      setModerators(modsRes);
      if (analyticsRes) setAnalytics(analyticsRes);
      setAdvertisements(adsRes);
      setPaymentData(paymentsRes);
      if (storageRes) setStorage(storageRes);
      setBackups(backupsRes);
      if (securityRes) {
        setSecurity(securityRes);
        setAdminSessions(securityRes.activeSessions || []);
        setSecurityEvents(securityRes.securityEvents || []);
      }
      setAuditLogs(auditRes);
      setFeatures(featuresRes);
      setSiteSettings(settingsRes);
      didInitialLoadRef.current = true;
    } catch (err: any) {
      showFeedback(err.message || 'Failed to load administrative records.', true);
    } finally {
      setIsLoading(false);
    }
  }, [isAdmin, showFeedback]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (requestedSection) {
      setSection(normalizeSection(requestedSection));
      if (requestedSection === 'communities') setContentSubTab('communities');
      if (requestedSection === 'features') setSettingsSubTab('features');
      if (requestedSection === 'security' || requestedSection === 'performance') setSettingsSubTab('security');
      onClearRequestedSection?.();
    }
  }, [onClearRequestedSection, requestedSection]);

  useEffect(() => {
    if (!latestReport || !isAdmin) return;
    setReports((prev) => {
      if (prev.some((r) => r.id === latestReport.id)) return prev;
      return [latestReport, ...prev];
    });
  }, [isAdmin, latestReport]);

  useEffect(() => {
    if (!isAdmin || !didInitialLoadRef.current) return;
    let active = true;
    api
      .adminListUsers({ search: debouncedUserSearch, role: userRoleFilter, status: userStatusFilter })
      .then((res) => {
        if (active) setUsers(res);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isAdmin, debouncedUserSearch, userRoleFilter, userStatusFilter]);

  useEffect(() => {
    if (!isAdmin || !didInitialLoadRef.current) return;
    let active = true;
    api
      .adminListContent(debouncedContentSearch)
      .then((res) => {
        if (active) {
          setPosts(res.posts);
          setComments(res.comments);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isAdmin, debouncedContentSearch]);

  useEffect(() => {
    if (!isAdmin || !didInitialLoadRef.current) return;
    let active = true;
    api.adminGetAnalytics(analyticsRange).then((res) => {
      if (active && res) setAnalytics(res);
    });
    return () => {
      active = false;
    };
  }, [isAdmin, analyticsRange]);

  useEffect(() => {
    if (!isAdmin || !didInitialLoadRef.current) return;
    let active = true;
    api
      .adminListPaymentRecords({
        status: paymentStatusFilter === 'all' ? undefined : paymentStatusFilter,
        search: debouncedPaymentSearch,
      })
      .then((res) => {
        if (active) setPaymentData(res);
      });
    return () => {
      active = false;
    };
  }, [isAdmin, paymentStatusFilter, debouncedPaymentSearch]);

  if (!isAdmin) {
    return (
      <div className="max-w-xl mx-auto my-12 px-4">
        <GlassCard tone="strong" padding="lg" className="text-center">
          <div className="w-12 h-12 rounded-2xl bg-[#F6E2E6] dark:bg-[#4A2532]/75 border border-[#D98BA5]/40 flex items-center justify-center mx-auto mb-3">
            <ShieldAlert className="w-6 h-6 text-[#C4718E] dark:text-[#E5A4BA]" />
          </div>
          <h2 className="font-serif text-xl font-bold text-[#171613] dark:text-[#F5EFE3]">
            Admin Role Required
          </h2>
          <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-2 leading-relaxed">
            The Schoolbackdoor Admin Dashboard is strictly restricted to the authorized THEBACKDOOR Admin account. Moderators and students cannot access full Admin analytics, settings, or financial records.
          </p>
          {onNavigateToTab && (
            <GlassButton
              variant="black"
              size="sm"
              onClick={() => onNavigateToTab(profile.role === 'moderator' ? 'mod' : 'home')}
              className="mt-5"
            >
              {profile.role === 'moderator' ? 'Open Moderator Desk' : 'Return to Feed'}
            </GlassButton>
          )}
        </GlassCard>
      </div>
    );
  }

  const pendingReportsCount = reports.filter((r) => r.status === 'pending').length;
  const escalatedReportsCount = reports.filter((r) => Boolean(r.escalated_to_admin)).length;
  const pendingAppealsCount = appeals.filter((a) => a.status === 'pending').length;

  const navTabs: { id: AdminSection; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'overview', label: 'Overview', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'users', label: 'Users', icon: <Users className="w-3.5 h-3.5" /> },
    { id: 'posts', label: 'Posts & Communities', icon: <Megaphone className="w-3.5 h-3.5" /> },
    {
      id: 'reports',
      label: 'Reports & Appeals',
      icon: <Scale className="w-3.5 h-3.5" />,
      badge: pendingReportsCount + pendingAppealsCount,
    },
    { id: 'moderators', label: 'Moderators', icon: <UserCheck className="w-3.5 h-3.5" /> },
    { id: 'analytics', label: 'Analytics', icon: <BarChart3 className="w-3.5 h-3.5" /> },
    { id: 'advertisements', label: 'Advertisements', icon: <TrendingUp className="w-3.5 h-3.5" /> },
    { id: 'payments', label: 'Payments', icon: <CreditCard className="w-3.5 h-3.5" /> },
    { id: 'storage', label: 'Storage & Backups', icon: <HardDrive className="w-3.5 h-3.5" /> },
    { id: 'settings', label: 'Settings & Security', icon: <Globe className="w-3.5 h-3.5" /> },
  ];

  // Action Handlers
  const handlePublishAdminPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminPostForm.content.trim()) return;
    setIsPublishingAdminPost(true);
    try {
      const selectedArea = CAMPUS_AREA_OPTIONS.find((a) => a.key === adminPostForm.areaKey);
      await api.adminCreatePost({
        content: adminPostForm.content.trim(),
        areaKey: adminPostForm.areaKey || undefined,
        areaLabel: selectedArea?.label || undefined,
        isAnnouncement: adminPostForm.isAnnouncement,
        announcementUrgency: adminPostForm.announcementUrgency,
        isPinned: adminPostForm.isPinned,
        isFeatured: adminPostForm.isFeatured,
        distributionScope: adminPostForm.distributionScope,
      });
      showFeedback('Official Admin post published across selected feeds.');
      setAdminPostForm({
        content: '',
        areaKey: '',
        isAnnouncement: true,
        announcementUrgency: 'high',
        isPinned: true,
        isFeatured: true,
        distributionScope: 'all',
      });
      await loadAll();
    } catch (err: any) {
      showFeedback(err?.message || 'Failed to publish Admin post.', true);
    } finally {
      setIsPublishingAdminPost(false);
    }
  };

  const handleSaveEditedPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editPostTarget) return;
    try {
      await api.adminUpdatePost(editPostTarget.id, editPostForm);
      showFeedback('Updated post settings & copy.');
      setEditPostTarget(null);
      await loadAll();
    } catch (err: any) {
      showFeedback(err?.message || 'Failed to update post.', true);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.adminCreateUser(createUserForm);
      showFeedback(`Account ${createUserForm.username} created (${createUserForm.role}).`);
      setShowCreateUserModal(false);
      setCreateUserForm({
        name: '',
        username: '@',
        password: '',
        role: 'student',
        department: 'Computer Science',
        level: '200L',
        hallOfResidence: 'Off-Campus',
      });
      await loadAll();
    } catch (err: any) {
      showFeedback(err.message, true);
    }
  };

  const handleSaveUserEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUserTarget) return;
    try {
      await api.adminUpdateUserProfile(editUserTarget.id, editUserForm);
      showFeedback(`Updated dossier for ${editUserTarget.name}.`);
      setEditUserTarget(null);
      await loadAll();
    } catch (err: any) {
      showFeedback(err.message, true);
    }
  };

  const handleAssignRole = async () => {
    if (!roleModalTarget) return;
    const target = roleModalTarget;
    const nextRole = selectedNewRole;
    await executeWithReauth(`Assign role ${nextRole.toUpperCase()} to ${target.handle}`, async () => {
      await api.assignStaffRole(target.id, nextRole);
      showFeedback(`Updated ${target.name} role to ${nextRole.toUpperCase()}.`);
      setRoleModalTarget(null);
      await loadAll();
    });
  };

  const handleIssueWarning = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!warningTarget) return;
    try {
      await api.warnUser(warningTarget.id, warningReason, warningSeverity);
      showFeedback(`Warning notice sent to ${warningTarget.handle}.`);
      setWarningTarget(null);
      setWarningReason('');
      await loadAll();
    } catch (err: any) {
      showFeedback(err.message, true);
    }
  };

  const handleSuspendUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suspendTarget) return;
    try {
      await api.suspendUser(suspendTarget.id, suspendDays, suspendReason || 'Platform policy violation');
      showFeedback(`Suspended ${suspendTarget.handle} for ${suspendDays} days.`);
      setSuspendTarget(null);
      setSuspendReason('');
      await loadAll();
    } catch (err: any) {
      showFeedback(err.message, true);
    }
  };

  const handleDeleteUserPermanently = async () => {
    if (!deleteUserTarget || deleteConfirmText !== 'PERMANENTLY_DELETE') return;
    const target = deleteUserTarget;
    await executeWithReauth(`Permanently erase ${target.handle}`, async () => {
      await api.adminDeleteUserPermanently(target.id, 'Removed via Admin Console');
      showFeedback(`Permanently erased ${target.handle} with SHA-256 tombstone.`);
      setDeleteUserTarget(null);
      setDeleteConfirmText('');
      await loadAll();
    });
  };

  const handleAssignModeratorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload =
      assignModMode === 'promote'
        ? {
            userId: assignModForm.userId,
            permissions: {
              canReviewReports: assignModForm.canReviewReports,
              canHideContent: assignModForm.canHideContent,
              canWarnUsers: assignModForm.canWarnUsers,
              canRestrictUsers: assignModForm.canRestrictUsers,
              maxRestrictionHours: assignModForm.maxRestrictionHours,
              canReviewCommunities: assignModForm.canReviewCommunities,
              canEscalate: assignModForm.canEscalate,
            },
          }
        : {
            username: assignModForm.username,
            password: assignModForm.password,
            name: assignModForm.name,
            department: assignModForm.department,
            permissions: {
              canReviewReports: assignModForm.canReviewReports,
              canHideContent: assignModForm.canHideContent,
              canWarnUsers: assignModForm.canWarnUsers,
              canRestrictUsers: assignModForm.canRestrictUsers,
              maxRestrictionHours: assignModForm.maxRestrictionHours,
              canReviewCommunities: assignModForm.canReviewCommunities,
              canEscalate: assignModForm.canEscalate,
            },
          };

    await executeWithReauth('Assign Moderator privileges', async () => {
      await api.adminAssignModerator(payload);
      showFeedback('Moderator account assigned with scoped permissions.');
      setShowAssignModModal(false);
      await loadAll();
    });
  };

  const handleSaveAd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editAdTarget) {
        await api.adminUpdateAdvertisement(editAdTarget.id, adForm);
        showFeedback(`Updated campaign "${adForm.title}".`);
      } else {
        await api.adminCreateAdvertisement(adForm);
        showFeedback(`Published campaign "${adForm.title}".`);
      }
      setShowAdModal(false);
      setEditAdTarget(null);
      await loadAll();
    } catch (err: any) {
      showFeedback(err?.message || 'Failed to save advertisement.', true);
    }
  };

  const handleCreatePaymentRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.adminCreatePaymentRecord(paymentForm);
      showFeedback('Payment record appended to ledger.');
      setShowPaymentModal(false);
      await loadAll();
    } catch (err: any) {
      showFeedback(err?.message || 'Failed to record payment.', true);
    }
  };

  const handleBroadcastNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.adminBroadcastNotification({
        title: broadcastForm.title,
        body: broadcastForm.body,
        targetUserId: broadcastForm.targetUserId.trim() || undefined,
      });
      showFeedback(`Broadcast delivered to ${res.deliveredCount} account(s).`);
      setBroadcastForm({ title: '', body: '', targetUserId: '' });
      await loadAll();
    } catch (err: any) {
      showFeedback(err.message, true);
    }
  };

  const handleInspectChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectChatTarget) return;
    try {
      const res = await api.adminInspectChat(inspectChatTarget.id, inspectReason);
      setInspectedMessages(res.messages || []);
      showFeedback('Chat inspection logged to immutable audit trail.');
      await loadAll();
    } catch (err: any) {
      showFeedback(err.message, true);
    }
  };

  const handleDownloadStorageReport = async () => {
    try {
      const report = await api.adminDownloadStorageReport();
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `schoolbackdoor-storage-report-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showFeedback('Storage utilization report downloaded.');
    } catch (err: any) {
      showFeedback(err.message, true);
    }
  };

  const promotableUsers = users.filter((u) => u.role === 'student' || u.role === 'staff');

  return (
    <div className="w-full max-w-6xl mx-auto px-3 sm:px-5 py-6">
      {/* Header */}
      <GlassCard tone="cream" padding="md" className="mb-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
              <ShieldCheck className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA]" />
              <span>THEBACKDOOR Admin Control · Analytics &amp; Governance</span>
            </div>
            <h1 className="font-serif text-2xl sm:text-3xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
              Admin Dashboard
            </h1>
            <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
              Authenticated as <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{profile.name}</span> ({profile.handle}) · Real-time SQLite telemetry
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <GlassButton variant="glass" size="sm" onClick={() => setSection('analytics')}>
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Analytics</span>
            </GlassButton>
            <GlassButton variant="pink" size="sm" onClick={loadAll} disabled={isLoading}>
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </GlassButton>
          </div>
        </div>
      </GlassCard>

      {/* Feedback Banners */}
      {actionMessage && (
        <div className="mb-4 p-3.5 rounded-2xl glass-pink-tint border border-[#D98BA5]/50 text-[#171613] dark:text-[#F5EFE3] text-xs flex items-center justify-between gap-2 animate-sb-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
            <span className="font-medium">{actionMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionMessage(null)}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[#171613]/10 dark:hover:bg-white/10 cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {actionError && (
        <div className="mb-4 p-3.5 rounded-2xl glass-dark text-[#F5EFE3] text-xs flex items-center justify-between gap-2 animate-sb-in">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[#D98BA5] shrink-0" />
            <span>{actionError}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[#FFFCF7]/10 cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Pending / Escalated Reports Alert */}
      {(pendingReportsCount > 0 || escalatedReportsCount > 0) && section !== 'reports' && (
        <div className="mb-4 p-3.5 rounded-2xl bg-[#F6E2E6]/90 dark:bg-[#4A2532]/65 border border-[#C4718E]/60 text-[#171613] dark:text-[#F5EFE3] text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-sb-in">
          <div className="flex items-center gap-2.5">
            <Flag className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
            <span>
              <strong className="tabular-nums">{pendingReportsCount}</strong> pending report(s)
              {escalatedReportsCount > 0 && (
                <span>
                  {' '}
                  · <strong className="tabular-nums">{escalatedReportsCount}</strong> escalated by Moderators
                </span>
              )}
            </span>
          </div>
          <GlassButton variant="pink" size="sm" onClick={() => setSection('reports')} className="shrink-0">
            Review Queue
          </GlassButton>
        </div>
      )}

      {/* 10 Focused Navigation Tabs */}
      <div className="flex overflow-x-auto sm:flex-wrap gap-1.5 pb-3 mb-6 border-b border-[#171613]/10 dark:border-white/10 scrollbar-none">
        {navTabs.map((t) => {
          const active = section === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                setSection(t.id);
              }}
              className={`px-3.5 py-2 min-h-[38px] rounded-xl text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-all border ${
                active
                  ? 'glass-pink text-[#171613] border-[#D98BA5]/60 font-semibold shadow-sm'
                  : 'glass-subtle text-[#82796F] dark:text-[#A89F95] border-[#171613]/10 dark:border-white/10 hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#FFFCF7]/80 dark:hover:bg-white/10'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
              {t.badge !== undefined && t.badge > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono tabular-nums font-bold ${
                    active
                      ? 'bg-[#171613] text-[#F5EFE3]'
                      : 'bg-[#F6E2E6] dark:bg-[#4A2532] text-[#171613] dark:text-[#F5EFE3] border border-[#D98BA5]/40'
                  }`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ================================================================= */}
      {/* 1. OVERVIEW */}
      {/* ================================================================= */}
      {section === 'overview' && isLoading && !stats && <AdminDashboardSkeleton />}

      {section === 'overview' &&
        stats &&
        (() => {
          const userReachSeries = [
            { label: 'Online', value: stats.users.onlineTotal ?? 0 },
            { label: 'DAU', value: stats.users.dau ?? 0 },
            { label: 'WAU', value: stats.users.wau ?? 0 },
            { label: 'MAU', value: stats.users.mau ?? 0 },
            { label: 'Total', value: stats.users.total ?? 0 },
          ];
          const activitySeries = [
            { label: 'Online', value: stats.content.messages24h ?? 0 },
            { label: 'DAU', value: stats.content.comments24h ?? 0 },
            { label: 'WAU', value: stats.content.posts24h ?? 0 },
            { label: 'MAU', value: stats.content.comments ?? 0 },
            { label: 'Total', value: stats.content.posts ?? 0 },
          ];
          const chartMax = Math.max(
            1,
            ...userReachSeries.map((p) => p.value),
            ...activitySeries.map((p) => p.value)
          );
          const chartW = 460;
          const chartH = 160;
          const padX = 28;
          const padY = 18;
          const mapPoints = (series: { label: string; value: number }[]) =>
            series.map((pt, idx) => {
              const x = padX + (idx * (chartW - padX * 2)) / (series.length - 1);
              const y = chartH - padY - (pt.value / chartMax) * (chartH - padY * 2);
              return { x, y, ...pt };
            });
          const uPts = mapPoints(userReachSeries);
          const aPts = mapPoints(activitySeries);
          const toPolyline = (pts: { x: number; y: number }[]) =>
            pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          const toArea = (pts: { x: number; y: number }[]) =>
            `${pts[0].x.toFixed(1)},${(chartH - padY).toFixed(1)} ${toPolyline(pts)} ${pts[pts.length - 1].x.toFixed(1)},${(chartH - padY).toFixed(1)}`;

          const storagePct = storage ? Math.min(100, Math.max(0, storage.usagePercent)) : 0;
          const ringRadius = 46;
          const ringCircumference = 2 * Math.PI * ringRadius;
          const ringDashOffset = ringCircumference * (1 - Math.max(storagePct, 1) / 100);

          return (
            <div className="space-y-5">
              {siteSettings.maintenance_mode === 'true' && (
                <GlassCard tone="pink" padding="md" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-xs text-[#171613]">Global Maintenance Mode is Currently ON</div>
                    <p className="text-xs text-[#171613]/75 mt-0.5">{siteSettings.maintenance_message}</p>
                  </div>
                  <GlassButton variant="black" size="sm" onClick={() => setSection('settings')} className="shrink-0">
                    Manage Settings
                  </GlassButton>
                </GlassCard>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                <GlassCard tone="cream" padding="md" className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/75 border border-[#D98BA5]/50 flex items-center justify-center shrink-0">
                    <Users className="w-5 h-5 text-[#C4718E] dark:text-[#E5A4BA]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">Total Users</div>
                    <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] tabular-nums leading-tight">
                      {stats.users.total.toLocaleString()}
                    </div>
                    <div className="text-[11px] text-[#C4718E] dark:text-[#E5A4BA] font-medium tabular-nums truncate">
                      {stats.users.onlineTotal ?? 0} online · DAU {stats.users.dau ?? 0}
                    </div>
                  </div>
                </GlassCard>

                <GlassCard tone="cream" padding="md" className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/75 border border-[#D98BA5]/50 flex items-center justify-center shrink-0">
                    <MessageSquare className="w-5 h-5 text-[#C4718E] dark:text-[#E5A4BA]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">Total Posts</div>
                    <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] tabular-nums leading-tight">
                      {stats.content.posts.toLocaleString()}
                    </div>
                    <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] tabular-nums truncate">
                      +{stats.content.posts24h ?? 0} in 24h · {stats.content.comments} replies
                    </div>
                  </div>
                </GlassCard>

                <GlassCard tone="cream" padding="md" className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/75 border border-[#D98BA5]/50 flex items-center justify-center shrink-0">
                    <UserCheck className="w-5 h-5 text-[#C4718E] dark:text-[#E5A4BA]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">Moderators &amp; Groups</div>
                    <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] tabular-nums leading-tight">
                      {moderators.length} mod{moderators.length === 1 ? '' : 's'}
                    </div>
                    <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] tabular-nums truncate">
                      {stats.content.communities} communities · {stats.content.messages.toLocaleString()} msgs
                    </div>
                  </div>
                </GlassCard>

                <GlassCard tone="cream" padding="md" className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/75 border border-[#D98BA5]/50 flex items-center justify-center shrink-0">
                    <HardDrive className="w-5 h-5 text-[#C4718E] dark:text-[#E5A4BA]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">Storage Used</div>
                    <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] tabular-nums leading-tight">
                      {storage ? formatBytes(storage.totalUsedBytes) : stats.storage.totalFormatted}
                    </div>
                    <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] tabular-nums truncate">
                      {storage ? `${storage.usagePercent}% of ${storage.quotaGb} GB` : 'SQLite WAL Active'}
                    </div>
                  </div>
                </GlassCard>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <GlassCard tone="cream" padding="md" className="lg:col-span-8 flex flex-col justify-between gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                        Platform Telemetry
                      </h2>
                      <p className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                        Verified SQLite user reach vs. platform activity volume
                      </p>
                    </div>
                    <div className="flex items-center gap-4 text-[11px] font-medium text-[#171613] dark:text-[#F5EFE3]">
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-1 rounded-sm bg-[#171613] dark:bg-[#F5EFE3]" />
                        Users
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-1 rounded-sm bg-[#D98BA5]" />
                        Activity
                      </span>
                    </div>
                  </div>

                  <div className="w-full overflow-x-auto text-[#171613] dark:text-[#F5EFE3]">
                    <svg viewBox={`0 0 ${chartW} ${chartH + 22}`} className="w-full h-44 min-w-[340px]">
                      <defs>
                        <linearGradient id="sbPinkArea" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#D98BA5" stopOpacity="0.32" />
                          <stop offset="100%" stopColor="#D98BA5" stopOpacity="0.02" />
                        </linearGradient>
                      </defs>
                      {[0.25, 0.5, 0.75, 1].map((ratio) => {
                        const y = chartH - padY - ratio * (chartH - padY * 2);
                        return (
                          <line
                            key={ratio}
                            x1={padX}
                            y1={y}
                            x2={chartW - padX}
                            y2={y}
                            stroke="currentColor"
                            strokeOpacity="0.1"
                            strokeDasharray="3 4"
                          />
                        );
                      })}
                      <polygon points={toArea(aPts)} fill="url(#sbPinkArea)" />
                      <polyline fill="none" stroke="#D98BA5" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" points={toPolyline(aPts)} />
                      <polyline fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" points={toPolyline(uPts)} />
                      {uPts.map((pt) => (
                        <g key={`u-${pt.label}`}>
                          <circle cx={pt.x} cy={pt.y} r="3.6" fill="currentColor" stroke="var(--sb-cream)" strokeWidth="1.5" />
                          <text x={pt.x} y={chartH + 14} textAnchor="middle" fontSize="10" fill="var(--sb-muted)" fontFamily="ui-monospace, monospace">
                            {pt.label}
                          </text>
                        </g>
                      ))}
                      {aPts.map((pt) => (
                        <circle key={`a-${pt.label}`} cx={pt.x} cy={pt.y} r="3.6" fill="#C4718E" stroke="var(--sb-cream)" strokeWidth="1.5" />
                      ))}
                    </svg>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-[#171613]/8 dark:border-white/10 text-[11px]">
                    <div className="flex flex-col">
                      <span className="text-[#82796F] dark:text-[#A89F95]">7d Retention</span>
                      <span className="font-mono font-semibold text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                        {analytics?.users.retention7dRate ?? 0}%
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#82796F] dark:text-[#A89F95]">Ad Campaigns (CTR)</span>
                      <span className="font-mono font-semibold text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                        {analytics?.advertisements.activeCampaigns ?? 0} active · {analytics?.advertisements.ctrPercent ?? 0}%
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#82796F] dark:text-[#A89F95]">SQLite Latency</span>
                      <span className="font-mono font-semibold text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                        {stats.system.dbLatencyMs ?? 0} ms
                      </span>
                    </div>
                  </div>
                </GlassCard>

                <GlassCard tone="cream" padding="md" className="lg:col-span-4 flex flex-col items-center justify-between text-center gap-3">
                  <div className="w-full text-left">
                    <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">Storage Quota</h2>
                    <p className="text-[11px] text-[#82796F] dark:text-[#A89F95]">10 GB application allocation</p>
                  </div>
                  <div className="relative w-32 h-32 flex items-center justify-center my-1">
                    <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                      <circle cx="60" cy="60" r={ringRadius} fill="none" className="stroke-[#E8DDCC] dark:stroke-[#2A2722]" strokeOpacity="0.65" strokeWidth="12" />
                      <circle cx="60" cy="60" r={ringRadius} fill="none" stroke="#D98BA5" strokeWidth="12" strokeLinecap="round" strokeDasharray={ringCircumference} strokeDashoffset={ringDashOffset} />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="font-serif font-bold text-2xl text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                        {storagePct.toFixed(storagePct > 0 && storagePct < 1 ? 1 : 0)}%
                      </span>
                    </div>
                  </div>
                  <div className="text-xs font-mono font-bold text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    {storage ? formatBytes(storage.totalUsedBytes) : stats.storage.totalFormatted} / {storage?.quotaGb ?? 10} GB
                  </div>
                  <GlassButton variant="pink" size="sm" onClick={() => setSection('storage')} className="w-full">
                    Manage Storage &amp; Backups
                  </GlassButton>
                </GlassCard>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <GlassCard tone="cream" padding="md" className="space-y-2 text-xs">
                  <div className="font-serif font-bold text-sm text-[#171613] dark:text-[#F5EFE3]">Moderation &amp; Safety Queue</div>
                  <div className="flex justify-between text-[#82796F] dark:text-[#A89F95]">
                    <span>Pending / Escalated Reports</span>
                    <span className="font-mono font-semibold text-[#C4718E] dark:text-[#E5A4BA] tabular-nums">
                      {pendingReportsCount} / {escalatedReportsCount}
                    </span>
                  </div>
                  <div className="flex justify-between text-[#82796F] dark:text-[#A89F95]">
                    <span>Pending Appeals</span>
                    <span className="font-mono font-semibold text-[#C4718E] dark:text-[#E5A4BA] tabular-nums">{pendingAppealsCount}</span>
                  </div>
                  <div className="flex justify-between text-[#82796F] dark:text-[#A89F95]">
                    <span>Suspended / Restricted Accounts</span>
                    <span className="font-mono font-semibold text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                      {stats.users.suspended} / {analytics?.users.restrictedUsers ?? 0}
                    </span>
                  </div>
                </GlassCard>

                <GlassCard tone="cream" padding="md" className="space-y-2.5 text-xs">
                  <div className="font-serif font-bold text-sm text-[#171613] dark:text-[#F5EFE3]">Quick Admin Controls</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setSection('posts')}
                      className="p-2.5 rounded-xl border border-[#171613]/10 dark:border-white/10 bg-[#FFFCF7]/80 dark:bg-white/5 hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/20 text-left font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                    >
                      Publish Official Notice
                    </button>
                    <button
                      type="button"
                      onClick={() => setSection('moderators')}
                      className="p-2.5 rounded-xl border border-[#171613]/10 dark:border-white/10 bg-[#FFFCF7]/80 dark:bg-white/5 hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/20 text-left font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                    >
                      Moderators ({moderators.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSection('analytics')}
                      className="p-2.5 rounded-xl border border-[#171613]/10 dark:border-white/10 bg-[#FFFCF7]/80 dark:bg-white/5 hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/20 text-left font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                    >
                      Full Analytics &amp; CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => setSection('advertisements')}
                      className="p-2.5 rounded-xl border border-[#171613]/10 dark:border-white/10 bg-[#FFFCF7]/80 dark:bg-white/5 hover:bg-[#F6E2E6]/60 dark:hover:bg-[#D98BA5]/20 text-left font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                    >
                      Ad Campaigns ({advertisements.length})
                    </button>
                  </div>
                </GlassCard>
              </div>
            </div>
          );
        })()}

      {/* ================================================================= */}
      {/* 2. USERS */}
      {/* ================================================================= */}
      {section === 'users' && (
        <div className="space-y-4">
          <GlassCard tone="cream" padding="sm" className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95] absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search name, @handle, ID..."
                  className="w-full pl-8 pr-3 py-2 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3]"
                />
              </div>
              <select
                value={userRoleFilter}
                onChange={(e) => setUserRoleFilter(e.target.value)}
                className="px-3 py-2 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3]"
              >
                <option value="all">All Roles</option>
                <option value="admin">Admin</option>
                <option value="moderator">Moderator</option>
                <option value="staff">Staff</option>
                <option value="student">Student</option>
              </select>
              <select
                value={userStatusFilter}
                onChange={(e) => setUserStatusFilter(e.target.value)}
                className="px-3 py-2 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3]"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </select>
            </div>
            <GlassButton variant="pink" size="sm" onClick={() => setShowCreateUserModal(true)} className="shrink-0">
              <UserPlus className="w-3.5 h-3.5" />
              <span>Create Account</span>
            </GlassButton>
          </GlassCard>

          <GlassCard tone="cream" padding="none" className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase">
                  <th className="p-3">Account</th>
                  <th className="p-3">Academic Zone</th>
                  <th className="p-3">Role</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Controls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8">
                {users.map((u) => {
                  const isRestricted = Boolean(u.restrictedUntil && new Date(u.restrictedUntil).getTime() > Date.now());
                  return (
                    <tr key={u.id} className="hover:bg-[#FFFCF7]/65 dark:hover:bg-white/5 transition-colors">
                      <td className="p-3">
                        <div className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{u.name}</div>
                        <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono">
                          {u.handle}
                        </div>
                        <div className="text-[10px] text-[#82796F] dark:text-[#A89F95] font-mono tabular-nums">
                          {u.matricNumber}
                          {u.warningsCount ? ` · ${u.warningsCount} warning(s)` : ''}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="text-[#171613] dark:text-[#F5EFE3]">{u.department}</div>
                        <div className="text-[11px] text-[#82796F] dark:text-[#A89F95]">{u.level} · {u.campus}</div>
                      </td>
                      <td className="p-3 font-mono text-[11px] uppercase text-[#171613] dark:text-[#F5EFE3]">{u.role}</td>
                      <td className="p-3">
                        <span className="font-mono text-[11px] uppercase text-[#171613] dark:text-[#F5EFE3]">
                          {u.status}
                          {isRestricted && ' · Restricted'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditUserTarget(u);
                              setEditUserForm({
                                name: u.name,
                                department: u.department,
                                level: u.level,
                                hallOfResidence: u.hallOfResidence,
                                campus: u.campus,
                                bio: u.bio,
                                verified: u.isVerified,
                              });
                            }}
                            className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 bg-[#FFFCF7]/75 dark:bg-white/8 text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                          >
                            Edit
                          </button>
                          {u.role !== 'admin' && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setRoleModalTarget(u);
                                  setSelectedNewRole(u.role === 'moderator' ? 'moderator' : u.role === 'staff' ? 'staff' : 'student');
                                }}
                                className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 bg-[#FFFCF7]/75 dark:bg-white/8 text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                              >
                                Role
                              </button>
                              <button
                                type="button"
                                onClick={() => setWarningTarget(u)}
                                className="px-2.5 py-1 rounded-lg border border-[#D98BA5]/50 bg-[#F6E2E6]/75 dark:bg-[#4A2532]/65 text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                              >
                                Warn
                              </button>
                              {isRestricted && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await api.adminLiftUserRestriction(u.id, 'Restriction lifted by Admin');
                                      showFeedback(`Lifted restriction on ${u.handle}.`);
                                      await loadAll();
                                    } catch (err: any) {
                                      showFeedback(err.message, true);
                                    }
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] font-medium cursor-pointer"
                                >
                                  Lift Restrict
                                </button>
                              )}
                              {u.status === 'suspended' ? (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await api.unsuspendUser(u.id, 'Restored by Admin');
                                      showFeedback(`Restored ${u.handle}.`);
                                      await loadAll();
                                    } catch (err: any) {
                                      showFeedback(err.message, true);
                                    }
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] font-medium cursor-pointer"
                                >
                                  Restore
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setSuspendTarget(u)}
                                  className="px-2.5 py-1 rounded-lg border border-[#171613]/20 dark:border-white/15 bg-[#E8DDCC]/80 dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                                >
                                  Suspend
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setDeleteUserTarget(u);
                                  setDeleteConfirmText('');
                                }}
                                className="px-2.5 py-1 rounded-lg bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] cursor-pointer"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </GlassCard>
        </div>
      )}

      {/* ================================================================= */}
      {/* 3. POSTS, ANNOUNCEMENTS, COMMUNITIES, CHATS & NOTIFICATIONS */}
      {/* ================================================================= */}
      {section === 'posts' && (
        <div className="space-y-4">
          <GlassCard tone="cream" padding="sm" className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {[
                { id: 'posts', label: `Posts (${posts.length})` },
                { id: 'comments', label: `Comments (${comments.length})` },
                { id: 'communities', label: `Communities (${communities.length})` },
                { id: 'chats', label: `Chats (${chats.length})` },
                { id: 'notifications', label: `Notifications (${notifications.length})` },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setContentSubTab(t.id as any)}
                  className={`px-3 py-1.5 min-h-[34px] rounded-xl text-xs font-medium cursor-pointer whitespace-nowrap ${
                    contentSubTab === t.id
                      ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613]'
                      : 'bg-[#E8DDCC]/70 dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {(contentSubTab === 'posts' || contentSubTab === 'comments') && (
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95] absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={contentSearch}
                  onChange={(e) => setContentSearch(e.target.value)}
                  placeholder="Filter content or @author..."
                  className="w-full pl-8 pr-3 py-2 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3]"
                />
              </div>
            )}
          </GlassCard>

          {contentSubTab === 'posts' && (
            <div className="space-y-4">
              {/* Official Admin Post & Announcement Composer */}
              <GlassCard tone="cream" padding="md">
                <form onSubmit={handlePublishAdminPost} className="space-y-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3] flex items-center gap-2">
                      <Megaphone className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                      <span>Publish Official Admin Post or Announcement</span>
                    </h2>
                    <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">
                      Clearly badged as Official Admin Notice
                    </span>
                  </div>
                  <textarea
                    required
                    minLength={3}
                    rows={3}
                    value={adminPostForm.content}
                    onChange={(e) => setAdminPostForm({ ...adminPostForm, content: e.target.value })}
                    placeholder="Write an official campus update, policy reminder, or featured post..."
                    className="w-full p-3 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3]"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3 text-[#171613] dark:text-[#F5EFE3]">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={adminPostForm.isAnnouncement}
                          onChange={(e) => setAdminPostForm({ ...adminPostForm, isAnnouncement: e.target.checked })}
                          className="accent-[#D98BA5]"
                        />
                        <span>Official Announcement</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={adminPostForm.isPinned}
                          onChange={(e) => setAdminPostForm({ ...adminPostForm, isPinned: e.target.checked })}
                          className="accent-[#D98BA5]"
                        />
                        <span>Pin to Top</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={adminPostForm.isFeatured}
                          onChange={(e) => setAdminPostForm({ ...adminPostForm, isFeatured: e.target.checked })}
                          className="accent-[#D98BA5]"
                        />
                        <span>Feature in Feeds</span>
                      </label>
                      <select
                        value={adminPostForm.distributionScope}
                        onChange={(e) => setAdminPostForm({ ...adminPostForm, distributionScope: e.target.value as any })}
                        className="px-2.5 py-1.5 glass-input rounded-lg text-xs"
                      >
                        <option value="all">Push: All Feeds</option>
                        <option value="feed">Push: Main Feeds</option>
                        <option value="nearby">Push: Nearby Zone</option>
                      </select>
                      <select
                        value={adminPostForm.areaKey}
                        onChange={(e) => setAdminPostForm({ ...adminPostForm, areaKey: e.target.value })}
                        className="px-2.5 py-1.5 glass-input rounded-lg text-xs"
                      >
                        <option value="">Campus-Wide</option>
                        {CAMPUS_AREA_OPTIONS.map((a) => (
                          <option key={a.key} value={a.key}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <GlassButton type="submit" variant="pink" size="sm" loading={isPublishingAdminPost}>
                      <Send className="w-3.5 h-3.5" />
                      <span>Publish Admin Post</span>
                    </GlassButton>
                  </div>
                </form>
              </GlassCard>

              <div className="space-y-2.5">
                {posts.map((p) => (
                  <GlassCard
                    key={p.id}
                    tone={p.isHidden ? 'pink' : 'cream'}
                    padding="md"
                    className="text-xs flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                  >
                    <div className="space-y-1 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-semibold text-xs text-[#171613] dark:text-[#F5EFE3]">{p.authorName}</span>
                        <span className="font-mono text-[#82796F] dark:text-[#A89F95]">{p.authorHandle}</span>
                        {p.isAdminPost && (
                          <span className="font-semibold text-[#C4718E] dark:text-[#E5A4BA]">· Official Admin Notice</span>
                        )}
                        {p.isPinned && <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">· Pinned</span>}
                        {p.isFeatured && <span className="font-semibold text-[#C4718E]">· Featured ({p.distributionScope || 'all'})</span>}
                        {p.isHidden && <span className="font-semibold text-[#C4718E]">· Hidden</span>}
                      </div>
                      <p className="text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">{p.content}</p>
                      <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono tabular-nums">
                        Views: {p.viewsCount ?? 0} · Likes: {p.likesCount} · Comments: {p.commentsCount} ·{' '}
                        {new Date(p.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setEditPostTarget(p);
                          setEditPostForm({
                            content: p.content,
                            isPinned: p.isPinned,
                            isFeatured: Boolean(p.isFeatured),
                            isAnnouncement: p.isAnnouncement,
                            distributionScope: (p.distributionScope as any) || 'feed',
                          });
                        }}
                        className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 bg-[#FFFCF7]/75 dark:bg-white/8 text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1 cursor-pointer"
                      >
                        <Edit3 className="w-3 h-3" />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.adminTogglePostPin(p.id, !p.isPinned);
                            showFeedback(p.isPinned ? 'Post unpinned.' : 'Post pinned.');
                            await loadAll();
                          } catch (err: any) {
                            showFeedback(err?.message || 'Failed to update pin.', true);
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 bg-[#FFFCF7]/75 dark:bg-white/8 text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1 cursor-pointer"
                      >
                        <Pin className="w-3 h-3" />
                        <span>{p.isPinned ? 'Unpin' : 'Pin'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.adminTogglePostFeature(p.id, !p.isFeatured, !p.isFeatured ? 'all' : 'feed');
                            showFeedback(p.isFeatured ? 'Removed featured boost.' : 'Post featured across campus feeds.');
                            await loadAll();
                          } catch (err: any) {
                            showFeedback(err?.message || 'Failed to feature post.', true);
                          }
                        }}
                        className={`px-2.5 py-1 rounded-lg border flex items-center gap-1 cursor-pointer ${
                          p.isFeatured
                            ? 'bg-[#D98BA5] text-[#171613] border-[#C4718E]/40 font-semibold'
                            : 'border-[#171613]/15 dark:border-white/15 bg-[#FFFCF7]/75 dark:bg-white/8 text-[#171613] dark:text-[#F5EFE3]'
                        }`}
                      >
                        <Star className="w-3 h-3" />
                        <span>{p.isFeatured ? 'Featured' : 'Feature'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.adminTogglePostVisibility(p.id, !p.isHidden);
                            showFeedback(p.isHidden ? 'Post restored.' : 'Post hidden.');
                            await loadAll();
                          } catch (err: any) {
                            showFeedback(err?.message || 'Failed.', true);
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg border border-[#D98BA5]/50 bg-[#F6E2E6]/80 dark:bg-[#4A2532]/70 text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1 cursor-pointer"
                      >
                        {p.isHidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        <span>{p.isHidden ? 'Unhide' : 'Hide'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.adminDeletePost(p.id);
                            showFeedback('Post deleted permanently.');
                            await loadAll();
                          } catch (err: any) {
                            showFeedback(err?.message || 'Failed.', true);
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] cursor-pointer"
                      >
                        Delete
                      </button>
                    </div>
                  </GlassCard>
                ))}
              </div>
            </div>
          )}

          {contentSubTab === 'comments' && (
            <div className="space-y-2">
              {comments.map((c) => (
                <GlassCard key={c.id} tone="cream" padding="sm" className="text-xs flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                      {c.authorName} <span className="font-mono font-normal text-[#82796F] dark:text-[#A89F95]">{c.authorHandle}</span>
                    </div>
                    <p className="text-[#171613]/85 dark:text-[#F5EFE3]/85 mt-1">{c.content}</p>
                    <div className="text-[10px] text-[#82796F] dark:text-[#A89F95] font-mono mt-1">
                      Post: {c.postId} · {new Date(c.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await api.adminDeleteComment(c.id);
                      showFeedback('Comment removed.');
                      await loadAll();
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] cursor-pointer shrink-0"
                  >
                    Delete
                  </button>
                </GlassCard>
              ))}
            </div>
          )}

          {contentSubTab === 'communities' && (
            <GlassCard tone="cream" padding="none" className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase">
                    <th className="p-3">Community</th>
                    <th className="p-3">Zone</th>
                    <th className="p-3">Members / Posts</th>
                    <th className="p-3">Verified</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8">
                  {communities.map((c) => (
                    <tr key={c.id} className="hover:bg-[#FFFCF7]/65 dark:hover:bg-white/5">
                      <td className="p-3">
                        <div className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                          {c.name} <span className="font-mono text-[#82796F] dark:text-[#A89F95]">({c.acronym})</span>
                        </div>
                        <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] line-clamp-1">{c.description}</div>
                      </td>
                      <td className="p-3 text-[#82796F] dark:text-[#A89F95]">{c.category} · {c.location}</td>
                      <td className="p-3 font-mono tabular-nums">{c.memberCount} / {c.postsCount}</td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={async () => {
                            await api.adminUpdateCommunity(c.id, { isVerified: !c.isVerified });
                            showFeedback(`${c.acronym} verification updated.`);
                            await loadAll();
                          }}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-medium cursor-pointer border ${
                            c.isVerified ? 'bg-[#D98BA5] text-[#171613] border-[#C4718E]/40 font-semibold' : 'bg-[#E8DDCC]/70 dark:bg-[#2A2722]'
                          }`}
                        >
                          {c.isVerified ? 'Verified' : 'Unverified'}
                        </button>
                      </td>
                      <td className="p-3 text-right space-x-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setEditCommTarget(c);
                            setEditCommForm({ name: c.name, description: c.description, location: c.location, isVerified: c.isVerified });
                          }}
                          className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 cursor-pointer"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await api.adminDeleteCommunity(c.id);
                            showFeedback(`Deleted community ${c.name}.`);
                            await loadAll();
                          }}
                          className="px-2.5 py-1 rounded-lg bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] cursor-pointer"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </GlassCard>
          )}

          {contentSubTab === 'chats' && (
            <div className="space-y-3">
              <GlassCard tone="dark" padding="sm" className="text-xs flex items-center gap-2.5">
                <Lock className="w-4 h-4 text-[#D98BA5] shrink-0" />
                <span>Message contents stay shielded by default. Inspecting a flagged thread requires a logged moderation reason.</span>
              </GlassCard>
              <GlassCard tone="cream" padding="none" className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase">
                      <th className="p-3">Thread</th>
                      <th className="p-3">Type</th>
                      <th className="p-3">Members</th>
                      <th className="p-3">72h Msgs</th>
                      <th className="p-3 text-right">Controls</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8">
                    {chats.map((ch) => (
                      <tr key={ch.id} className="hover:bg-[#FFFCF7]/65 dark:hover:bg-white/5">
                        <td className="p-3 font-medium">
                          {ch.title}
                          {ch.pendingReportsCount > 0 && (
                            <span className="ml-2 text-[11px] font-semibold text-[#C4718E]">({ch.pendingReportsCount} reported)</span>
                          )}
                        </td>
                        <td className="p-3 font-mono uppercase text-[11px]">{ch.type}</td>
                        <td className="p-3 font-mono tabular-nums">{ch.participantCount}</td>
                        <td className="p-3 font-mono tabular-nums">{ch.activeMessagesCount}</td>
                        <td className="p-3 text-right space-x-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setInspectChatTarget(ch);
                              setInspectReason('');
                              setInspectedMessages(null);
                            }}
                            className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 cursor-pointer"
                          >
                            Inspect (Logged)
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              await api.adminDeleteChat(ch.id, 'Removed by Admin moderation');
                              showFeedback(`Deleted thread "${ch.title}".`);
                              await loadAll();
                            }}
                            className="px-2.5 py-1 rounded-lg bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] cursor-pointer"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassCard>
            </div>
          )}

          {contentSubTab === 'notifications' && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <GlassCard tone="cream" padding="md" className="md:col-span-5 h-fit">
                <form onSubmit={handleBroadcastNotification} className="space-y-3 text-xs">
                  <h3 className="font-serif font-bold text-base flex items-center gap-2">
                    <Bell className="w-4 h-4 text-[#C4718E]" />
                    <span>Broadcast Platform Notification</span>
                  </h3>
                  <GlassInput
                    label="Notice Title"
                    required
                    value={broadcastForm.title}
                    onChange={(e) => setBroadcastForm({ ...broadcastForm, title: e.target.value })}
                    placeholder="e.g. Official Campus Advisory"
                  />
                  <textarea
                    required
                    rows={3}
                    value={broadcastForm.body}
                    onChange={(e) => setBroadcastForm({ ...broadcastForm, body: e.target.value })}
                    placeholder="Write official bulletin..."
                    className="w-full px-3.5 py-2.5 glass-input rounded-xl text-xs"
                  />
                  <GlassInput
                    label="Target User ID (blank = all active accounts)"
                    value={broadcastForm.targetUserId}
                    onChange={(e) => setBroadcastForm({ ...broadcastForm, targetUserId: e.target.value })}
                    placeholder="Optional user ID"
                    className="font-mono"
                  />
                  <GlassButton type="submit" variant="pink" size="md" className="w-full">
                    <Send className="w-3.5 h-3.5" />
                    <span>Dispatch Notification</span>
                  </GlassButton>
                </form>
              </GlassCard>

              <GlassCard tone="cream" padding="md" className="md:col-span-7 space-y-2 text-xs">
                <h3 className="font-serif font-bold text-base mb-2">Recent Notifications Log</h3>
                {notifications.map((n) => (
                  <div key={n.id} className="p-3 rounded-xl border border-[#171613]/10 dark:border-white/10 bg-[#FFFCF7]/75 dark:bg-white/5">
                    <div className="flex justify-between gap-2">
                      <span className="font-semibold">{n.title}</span>
                      <span className="font-mono text-[10px] text-[#82796F]">to {n.recipientHandle || n.userId}</span>
                    </div>
                    <p className="text-[#82796F] dark:text-[#A89F95] mt-0.5">{n.body}</p>
                  </div>
                ))}
              </GlassCard>
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* 4. REPORTS & APPEALS */}
      {/* ================================================================= */}
      {section === 'reports' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3]">
                Content &amp; User Reports Queue
              </h3>
              <div className="flex gap-1.5 text-xs">
                {(['all', 'pending', 'escalated'] as const).map((rf) => (
                  <button
                    key={rf}
                    type="button"
                    onClick={() => setReportFilter(rf)}
                    className={`px-2.5 py-1 rounded-lg border capitalize cursor-pointer ${
                      reportFilter === rf
                        ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-transparent'
                        : 'border-[#171613]/10 dark:border-white/10 text-[#82796F] dark:text-[#A89F95]'
                    }`}
                  >
                    {rf === 'escalated' ? `Escalated (${escalatedReportsCount})` : rf}
                  </button>
                ))}
              </div>
            </div>

            {reports
              .filter((r) =>
                reportFilter === 'escalated' ? Boolean(r.escalated_to_admin) : reportFilter === 'pending' ? r.status === 'pending' : true
              )
              .map((r) => {
                const targetPost = r.target_type === 'post' ? posts.find((p) => p.id === r.target_id) : undefined;
                return (
                  <GlassCard key={r.id} tone="cream" padding="md" className="text-xs space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono uppercase text-[11px] font-semibold">
                        {r.target_type} · {r.reason}
                        {r.escalated_to_admin && (
                          <span className="text-[#C4718E] ml-2">
                            · Escalated by {r.escalated_by_handle || 'Moderator'}
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[11px] uppercase text-[#82796F]">{r.status}</span>
                    </div>
                    <p className="text-[#82796F] dark:text-[#A89F95]">{r.details || 'No statement provided.'}</p>
                    {r.escalation_reason && (
                      <div className="p-2.5 rounded-xl bg-[#F6E2E6]/70 dark:bg-[#4A2532]/65 border border-[#D98BA5]/50 text-[#171613] dark:text-[#F5EFE3]">
                        <strong>Moderator Escalation Note:</strong> {r.escalation_reason}
                      </div>
                    )}
                    {targetPost && (
                      <div className="p-2.5 rounded-xl bg-[#FFFCF7]/75 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10">
                        <div className="flex justify-between text-[11px] text-[#82796F]">
                          <span>{targetPost.authorName} ({targetPost.authorHandle})</span>
                          <span className="font-mono">{targetPost.isHidden ? 'Hidden' : 'Visible'}</span>
                        </div>
                        <p className="mt-1 line-clamp-2">{targetPost.content}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#171613]/10 dark:border-white/10">
                      <span className="text-[11px] text-[#82796F] font-mono">
                        Reporter: {r.reporter_handle || r.reporter_id} · Target: {r.target_id}
                      </span>
                      {r.status !== 'resolved' && r.status !== 'dismissed' && (
                        <div className="flex flex-wrap gap-1.5">
                          {targetPost && !targetPost.isHidden && (
                            <button
                              type="button"
                              onClick={async () => {
                                await api.adminTogglePostVisibility(targetPost.id, true);
                                await api.updateAdminReport(r.id, 'resolved', 'Post hidden by Admin');
                                showFeedback('Post hidden and report resolved.');
                                await loadAll();
                              }}
                              className="px-2.5 py-1 rounded-lg bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] font-semibold cursor-pointer"
                            >
                              Hide Post &amp; Resolve
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              await api.updateAdminReport(r.id, 'resolved', 'Resolved by Admin');
                              showFeedback('Report resolved.');
                              await loadAll();
                            }}
                            className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] font-semibold cursor-pointer"
                          >
                            Resolve
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              await api.updateAdminReport(r.id, 'dismissed', 'Dismissed by Admin');
                              showFeedback('Report dismissed.');
                              await loadAll();
                            }}
                            className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 cursor-pointer"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                    </div>
                  </GlassCard>
                );
              })}
          </div>

          <div className="lg:col-span-5 space-y-3">
            <h3 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3]">
              Student Appeals Desk
            </h3>
            {appeals.length === 0 ? (
              <GlassCard tone="cream" padding="lg" className="text-center text-xs text-[#82796F]">
                No appeals pending.
              </GlassCard>
            ) : (
              appeals.map((a) => (
                <GlassCard key={a.id} tone="cream" padding="md" className="text-xs space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold">{a.studentName} ({a.studentHandle})</span>
                    <span className="font-mono text-[10px] uppercase text-[#82796F]">{a.status}</span>
                  </div>
                  <div className="text-[11px] font-mono text-[#C4718E] uppercase">{a.type} Appeal</div>
                  <p className="bg-[#FFFCF7]/75 dark:bg-white/5 p-2.5 rounded-xl border border-[#171613]/10 dark:border-white/10">
                    {a.statement}
                  </p>
                  {a.status === 'pending' && (
                    <GlassButton
                      variant="black"
                      size="sm"
                      onClick={() => {
                        setAppealTarget(a);
                        setAppealDecision('accepted');
                        setAppealNotes('');
                      }}
                      className="w-full"
                    >
                      Decide Appeal
                    </GlassButton>
                  )}
                </GlassCard>
              ))
            )}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* 5. MODERATORS & GRANULAR PERMISSIONS */}
      {/* ================================================================= */}
      {section === 'moderators' && (
        <div className="space-y-4">
          <GlassCard tone="cream" padding="md" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3]">
                Moderator Accounts &amp; Scoped Permissions
              </h2>
              <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                Assign separate Moderators with backend-enforced safety permissions. Moderators cannot access Admin settings, payments, advertisements, or credentials.
              </p>
            </div>
            <GlassButton
              variant="pink"
              size="sm"
              onClick={() => {
                setAssignModMode(promotableUsers.length > 0 ? 'promote' : 'create');
                setAssignModForm((prev) => ({
                  ...prev,
                  userId: promotableUsers[0]?.id || '',
                }));
                setShowAssignModModal(true);
              }}
              className="shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Assign Moderator</span>
            </GlassButton>
          </GlassCard>

          {moderators.length === 0 ? (
            <GlassCard tone="cream" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
              No separate Moderator accounts assigned yet. Click "Assign Moderator" to promote an existing trusted user or create a Moderator account.
            </GlassCard>
          ) : (
            <div className="space-y-3">
              {moderators.map((m) => {
                const togglePerm = async (key: keyof ModeratorPermissions, val: any) => {
                  await executeWithReauth(`Update ${m.handle} permissions`, async () => {
                    await api.adminUpdateModeratorPermissions(m.id, { [key]: val });
                    showFeedback(`Updated ${m.handle} permissions.`);
                    await loadAll();
                  });
                };
                return (
                  <GlassCard key={m.id} tone="cream" padding="md" className="text-xs space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-[#171613]/10 dark:border-white/10">
                      <div>
                        <div className="font-semibold text-sm text-[#171613] dark:text-[#F5EFE3]">
                          {m.name} <span className="font-mono text-xs text-[#C4718E]">{m.handle}</span>
                        </div>
                        <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono tabular-nums">
                          Handled {m.handledReportsCount} report(s) · {m.actionsCount} logged action(s)
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await executeWithReauth(`Revoke Moderator role for ${m.handle}`, async () => {
                            await api.adminRevokeModerator(m.id);
                            showFeedback(`Revoked Moderator privileges for ${m.handle}.`);
                            await loadAll();
                          });
                        }}
                        className="px-3 py-1.5 rounded-lg bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] cursor-pointer self-start sm:self-auto"
                      >
                        Revoke Moderator
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                      {(
                        [
                          ['canReviewReports', 'Review Reports'],
                          ['canHideContent', 'Hide Content'],
                          ['canWarnUsers', 'Warn Users'],
                          ['canRestrictUsers', 'Restrict Users'],
                          ['canReviewCommunities', 'Communities'],
                          ['canEscalate', 'Escalate Admin'],
                        ] as const
                      ).map(([permKey, label]) => {
                        const enabled = Boolean(m.permissions[permKey]);
                        return (
                          <button
                            key={permKey}
                            type="button"
                            onClick={() => togglePerm(permKey, !enabled)}
                            className={`px-2.5 py-2 rounded-xl border text-[11px] font-medium cursor-pointer transition-colors ${
                              enabled
                                ? 'bg-[#D98BA5] text-[#171613] border-[#C4718E]/40 font-semibold'
                                : 'bg-[#FFFCF7]/70 dark:bg-white/5 text-[#82796F] dark:text-[#A89F95] border-[#171613]/10 dark:border-white/10'
                            }`}
                          >
                            {label}: {enabled ? 'ON' : 'OFF'}
                          </button>
                        );
                      })}
                      <select
                        value={m.permissions.maxRestrictionHours}
                        onChange={(e) => togglePerm('maxRestrictionHours', Number(e.target.value))}
                        aria-label="Maximum restriction hours"
                        className="px-2.5 py-2 glass-input rounded-xl font-mono text-[11px]"
                      >
                        <option value={6}>Max 6h</option>
                        <option value={12}>Max 12h</option>
                        <option value={24}>Max 24h</option>
                        <option value={48}>Max 48h</option>
                        <option value={72}>Max 72h</option>
                        <option value={168}>Max 168h (7d)</option>
                      </select>
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* 6. COMPLETE APP ANALYTICS (100% REAL DATABASE METRICS) */}
      {/* ================================================================= */}
      {section === 'analytics' && analytics && (() => {
        const series = analytics.activityTimeSeries || [];
        const maxVal = Math.max(
          1,
          ...series.map((d) => Math.max(d.registrations, d.posts, d.comments, d.messages))
        );
        const w = 640;
        const h = 190;
        const px = 34;
        const py = 20;
        const xFor = (i: number) =>
          series.length <= 1 ? w / 2 : px + (i * (w - px * 2)) / (series.length - 1);
        const yFor = (val: number) => h - py - (val / maxVal) * (h - py * 2);
        const makeLine = (getter: (d: (typeof series)[0]) => number) =>
          series.map((d, i) => `${xFor(i).toFixed(1)},${yFor(getter(d)).toFixed(1)}`).join(' ');

        return (
          <div className="space-y-5">
            <GlassCard tone="cream" padding="md" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3]">
                  Platform Analytics &amp; Verified Telemetry
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] tabular-nums">
                  100% real SQLite calculations · Generated {new Date(analytics.generatedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(['24h', '7d', '30d', 'all'] as AnalyticsRange[]).map((rng) => (
                  <button
                    key={rng}
                    type="button"
                    onClick={() => setAnalyticsRange(rng)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-mono uppercase cursor-pointer border ${
                      analyticsRange === rng
                        ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-transparent'
                        : 'bg-[#FFFCF7]/75 dark:bg-white/5 text-[#82796F] border-[#171613]/10 dark:border-white/10'
                    }`}
                  >
                    {rng}
                  </button>
                ))}
                <GlassButton
                  variant="pink"
                  size="sm"
                  onClick={() => api.adminDownloadAnalyticsExport(analyticsRange, 'csv')}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV</span>
                </GlassButton>
                <GlassButton
                  variant="glass"
                  size="sm"
                  onClick={() => api.adminDownloadAnalyticsExport(analyticsRange, 'json')}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export JSON</span>
                </GlassButton>
              </div>
            </GlassCard>

            {/* Users, Registrations & Retention KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <GlassCard tone="cream" padding="md">
                <div className="text-[#82796F] dark:text-[#A89F95]">Users (Total / Active)</div>
                <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
                  {analytics.users.totalUsers} / {analytics.users.activeUsers}
                </div>
                <div className="text-[11px] font-mono text-[#C4718E] mt-0.5 tabular-nums">
                  Online Now: {analytics.users.onlineNow}
                </div>
              </GlassCard>
              <GlassCard tone="cream" padding="md">
                <div className="text-[#82796F] dark:text-[#A89F95]">Registrations (24h / 7d / 30d)</div>
                <div className="text-xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
                  {analytics.users.registrations.daily} / {analytics.users.registrations.weekly} /{' '}
                  {analytics.users.registrations.monthly}
                </div>
                <div className="text-[11px] font-mono text-[#82796F] mt-0.5 tabular-nums">
                  DAU {analytics.users.dau} · WAU {analytics.users.wau} · MAU {analytics.users.mau}
                </div>
              </GlassCard>
              <GlassCard tone="cream" padding="md">
                <div className="text-[#82796F] dark:text-[#A89F95]">Content &amp; Messages</div>
                <div className="text-xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
                  {analytics.engagement.totalPosts} posts · {analytics.engagement.totalMessages} msgs
                </div>
                <div className="text-[11px] font-mono text-[#82796F] mt-0.5 tabular-nums">
                  {analytics.engagement.totalComments} comments · {analytics.engagement.totalReplies} replies
                </div>
              </GlassCard>
              <GlassCard tone="cream" padding="md">
                <div className="text-[#82796F] dark:text-[#A89F95]">7-Day Retention &amp; Views</div>
                <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
                  {analytics.users.retention7dRate}%
                </div>
                <div className="text-[11px] font-mono text-[#82796F] mt-0.5 tabular-nums">
                  {analytics.engagement.totalViews.toLocaleString()} views · {analytics.engagement.totalLikes.toLocaleString()} likes
                </div>
              </GlassCard>
            </div>

            {/* Real Activity Time-Series Chart */}
            <GlassCard tone="cream" padding="md" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                  Daily Activity &amp; Registration Trend ({analytics.range.toUpperCase()})
                </h3>
                <div className="flex items-center gap-4 text-[11px] font-mono">
                  <span className="flex items-center gap-1.5"><span className="w-3 h-1 bg-[#171613] dark:bg-[#F5EFE3]" />Posts</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-1 bg-[#C4718E]" />Messages</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-1 bg-[#82796F]" />Registrations</span>
                </div>
              </div>
              {series.length === 0 ? (
                <div className="py-10 text-center text-xs text-[#82796F]">No timestamped activity inside this window yet.</div>
              ) : (
                <div className="w-full overflow-x-auto text-[#171613] dark:text-[#F5EFE3]">
                  <svg viewBox={`0 0 ${w} ${h + 24}`} className="w-full h-48 min-w-[440px]">
                    {[0.25, 0.5, 0.75, 1].map((r) => {
                      const y = h - py - r * (h - py * 2);
                      return <line key={r} x1={px} y1={y} x2={w - px} y2={y} stroke="currentColor" strokeOpacity="0.1" strokeDasharray="3 4" />;
                    })}
                    {series.length > 1 && (
                      <>
                        <polyline fill="none" stroke="currentColor" strokeWidth="2.2" points={makeLine((d) => d.posts)} />
                        <polyline fill="none" stroke="#C4718E" strokeWidth="2.2" points={makeLine((d) => d.messages)} />
                        <polyline fill="none" stroke="#82796F" strokeWidth="1.8" strokeDasharray="4 3" points={makeLine((d) => d.registrations)} />
                      </>
                    )}
                    {series.map((d, i) => (
                      <g key={d.day}>
                        <circle cx={xFor(i)} cy={yFor(d.posts)} r="3.2" fill="currentColor" />
                        <circle cx={xFor(i)} cy={yFor(d.messages)} r="3.2" fill="#C4718E" />
                        {(i === 0 || i === series.length - 1 || i % Math.max(1, Math.floor(series.length / 6)) === 0) && (
                          <text x={xFor(i)} y={h + 15} textAnchor="middle" fontSize="10" fill="var(--sb-muted)" fontFamily="ui-monospace, monospace">
                            {d.day.slice(5)}
                          </text>
                        )}
                      </g>
                    ))}
                  </svg>
                </div>
              )}
            </GlassCard>

            {/* Tables Row: Location Feed Activity & Moderation/Ads/System */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <GlassCard tone="cream" padding="none" className="overflow-x-auto">
                <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 font-serif font-bold text-base">
                  Location-Based Feed Activity
                </div>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                      <th className="p-3">Campus Zone</th>
                      <th className="p-3 text-right">Posts</th>
                      <th className="p-3 text-right">Views</th>
                      <th className="p-3 text-right">Interactions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                    {analytics.locationActivity.map((loc) => (
                      <tr key={loc.areaKey}>
                        <td className="p-3 font-medium capitalize">{loc.areaKey.replace(/_/g, ' ')}</td>
                        <td className="p-3 text-right font-mono">{loc.postsCount}</td>
                        <td className="p-3 text-right font-mono">{loc.totalViews}</td>
                        <td className="p-3 text-right font-mono">{loc.totalInteractions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassCard>

              <GlassCard tone="cream" padding="md" className="space-y-2.5 text-xs tabular-nums">
                <h3 className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
                  Safety, Ads, Payments &amp; DB Health
                </h3>
                <div className="flex justify-between">
                  <span className="text-[#82796F]">Reports (Pending / Resolved / Escalated)</span>
                  <span className="font-mono font-semibold">
                    {analytics.moderation.reportsPending} / {analytics.moderation.reportsResolved} / {analytics.moderation.reportsEscalated}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#82796F]">Blocked / Restricted Accounts &amp; Peer Blocks</span>
                  <span className="font-mono font-semibold">
                    {analytics.moderation.blockedAccountsCount} · {analytics.moderation.userBlocksCount} peer blocks
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#82796F]">Advertisements (Active / Impressions / Clicks)</span>
                  <span className="font-mono font-semibold">
                    {analytics.advertisements.activeCampaigns} / {analytics.advertisements.totalImpressions} / {analytics.advertisements.totalClicks} ({analytics.advertisements.ctrPercent}% CTR)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#82796F]">Payment Records (Confirmed / Pending)</span>
                  <span className="font-mono font-semibold">
                    {formatNaira(analytics.payments.confirmedVolumeNaira)} / {formatNaira(analytics.payments.pendingVolumeNaira)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#82796F]">DB Size · Media Disk · Latency</span>
                  <span className="font-mono font-semibold">
                    {formatBytes(analytics.system.databaseBytes)} · {formatBytes(analytics.system.mediaBytes)} · {analytics.system.dbLatencyMs}ms
                  </span>
                </div>
              </GlassCard>
            </div>

            {/* Top Viewed & Trending Posts */}
            <GlassCard tone="cream" padding="none" className="overflow-x-auto">
              <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 font-serif font-bold text-base">
                Most Viewed &amp; Trending Posts
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                    <th className="p-3">Author &amp; Post</th>
                    <th className="p-3">Area</th>
                    <th className="p-3 text-right">Views</th>
                    <th className="p-3 text-right">Likes</th>
                    <th className="p-3 text-right">Comments</th>
                    <th className="p-3 text-right">Shares</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                  {analytics.topPosts.map((tp) => (
                    <tr key={tp.id}>
                      <td className="p-3 max-w-md">
                        <div className="font-mono text-[11px] text-[#82796F]">
                          {tp.authorHandle} {tp.isAdminPost && '· Official Admin'}
                        </div>
                        <div className="truncate font-medium text-[#171613] dark:text-[#F5EFE3]">{tp.content}</div>
                      </td>
                      <td className="p-3 capitalize text-[#82796F]">{tp.areaKey.replace(/_/g, ' ')}</td>
                      <td className="p-3 text-right font-mono font-semibold">{tp.views}</td>
                      <td className="p-3 text-right font-mono">{tp.likes}</td>
                      <td className="p-3 text-right font-mono">{tp.comments}</td>
                      <td className="p-3 text-right font-mono">{tp.shares}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </GlassCard>

            {/* Popular Communities & Groups */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <GlassCard tone="cream" padding="none" className="overflow-x-auto">
                <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 font-serif font-bold text-base">
                  Popular Communities
                </div>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                      <th className="p-3">Community</th>
                      <th className="p-3 text-right">Members</th>
                      <th className="p-3 text-right">Posts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                    {analytics.popularCommunities.map((c) => (
                      <tr key={c.id}>
                        <td className="p-3 font-medium">
                          {c.name} <span className="font-mono text-[#82796F]">({c.acronym})</span>
                        </td>
                        <td className="p-3 text-right font-mono">{c.memberCount}</td>
                        <td className="p-3 text-right font-mono">{c.postsCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassCard>

              <GlassCard tone="cream" padding="none" className="overflow-x-auto">
                <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 font-serif font-bold text-base">
                  Popular Group Chats
                </div>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                      <th className="p-3">Group</th>
                      <th className="p-3 text-right">Participants</th>
                      <th className="p-3 text-right">Messages</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                    {analytics.popularGroups.map((g) => (
                      <tr key={g.id}>
                        <td className="p-3 font-medium">{g.title}</td>
                        <td className="p-3 text-right font-mono">{g.membersCount}</td>
                        <td className="p-3 text-right font-mono">{g.messagesCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassCard>
            </div>
          </div>
        );
      })()}

      {/* ================================================================= */}
      {/* 7. ADVERTISEMENTS & CAMPAIGNS */}
      {/* ================================================================= */}
      {section === 'advertisements' && (
        <div className="space-y-4">
          <GlassCard tone="cream" padding="md" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3]">
                Campus Advertisements &amp; Sponsored Campaigns
              </h2>
              <p className="text-xs text-[#82796F] dark:text-[#A89F95] tabular-nums">
                {advertisements.length} campaign(s) · Total impressions:{' '}
                {advertisements.reduce((acc, a) => acc + a.impressionsCount, 0).toLocaleString()} · Total clicks:{' '}
                {advertisements.reduce((acc, a) => acc + a.clicksCount, 0).toLocaleString()}
              </p>
            </div>
            <GlassButton
              variant="pink"
              size="sm"
              onClick={() => {
                setEditAdTarget(null);
                setAdForm({
                  title: '',
                  sponsorName: '',
                  body: '',
                  targetUrl: '',
                  placement: 'feed',
                  targetArea: 'all',
                  status: 'active',
                  budgetNaira: 15000,
                });
                setShowAdModal(true);
              }}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Campaign</span>
            </GlassButton>
          </GlassCard>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {advertisements.map((ad) => (
              <GlassCard key={ad.id} tone="cream" padding="md" className="text-xs space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">{ad.title}</div>
                    <div className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">
                      {ad.sponsorName} · {ad.placement} · Area: {ad.targetArea}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] uppercase text-[#C4718E] font-semibold">{ad.status}</span>
                </div>
                <p className="text-[#171613]/85 dark:text-[#F5EFE3]/85">{ad.body}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-[#171613]/10 dark:border-white/10 font-mono tabular-nums text-[11px]">
                  <div>
                    <span className="text-[#82796F] block">Impressions</span>
                    <strong>{ad.impressionsCount.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span className="text-[#82796F] block">Clicks</span>
                    <strong>{ad.clicksCount.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span className="text-[#82796F] block">CTR</span>
                    <strong>{ad.ctrPercent}%</strong>
                  </div>
                  <div>
                    <span className="text-[#82796F] block">Budget</span>
                    <strong>{formatNaira(ad.budgetNaira)}</strong>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      const nextStatus = ad.status === 'active' ? 'paused' : 'active';
                      await api.adminUpdateAdvertisement(ad.id, { status: nextStatus });
                      showFeedback(`Campaign status set to ${nextStatus}.`);
                      await loadAll();
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] font-semibold cursor-pointer"
                  >
                    {ad.status === 'active' ? 'Pause' : 'Activate'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditAdTarget(ad);
                      setAdForm({
                        title: ad.title,
                        sponsorName: ad.sponsorName,
                        body: ad.body,
                        targetUrl: ad.targetUrl || '',
                        placement: ad.placement,
                        targetArea: ad.targetArea,
                        status: ad.status,
                        budgetNaira: ad.budgetNaira,
                      });
                      setShowAdModal(true);
                    }}
                    className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 cursor-pointer"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await api.adminDeleteAdvertisement(ad.id);
                      showFeedback('Campaign deleted.');
                      await loadAll();
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] cursor-pointer"
                  >
                    Delete
                  </button>
                </div>
              </GlassCard>
            ))}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* 8. PAYMENT & RETAINED ACCOUNTING RECORDS */}
      {/* ================================================================= */}
      {section === 'payments' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <GlassCard tone="cream" padding="md">
              <div className="text-[#82796F]">Total Records</div>
              <div className="text-2xl font-serif font-bold mt-1 tabular-nums">{paymentData.summary.totalRecords}</div>
            </GlassCard>
            <GlassCard tone="cream" padding="md">
              <div className="text-[#82796F]">Confirmed Volume</div>
              <div className="text-2xl font-serif font-bold mt-1 tabular-nums">{formatNaira(paymentData.summary.confirmedNaira)}</div>
            </GlassCard>
            <GlassCard tone="cream" padding="md">
              <div className="text-[#82796F]">Pending Verification</div>
              <div className="text-2xl font-serif font-bold mt-1 tabular-nums text-[#C4718E]">
                {formatNaira(paymentData.summary.pendingNaira)}
              </div>
            </GlassCard>
            <GlassCard tone="cream" padding="md">
              <div className="text-[#82796F]">Retained Archives</div>
              <div className="text-2xl font-serif font-bold mt-1 tabular-nums">{paymentData.summary.retainedCount}</div>
            </GlassCard>
          </div>

          <GlassCard tone="cream" padding="sm" className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-3.5 h-3.5 text-[#82796F] absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={paymentSearch}
                  onChange={(e) => setPaymentSearch(e.target.value)}
                  placeholder="Search reference or payer..."
                  className="w-full pl-8 pr-3 py-2 glass-input rounded-xl text-xs"
                />
              </div>
              <select
                value={paymentStatusFilter}
                onChange={(e) => setPaymentStatusFilter(e.target.value)}
                className="px-3 py-2 glass-input rounded-xl text-xs"
              >
                <option value="all">All Statuses</option>
                <option value="confirmed">Confirmed</option>
                <option value="awaiting_verification">Awaiting Verification</option>
                <option value="pending">Pending</option>
                <option value="reversed">Reversed / Refunded</option>
              </select>
            </div>
            <GlassButton variant="pink" size="sm" onClick={() => setShowPaymentModal(true)}>
              <Plus className="w-3.5 h-3.5" />
              <span>Record Ledger Entry</span>
            </GlassButton>
          </GlassCard>

          <GlassCard tone="cream" padding="none" className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                  <th className="p-3">Reference &amp; Account</th>
                  <th className="p-3">Purpose &amp; Channel</th>
                  <th className="p-3 text-right">Amount</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Verification</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                {paymentData.records.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-[#82796F]">
                      No payment records recorded yet. Core student social &amp; chat features are 100% free.
                    </td>
                  </tr>
                ) : (
                  paymentData.records.map((pr) => (
                    <tr key={pr.id}>
                      <td className="p-3">
                        <div className="font-mono font-semibold">{pr.reference}</div>
                        <div className="text-[11px] text-[#82796F]">{pr.payerAccountName || pr.userHandle}</div>
                      </td>
                      <td className="p-3 text-[#82796F]">
                        {pr.purpose} · {pr.channel}
                      </td>
                      <td className="p-3 text-right font-mono font-semibold">{formatNaira(pr.amountNaira)}</td>
                      <td className="p-3 font-mono uppercase text-[11px]">{pr.status}</td>
                      <td className="p-3 text-right space-x-1">
                        {pr.status !== 'confirmed' && (
                          <button
                            type="button"
                            onClick={async () => {
                              await api.adminUpdatePaymentRecordStatus(pr.id, 'confirmed', 'Confirmed by Admin');
                              showFeedback(`Confirmed ${pr.reference}.`);
                              await loadAll();
                            }}
                            className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] font-semibold cursor-pointer"
                          >
                            Confirm
                          </button>
                        )}
                        {pr.status !== 'reversed' && (
                          <button
                            type="button"
                            onClick={async () => {
                              await api.adminUpdatePaymentRecordStatus(pr.id, 'reversed', 'Reversed by Admin');
                              showFeedback(`Marked ${pr.reference} reversed.`);
                              await loadAll();
                            }}
                            className="px-2.5 py-1 rounded-lg border border-[#171613]/15 dark:border-white/15 cursor-pointer"
                          >
                            Reverse
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </GlassCard>
        </div>
      )}

      {/* ================================================================= */}
      {/* 9. STORAGE & BACKUPS */}
      {/* ================================================================= */}
      {section === 'storage' && (
        <div className="space-y-5">
          {storage && (
            <GlassCard tone="cream" padding="lg" className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3]">
                    Strict {storage.quotaGb} GB Application Storage Budget ({storage.usagePercent}% used)
                  </h3>
                  <p className="text-xs text-[#82796F] tabular-nums">
                    Used {formatBytes(storage.totalUsedBytes)} · Available {formatBytes(storage.availableBytes)}
                  </p>
                </div>
                <GlassButton variant="glass" size="sm" onClick={handleDownloadStorageReport}>
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Report</span>
                </GlassButton>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-xs tabular-nums">
                <div className="p-3 rounded-xl bg-[#FFFCF7]/80 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10">
                  <div className="text-[#82796F]">Database Core</div>
                  <div className="font-mono font-bold mt-1">{formatBytes(storage.breakdown.databaseBytes)}</div>
                </div>
                <div className="p-3 rounded-xl bg-[#FFFCF7]/80 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10">
                  <div className="text-[#82796F]">WAL Journal</div>
                  <div className="font-mono font-bold mt-1">{formatBytes(storage.breakdown.walBytes)}</div>
                </div>
                <div className="p-3 rounded-xl bg-[#FFFCF7]/80 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10">
                  <div className="text-[#82796F]">Images Media</div>
                  <div className="font-mono font-bold mt-1">{formatBytes(storage.breakdown.imagesBytes ?? storage.breakdown.uploadsDiskBytes)}</div>
                </div>
                <div className="p-3 rounded-xl bg-[#FFFCF7]/80 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10">
                  <div className="text-[#82796F]">Encrypted Backups</div>
                  <div className="font-mono font-bold mt-1">{formatBytes(storage.breakdown.backupsBytes)}</div>
                </div>
                <div className="p-3 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/70 border border-[#D98BA5]/50">
                  <div className="text-[#C4718E] font-medium">Verified Orphans</div>
                  <div className="font-mono font-bold mt-1">
                    {storage.orphans.count} ({formatBytes(storage.orphans.totalBytes)})
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-2 border-t border-[#171613]/10 dark:border-white/10 text-xs">
                <GlassButton
                  variant="black"
                  size="sm"
                  onClick={async () => {
                    const res = await api.trigger72HourPurge();
                    setPurgeSummary(res);
                    showFeedback(`Purged ${res.messagesPurged ?? 0} messages & ${res.postsPurged ?? 0} posts.`);
                    await loadAll();
                  }}
                >
                  Run 72h Purge ({storage.expiredContent.pendingExpiredMessages + storage.expiredContent.pendingExpiredPosts} due)
                </GlassButton>
                <GlassButton variant="pink" size="sm" onClick={() => setShowCleanOrphansConfirm(true)} disabled={storage.orphans.count === 0}>
                  Clean Orphans ({storage.orphans.count})
                </GlassButton>
                <GlassButton
                  variant="glass"
                  size="sm"
                  onClick={async () => {
                    const res = await api.adminClearExpiredCaches();
                    showFeedback(`Cleared ${res.clearedCacheEntries} cache entries & ${res.expiredSessionsRemoved} stale sessions.`);
                    await loadAll();
                  }}
                >
                  Clear Caches &amp; Sessions
                </GlassButton>
              </div>
              {purgeSummary && (
                <div className="p-3 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/70 border border-[#D98BA5]/50 text-xs">
                  Latest Purge: Removed {purgeSummary.messagesPurged ?? 0} messages, {purgeSummary.postsPurged ?? 0} posts, {purgeSummary.filesDeleted ?? 0} files.
                </div>
              )}
            </GlassCard>
          )}

          <GlassCard tone="cream" padding="lg" className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="font-serif font-bold text-base">Encrypted Backups &amp; Restoration</h3>
                <p className="text-xs text-[#82796F]">AES-256-GCM snapshots with SHA-256 account tombstones</p>
              </div>
              <GlassButton
                variant="pink"
                size="sm"
                onClick={async () => {
                  const snap = await api.createBackup();
                  showFeedback(`Created snapshot ${snap.filename} (${snap.sizeFormatted}).`);
                  await loadAll();
                }}
              >
                Create Snapshot
              </GlassButton>
            </div>
            <div className="space-y-2 text-xs">
              {backups.map((b) => (
                <div key={b.id} className="p-3 rounded-xl border border-[#171613]/10 dark:border-white/10 bg-[#FFFCF7]/75 dark:bg-white/5 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-mono font-semibold">{b.filename}</div>
                    <div className="text-[11px] text-[#82796F] font-mono tabular-nums">
                      {b.sizeFormatted} · SHA256: {b.checksum.slice(0, 14)}...
                    </div>
                  </div>
                  <GlassButton
                    variant="glass"
                    size="sm"
                    onClick={async () => {
                      await executeWithReauth(`Restore backup ${b.filename}`, async () => {
                        const res = await api.restoreBackup(b.id);
                        showFeedback(res.message || 'Snapshot restored.');
                        await loadAll();
                      });
                    }}
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Restore</span>
                  </GlassButton>
                </div>
              ))}
            </div>
          </GlassCard>
        </div>
      )}

      {/* ================================================================= */}
      {/* 10. SETTINGS, FEATURES & SECURITY */}
      {/* ================================================================= */}
      {section === 'settings' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {[
              { id: 'website', label: 'Website Settings', icon: <Globe className="w-3.5 h-3.5" /> },
              { id: 'features', label: `Feature Flags (${features.length})`, icon: <Sliders className="w-3.5 h-3.5" /> },
              { id: 'security', label: 'Security, MFA, Performance & Audit Logs', icon: <Lock className="w-3.5 h-3.5" /> },
            ].map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setSettingsSubTab(st.id as any)}
                className={`px-3.5 py-2 rounded-xl text-xs font-medium flex items-center gap-1.5 cursor-pointer ${
                  settingsSubTab === st.id
                    ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613]'
                    : 'bg-[#FFFCF7]/75 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10'
                }`}
              >
                {st.icon}
                <span>{st.label}</span>
              </button>
            ))}
          </div>

          {settingsSubTab === 'website' && (
            <GlassCard tone="cream" padding="lg">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await executeWithReauth('Save global website settings', async () => {
                    await api.adminUpdateWebsiteSettings(siteSettings);
                    showFeedback('Global website settings saved and broadcast live.');
                    await loadAll();
                    await syncPublicConfig();
                  });
                }}
                className="space-y-5 text-xs"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <GlassInput label="Site Name" value={siteSettings.site_name || ''} onChange={(e) => setSiteSettings({ ...siteSettings, site_name: e.target.value })} />
                  <GlassInput label="Tagline" value={siteSettings.site_tagline || ''} onChange={(e) => setSiteSettings({ ...siteSettings, site_tagline: e.target.value })} />
                  <GlassInput label="Campus Zone" value={siteSettings.campus_zone || ''} onChange={(e) => setSiteSettings({ ...siteSettings, campus_zone: e.target.value })} />
                  <GlassInput label="Support Email" value={siteSettings.support_email || ''} onChange={(e) => setSiteSettings({ ...siteSettings, support_email: e.target.value })} />
                </div>
                <div className="p-4 rounded-2xl bg-[#F6E2E6] dark:bg-[#4A2532]/70 border border-[#D98BA5]/50 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold">Global Maintenance Mode</div>
                      <div className="text-[11px] text-[#82796F]">Keeps Admin access open while pausing regular traffic.</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={siteSettings.maintenance_mode === 'true'}
                      onChange={(e) => setSiteSettings({ ...siteSettings, maintenance_mode: e.target.checked ? 'true' : 'false' })}
                      className="w-4 h-4 accent-[#171613]"
                    />
                  </div>
                  <input
                    value={siteSettings.maintenance_message || ''}
                    onChange={(e) => setSiteSettings({ ...siteSettings, maintenance_message: e.target.value })}
                    placeholder="Maintenance banner message..."
                    className="w-full px-3.5 py-2 glass-input rounded-xl"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="p-3 rounded-xl border border-[#171613]/10 dark:border-white/10 flex items-center justify-between cursor-pointer">
                    <span>Allow New Registrations</span>
                    <input
                      type="checkbox"
                      checked={siteSettings.allow_new_registrations !== 'false'}
                      onChange={(e) => setSiteSettings({ ...siteSettings, allow_new_registrations: e.target.checked ? 'true' : 'false' })}
                      className="w-4 h-4 accent-[#D98BA5]"
                    />
                  </label>
                  <label className="p-3 rounded-xl border border-[#171613]/10 dark:border-white/10 flex items-center justify-between cursor-pointer">
                    <span>Admin MFA Enforcement</span>
                    <input
                      type="checkbox"
                      checked={siteSettings.admin_mfa_required === 'true'}
                      onChange={(e) => setSiteSettings({ ...siteSettings, admin_mfa_required: e.target.checked ? 'true' : 'false' })}
                      className="w-4 h-4 accent-[#D98BA5]"
                    />
                  </label>
                </div>
                <div className="flex justify-end">
                  <GlassButton type="submit" variant="pink" size="md">
                    Save Website Settings
                  </GlassButton>
                </div>
              </form>
            </GlassCard>
          )}

          {settingsSubTab === 'features' && (
            <div className="space-y-4">
              <div className="flex justify-end">
                <GlassButton variant="pink" size="sm" onClick={() => setShowAddFeatureModal(true)}>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Register Feature Flag</span>
                </GlassButton>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {features.map((f) => (
                  <GlassCard key={f.key} tone="cream" padding="md" className="space-y-3 text-xs">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-serif font-bold text-sm">{f.name}</span>
                        <span className="font-mono text-[10px] text-[#82796F]">{f.key}</span>
                      </div>
                      <p className="text-[#82796F] mt-1">{f.description}</p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-[#171613]/10 dark:border-white/10">
                      <button
                        type="button"
                        onClick={async () => {
                          await api.adminUpdateFeature(f.key, { enabled: !f.enabled });
                          await loadAll();
                          await syncPublicConfig();
                        }}
                        className={`py-1.5 px-2 rounded-xl font-medium border cursor-pointer ${
                          f.enabled ? 'bg-[#D98BA5] text-[#171613] font-semibold' : 'bg-[#171613] text-[#F5EFE3]'
                        }`}
                      >
                        {f.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.adminUpdateFeature(f.key, { visibleInNav: !f.visibleInNav });
                          await loadAll();
                          await syncPublicConfig();
                        }}
                        className="py-1.5 px-2 rounded-xl border border-[#171613]/15 dark:border-white/15 cursor-pointer"
                      >
                        {f.visibleInNav ? 'In Nav' : 'Hidden Nav'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.adminUpdateFeature(f.key, { maintenanceMode: !f.maintenanceMode });
                          await loadAll();
                          await syncPublicConfig();
                        }}
                        className="py-1.5 px-2 rounded-xl border border-[#171613]/15 dark:border-white/15 cursor-pointer"
                      >
                        {f.maintenanceMode ? 'Maint. ON' : 'Maint. OFF'}
                      </button>
                    </div>
                    {editingLimitsKey === f.key ? (
                      <div className="space-y-2 pt-2 border-t border-[#171613]/10 dark:border-white/10">
                        <textarea
                          rows={2}
                          value={editingLimitsJson}
                          onChange={(e) => setEditingLimitsJson(e.target.value)}
                          className="w-full p-2 glass-input rounded-xl font-mono text-[11px]"
                        />
                        <div className="flex gap-2">
                          <GlassButton
                            variant="black"
                            size="sm"
                            onClick={async () => {
                              const parsed = JSON.parse(editingLimitsJson);
                              await api.adminUpdateFeature(f.key, { limits: parsed });
                              setEditingLimitsKey(null);
                              await loadAll();
                            }}
                          >
                            Save Limits
                          </GlassButton>
                          <GlassButton variant="glass" size="sm" onClick={() => setEditingLimitsKey(null)}>
                            Cancel
                          </GlassButton>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between text-[11px] text-[#82796F]">
                        <span className="font-mono truncate">Limits: {JSON.stringify(f.limits)}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingLimitsKey(f.key);
                            setEditingLimitsJson(JSON.stringify(f.limits || {}, null, 2));
                          }}
                          className="text-[#C4718E] font-semibold ml-2 cursor-pointer"
                        >
                          Configure
                        </button>
                      </div>
                    )}
                  </GlassCard>
                ))}
              </div>
            </div>
          )}

          {settingsSubTab === 'security' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <GlassCard tone="cream" padding="lg" className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-serif font-bold text-base flex items-center gap-2">
                      <KeyRound className="w-4 h-4 text-[#C4718E]" />
                      <span>Admin TOTP MFA</span>
                    </h3>
                    <span className="font-mono text-[11px] uppercase">{security?.mfaEnabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  {!security?.mfaEnabled ? (
                    !mfaSetupData ? (
                      <GlassButton
                        variant="pink"
                        size="sm"
                        onClick={async () => {
                          const res = await api.adminSetupMfa();
                          setMfaSetupData(res);
                          if (res.sampleCurrentCode) setMfaVerifyCode(res.sampleCurrentCode);
                        }}
                      >
                        Generate TOTP Secret
                      </GlassButton>
                    ) : (
                      <div className="space-y-2 p-3 rounded-xl bg-[#FFFCF7]/75 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10">
                        <code className="font-mono font-bold block select-all">{mfaSetupData.secret}</code>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={mfaVerifyCode}
                            onChange={(e) => setMfaVerifyCode(e.target.value)}
                            placeholder="6-digit code"
                            maxLength={6}
                            className="flex-1 px-3 py-1.5 glass-input rounded-xl font-mono"
                          />
                          <GlassButton
                            variant="pink"
                            size="sm"
                            onClick={async () => {
                              await api.adminVerifyMfa(mfaVerifyCode);
                              setMfaSetupData(null);
                              setMfaVerifyCode('');
                              showFeedback('Admin MFA verified and activated.');
                              await loadAll();
                            }}
                          >
                            Verify &amp; Enable
                          </GlassButton>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={mfaDisablePassword}
                        onChange={(e) => setMfaDisablePassword(e.target.value)}
                        placeholder="Admin password to disable MFA"
                        className="flex-1 px-3 py-1.5 glass-input rounded-xl"
                      />
                      <GlassButton
                        variant="black"
                        size="sm"
                        onClick={async () => {
                          await api.adminDisableMfa(mfaDisablePassword);
                          setMfaDisablePassword('');
                          showFeedback('Admin MFA disabled.');
                          await loadAll();
                        }}
                      >
                        Disable
                      </GlassButton>
                    </div>
                  )}
                </GlassCard>

                <GlassCard tone="cream" padding="lg" className="space-y-2.5 tabular-nums">
                  <h3 className="font-serif font-bold text-base">Sessions, Rate Limiting &amp; Runtime</h3>
                  <div className="flex justify-between">
                    <span className="text-[#82796F]">Active Sessions / Multi-Device Users</span>
                    <strong className="font-mono">
                      {security?.activeSessionsCount ?? 0} ({security?.usersWithMultipleDevices ?? 0} multi-device)
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#82796F]">Failed Logins / Suspicious / Auth Errors (24h)</span>
                    <strong className="font-mono text-[#C4718E]">
                      {security?.failedLoginAttempts24h ?? 0} / {security?.suspiciousEvents24h ?? 0} / {security?.authErrors24h ?? 0}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#82796F]">Session Policy</span>
                    <strong className="font-mono text-[11px]">
                      {security?.accessTtlMinutes ?? 15}m · {security?.sessionTtlDays ?? 30}d · {security?.sessionMaxLifetimeDays ?? 90}d · {security?.maxActiveDevices ?? 5} dev
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#82796F]">Memory (RSS / Heap)</span>
                    <strong className="font-mono">
                      {stats?.system.memoryRssMb ?? 0} / {stats?.system.heapUsedMb ?? 0} MB
                    </strong>
                  </div>
                  <GlassButton
                    variant="black"
                    size="sm"
                    onClick={async () => {
                      await executeWithReauth('Revoke all other Admin sessions', async () => {
                        const res = await api.adminRevokeSessions();
                        showFeedback(`Revoked ${res.revokedCount} other session(s).`);
                        await loadAll();
                      });
                    }}
                    className="w-full"
                  >
                    Revoke All Other Admin Sessions
                  </GlassButton>
                </GlassCard>
              </div>

              {/* Active Multi-Device Sessions Monitor */}
              <GlassCard tone="cream" padding="none" className="overflow-x-auto">
                <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-serif font-bold text-base">Active Multi-Device Sessions ({adminSessions.length})</div>
                    <div className="text-[11px] text-[#82796F]">
                      Monitor signed-in user devices and remotely sign out compromised or stale sessions.
                    </div>
                  </div>
                  <GlassButton
                    variant="glass"
                    size="sm"
                    onClick={async () => {
                      const list = await api.adminGetSecuritySessions();
                      setAdminSessions(list);
                      showFeedback('Session list refreshed.');
                    }}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Refresh Sessions</span>
                  </GlassButton>
                </div>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                      <th className="p-3">Account</th>
                      <th className="p-3">Device</th>
                      <th className="p-3">IP &amp; Activity</th>
                      <th className="p-3 text-right">Remote Control</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                    {adminSessions.map((s) => (
                      <tr key={s.id}>
                        <td className="p-3">
                          <div className="font-mono font-semibold text-[#171613] dark:text-[#F5EFE3]">
                            {s.handle || s.userId}
                          </div>
                          <div className="text-[11px] text-[#82796F] uppercase font-mono">{s.role || 'student'}</div>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-1.5">
                            {s.deviceType === 'phone' ? (
                              <Smartphone className="w-3.5 h-3.5 text-[#C4718E]" />
                            ) : s.deviceType === 'tablet' ? (
                              <Tablet className="w-3.5 h-3.5 text-[#C4718E]" />
                            ) : (
                              <Laptop className="w-3.5 h-3.5 text-[#C4718E]" />
                            )}
                            <span>{s.deviceName}</span>
                            {s.isCurrent && (
                              <span className="px-1.5 py-0.5 rounded bg-[#D98BA5] text-[#171613] font-mono text-[10px]">
                                Current
                              </span>
                            )}
                            {s.isSuspicious && (
                              <span className="px-1.5 py-0.5 rounded bg-[#171613] text-[#F5EFE3] font-mono text-[10px]">
                                Suspicious
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-3 font-mono text-[11px] text-[#82796F]">
                          <div>IP {s.ipAddress}</div>
                          <div>Last active {new Date(s.lastActiveAt || s.createdAt).toLocaleString()}</div>
                        </td>
                        <td className="p-3 text-right space-x-1.5 whitespace-nowrap">
                          {!s.isCurrent && (
                            <GlassButton
                              variant="glass"
                              size="sm"
                              onClick={async () => {
                                await api.adminRevokeSession(s.id);
                                showFeedback(`Revoked session on ${s.deviceName}.`);
                                await loadAll();
                              }}
                            >
                              Revoke
                            </GlassButton>
                          )}
                          {s.userId && !s.isCurrent && (
                            <GlassButton
                              variant="black"
                              size="sm"
                              onClick={async () => {
                                const res = await api.adminRevokeUserSessions(s.userId!);
                                showFeedback(`Revoked ${res.revokedCount} session(s) for ${s.handle || s.userId}.`);
                                await loadAll();
                              }}
                            >
                              Sign Out User
                            </GlassButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassCard>

              {/* Security Events & Suspicious Activity Feed */}
              <GlassCard tone="cream" padding="none" className="overflow-x-auto">
                <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-serif font-bold text-base">Security Events &amp; Suspicious Alerts</div>
                    <div className="text-[11px] text-[#82796F]">
                      Tracks failed login bursts, token reuse alerts, MFA challenges, and remote session revocations.
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px]">
                    {(['all', 'critical', 'warning', 'info'] as const).map((sev) => (
                      <button
                        key={sev}
                        type="button"
                        onClick={async () => {
                          setSecuritySeverityFilter(sev);
                          const evs = await api.adminGetSecurityEvents(sev);
                          setSecurityEvents(evs);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-mono uppercase cursor-pointer border ${
                          securitySeverityFilter === sev
                            ? 'bg-[#D98BA5] text-[#171613] border-[#D98BA5] font-bold'
                            : 'glass-subtle text-[#82796F] border-[#171613]/10 dark:border-white/10'
                        }`}
                      >
                        {sev}
                      </button>
                    ))}
                  </div>
                </div>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                      <th className="p-3">Severity</th>
                      <th className="p-3">Event</th>
                      <th className="p-3">Account / Identifier</th>
                      <th className="p-3">Context</th>
                      <th className="p-3">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                    {securityEvents.map((ev) => (
                      <tr key={ev.id}>
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 rounded-md font-mono text-[10px] uppercase font-bold ${
                              ev.severity === 'critical'
                                ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#4A2532]'
                                : ev.severity === 'warning'
                                ? 'bg-[#F6E2E6] text-[#171613] border border-[#D98BA5]'
                                : 'glass-subtle text-[#82796F]'
                            }`}
                          >
                            {ev.severity}
                          </span>
                        </td>
                        <td className="p-3 font-mono font-semibold">{ev.eventType}</td>
                        <td className="p-3 font-mono text-[11px]">{ev.handle || ev.identifier || ev.userId || '—'}</td>
                        <td className="p-3 text-[11px] text-[#82796F]">
                          {ev.ipAddress ? `IP ${ev.ipAddress}` : ''}
                          {ev.deviceName ? ` · ${ev.deviceName}` : ''}
                          {Object.keys(ev.details || {}).length > 0 ? ` · ${JSON.stringify(ev.details)}` : ''}
                        </td>
                        <td className="p-3 font-mono text-[11px] text-[#82796F]">
                          {new Date(ev.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {securityEvents.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-[#82796F]">
                          No security events matching filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </GlassCard>

              <GlassCard tone="cream" padding="none" className="overflow-x-auto">
                <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 font-serif font-bold text-base">
                  Immutable Audit Trail
                </div>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] uppercase">
                      <th className="p-3">Actor</th>
                      <th className="p-3">Action</th>
                      <th className="p-3">Target</th>
                      <th className="p-3">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td className="p-3 font-mono">{log.adminHandle}</td>
                        <td className="p-3 font-mono font-semibold">{log.action}</td>
                        <td className="p-3 font-mono text-[11px] text-[#82796F]">{log.targetType}:{log.targetId}</td>
                        <td className="p-3 font-mono text-[11px] text-[#82796F]">{new Date(log.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GlassCard>
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* MODALS */}
      {/* ================================================================= */}
      <GlassModal isOpen={Boolean(editPostTarget)} onClose={() => setEditPostTarget(null)} title="Edit Post / Promotion" maxWidthClass="max-w-md">
        <form onSubmit={handleSaveEditedPost} className="p-5 space-y-3 text-xs">
          <textarea
            required
            rows={4}
            value={editPostForm.content}
            onChange={(e) => setEditPostForm({ ...editPostForm, content: e.target.value })}
            className="w-full p-3 glass-input rounded-xl"
          />
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={editPostForm.isAnnouncement} onChange={(e) => setEditPostForm({ ...editPostForm, isAnnouncement: e.target.checked })} className="accent-[#D98BA5]" />
              <span>Official Announcement</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={editPostForm.isPinned} onChange={(e) => setEditPostForm({ ...editPostForm, isPinned: e.target.checked })} className="accent-[#D98BA5]" />
              <span>Pinned</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={editPostForm.isFeatured} onChange={(e) => setEditPostForm({ ...editPostForm, isFeatured: e.target.checked })} className="accent-[#D98BA5]" />
              <span>Featured</span>
            </label>
          </div>
          <select
            value={editPostForm.distributionScope}
            onChange={(e) => setEditPostForm({ ...editPostForm, distributionScope: e.target.value as any })}
            className="w-full px-3 py-2 glass-input rounded-xl"
          >
            <option value="feed">Main Feed</option>
            <option value="nearby">Nearby Feed</option>
            <option value="all">All Campus Feeds</option>
          </select>
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setEditPostTarget(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="pink" size="sm">Save Post</GlassButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal isOpen={showCreateUserModal} onClose={() => setShowCreateUserModal(false)} title="Create Account" maxWidthClass="max-w-md">
        <form onSubmit={handleCreateUser} className="p-5 space-y-3 text-xs">
          <input required placeholder="Full Name" value={createUserForm.name} onChange={(e) => setCreateUserForm({ ...createUserForm, name: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <input required placeholder="@handle" value={createUserForm.username} onChange={(e) => setCreateUserForm({ ...createUserForm, username: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl font-mono" />
          <input required type="password" placeholder="Strong Password (8+ chars)" value={createUserForm.password} onChange={(e) => setCreateUserForm({ ...createUserForm, password: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <select value={createUserForm.role} onChange={(e) => setCreateUserForm({ ...createUserForm, role: e.target.value as any })} className="w-full px-3.5 py-2.5 glass-input rounded-xl">
            <option value="student">Student</option>
            <option value="staff">Staff</option>
            <option value="moderator">Moderator</option>
          </select>
          <GlassButton type="submit" variant="pink" size="md" className="w-full">Create Account</GlassButton>
        </form>
      </GlassModal>

      <GlassModal isOpen={showAssignModModal} onClose={() => setShowAssignModModal(false)} title="Assign Moderator Role" maxWidthClass="max-w-md">
        <form onSubmit={handleAssignModeratorSubmit} className="p-5 space-y-3 text-xs">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAssignModMode('promote')}
              className={`flex-1 py-2 rounded-xl border cursor-pointer ${
                assignModMode === 'promote' ? 'bg-[#171613] text-[#F5EFE3]' : 'glass-subtle'
              }`}
            >
              Promote Existing User
            </button>
            <button
              type="button"
              onClick={() => setAssignModMode('create')}
              className={`flex-1 py-2 rounded-xl border cursor-pointer ${
                assignModMode === 'create' ? 'bg-[#171613] text-[#F5EFE3]' : 'glass-subtle'
              }`}
            >
              New Moderator Account
            </button>
          </div>

          {assignModMode === 'promote' ? (
            <select
              required
              value={assignModForm.userId}
              onChange={(e) => setAssignModForm({ ...assignModForm, userId: e.target.value })}
              className="w-full px-3.5 py-2.5 glass-input rounded-xl"
            >
              <option value="">Select Student / Staff account...</option>
              {promotableUsers.map((pu) => (
                <option key={pu.id} value={pu.id}>
                  {pu.name} ({pu.handle})
                </option>
              ))}
            </select>
          ) : (
            <div className="space-y-2">
              <input required placeholder="Full Name" value={assignModForm.name} onChange={(e) => setAssignModForm({ ...assignModForm, name: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
              <input required placeholder="@mod_handle" value={assignModForm.username} onChange={(e) => setAssignModForm({ ...assignModForm, username: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl font-mono" />
              <input required type="password" placeholder="Strong Password (8+ chars)" value={assignModForm.password} onChange={(e) => setAssignModForm({ ...assignModForm, password: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            {(
              [
                ['canReviewReports', 'Review Reports'],
                ['canHideContent', 'Hide/Remove Content'],
                ['canWarnUsers', 'Issue Warnings'],
                ['canRestrictUsers', 'Temp Restrictions'],
                ['canReviewCommunities', 'Community Safety'],
                ['canEscalate', 'Escalate to Admin'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(assignModForm[key])}
                  onChange={(e) => setAssignModForm({ ...assignModForm, [key]: e.target.checked })}
                  className="accent-[#D98BA5]"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <span>Max Restriction Window</span>
            <select
              value={assignModForm.maxRestrictionHours}
              onChange={(e) => setAssignModForm({ ...assignModForm, maxRestrictionHours: Number(e.target.value) })}
              className="px-3 py-1.5 glass-input rounded-xl font-mono"
            >
              <option value={24}>24 hours</option>
              <option value={48}>48 hours</option>
              <option value={72}>72 hours</option>
              <option value={168}>7 days</option>
            </select>
          </div>

          <GlassButton type="submit" variant="pink" size="md" className="w-full">
            Save Moderator Assignment
          </GlassButton>
        </form>
      </GlassModal>

      <GlassModal isOpen={showAdModal} onClose={() => setShowAdModal(false)} title={editAdTarget ? 'Edit Campaign' : 'Create Advertisement'} maxWidthClass="max-w-md">
        <form onSubmit={handleSaveAd} className="p-5 space-y-3 text-xs">
          <input required placeholder="Campaign Title" value={adForm.title} onChange={(e) => setAdForm({ ...adForm, title: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
          <input required placeholder="Sponsor Name" value={adForm.sponsorName} onChange={(e) => setAdForm({ ...adForm, sponsorName: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
          <textarea required rows={3} placeholder="Ad copy..." value={adForm.body} onChange={(e) => setAdForm({ ...adForm, body: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
          <input placeholder="Target URL (optional)" value={adForm.targetUrl} onChange={(e) => setAdForm({ ...adForm, targetUrl: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select value={adForm.placement} onChange={(e) => setAdForm({ ...adForm, placement: e.target.value as any })} className="px-2.5 py-2 glass-input rounded-xl">
              <option value="feed">Feed</option>
              <option value="communities">Communities</option>
              <option value="updates">Updates</option>
              <option value="sidebar">Sidebar</option>
            </select>
            <select value={adForm.status} onChange={(e) => setAdForm({ ...adForm, status: e.target.value as any })} className="px-2.5 py-2 glass-input rounded-xl">
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="paused">Paused</option>
              <option value="ended">Ended</option>
            </select>
            <input type="number" min={0} placeholder="Budget NGN" value={adForm.budgetNaira} onChange={(e) => setAdForm({ ...adForm, budgetNaira: Number(e.target.value) })} className="px-2.5 py-2 glass-input rounded-xl font-mono" />
          </div>
          <GlassButton type="submit" variant="pink" size="md" className="w-full">
            {editAdTarget ? 'Save Campaign' : 'Publish Campaign'}
          </GlassButton>
        </form>
      </GlassModal>

      <GlassModal isOpen={showPaymentModal} onClose={() => setShowPaymentModal(false)} title="Record Payment Entry" maxWidthClass="max-w-md">
        <form onSubmit={handleCreatePaymentRecord} className="p-5 space-y-3 text-xs">
          <input type="number" min={100} required placeholder="Amount (NGN)" value={paymentForm.amountNaira} onChange={(e) => setPaymentForm({ ...paymentForm, amountNaira: Number(e.target.value) })} className="w-full px-3.5 py-2 glass-input rounded-xl font-mono" />
          <input placeholder="Payer / Sponsor Name" value={paymentForm.payerName} onChange={(e) => setPaymentForm({ ...paymentForm, payerName: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
          <input placeholder="Reference (auto-generated if empty)" value={paymentForm.reference} onChange={(e) => setPaymentForm({ ...paymentForm, reference: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl font-mono" />
          <div className="grid grid-cols-2 gap-2">
            <select value={paymentForm.purpose} onChange={(e) => setPaymentForm({ ...paymentForm, purpose: e.target.value as any })} className="px-3 py-2 glass-input rounded-xl">
              <option value="campus_trade_listing">Sponsored / Listing</option>
              <option value="ticket">Campus Event Ticket</option>
              <option value="subscription">Partner Invoice</option>
            </select>
            <select value={paymentForm.status} onChange={(e) => setPaymentForm({ ...paymentForm, status: e.target.value as any })} className="px-3 py-2 glass-input rounded-xl">
              <option value="confirmed">Confirmed</option>
              <option value="awaiting_verification">Awaiting Verification</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <textarea rows={2} placeholder="Audit note..." value={paymentForm.note} onChange={(e) => setPaymentForm({ ...paymentForm, note: e.target.value })} className="w-full px-3.5 py-2 glass-input rounded-xl" />
          <GlassButton type="submit" variant="pink" size="md" className="w-full">Save Ledger Record</GlassButton>
        </form>
      </GlassModal>

      <GlassModal isOpen={Boolean(editUserTarget)} onClose={() => setEditUserTarget(null)} title="Edit User Profile" maxWidthClass="max-w-md">
        <form onSubmit={handleSaveUserEdit} className="p-5 space-y-3 text-xs">
          <input required value={editUserForm.name} onChange={(e) => setEditUserForm({ ...editUserForm, name: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" placeholder="Name" />
          <input value={editUserForm.department} onChange={(e) => setEditUserForm({ ...editUserForm, department: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" placeholder="Department" />
          <div className="grid grid-cols-2 gap-2">
            <input value={editUserForm.level} onChange={(e) => setEditUserForm({ ...editUserForm, level: e.target.value })} className="px-3.5 py-2.5 glass-input rounded-xl" placeholder="Level" />
            <input value={editUserForm.hallOfResidence} onChange={(e) => setEditUserForm({ ...editUserForm, hallOfResidence: e.target.value })} className="px-3.5 py-2.5 glass-input rounded-xl" placeholder="Zone" />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={editUserForm.verified} onChange={(e) => setEditUserForm({ ...editUserForm, verified: e.target.checked })} className="accent-[#D98BA5]" />
            <span>Verified Account</span>
          </label>
          <GlassButton type="submit" variant="pink" size="md" className="w-full">Save Changes</GlassButton>
        </form>
      </GlassModal>

      <GlassModal isOpen={Boolean(roleModalTarget)} onClose={() => setRoleModalTarget(null)} title={roleModalTarget ? `Assign Role — ${roleModalTarget.handle}` : 'Assign Role'} maxWidthClass="max-w-sm">
        <div className="p-5 space-y-3 text-xs">
          <select value={selectedNewRole} onChange={(e) => setSelectedNewRole(e.target.value as any)} className="w-full px-3.5 py-2.5 glass-input rounded-xl">
            <option value="student">Student</option>
            <option value="staff">Staff</option>
            <option value="moderator">Moderator</option>
          </select>
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setRoleModalTarget(null)}>Cancel</GlassButton>
            <GlassButton variant="pink" size="sm" onClick={handleAssignRole}>Confirm Role</GlassButton>
          </div>
        </div>
      </GlassModal>

      <GlassModal isOpen={Boolean(warningTarget)} onClose={() => setWarningTarget(null)} title="Issue Warning" maxWidthClass="max-w-md">
        <form onSubmit={handleIssueWarning} className="p-5 space-y-3 text-xs">
          <select value={warningSeverity} onChange={(e) => setWarningSeverity(e.target.value as any)} className="w-full px-3.5 py-2.5 glass-input rounded-xl">
            <option value="minor">Minor Notice</option>
            <option value="standard">Standard Warning</option>
            <option value="severe">Severe Final Warning</option>
          </select>
          <textarea required rows={3} value={warningReason} onChange={(e) => setWarningReason(e.target.value)} placeholder="Warning reason..." className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setWarningTarget(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="pink" size="sm">Send Warning</GlassButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal isOpen={Boolean(suspendTarget)} onClose={() => setSuspendTarget(null)} title="Suspend Account" maxWidthClass="max-w-md">
        <form onSubmit={handleSuspendUser} className="p-5 space-y-3 text-xs">
          <input type="number" min={1} max={365} value={suspendDays} onChange={(e) => setSuspendDays(Number(e.target.value))} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <textarea required rows={3} value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} placeholder="Suspension reason..." className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setSuspendTarget(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="black" size="sm">Confirm Suspension</GlassButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal isOpen={Boolean(deleteUserTarget)} onClose={() => setDeleteUserTarget(null)} title="Delete User Permanently" maxWidthClass="max-w-md">
        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#82796F]">
            Type <code className="font-mono font-bold">PERMANENTLY_DELETE</code> below to confirm permanent erasure.
          </p>
          <input value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} placeholder="PERMANENTLY_DELETE" className="w-full px-3.5 py-2.5 glass-input rounded-xl font-mono" />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setDeleteUserTarget(null)}>Cancel</GlassButton>
            <GlassButton variant="black" size="sm" disabled={deleteConfirmText !== 'PERMANENTLY_DELETE'} onClick={handleDeleteUserPermanently}>
              Erase Permanently
            </GlassButton>
          </div>
        </div>
      </GlassModal>

      <GlassModal isOpen={Boolean(inspectChatTarget)} onClose={() => setInspectChatTarget(null)} title="Logged Chat Inspection" maxWidthClass="max-w-lg">
        <div className="p-5 space-y-3 text-xs">
          {!inspectedMessages ? (
            <form onSubmit={handleInspectChat} className="space-y-3">
              <textarea required minLength={10} rows={3} value={inspectReason} onChange={(e) => setInspectReason(e.target.value)} placeholder="Document moderation reason (10+ characters)..." className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
              <GlassButton type="submit" variant="black" size="md" className="w-full">Log Reason &amp; View Thread</GlassButton>
            </form>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-2">
              {inspectedMessages.map((m) => (
                <div key={m.id} className="p-2.5 rounded-xl bg-[#FFFCF7]/75 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10">
                  <div className="font-mono text-[11px] font-semibold text-[#C4718E]">{m.senderHandle}</div>
                  <div className="mt-0.5">{m.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </GlassModal>

      <GlassModal isOpen={Boolean(editCommTarget)} onClose={() => setEditCommTarget(null)} title="Edit Community" maxWidthClass="max-w-md">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editCommTarget) return;
            await api.adminUpdateCommunity(editCommTarget.id, editCommForm);
            showFeedback(`Updated ${editCommForm.name}.`);
            setEditCommTarget(null);
            await loadAll();
          }}
          className="p-5 space-y-3 text-xs"
        >
          <input required value={editCommForm.name} onChange={(e) => setEditCommForm({ ...editCommForm, name: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <input required value={editCommForm.location} onChange={(e) => setEditCommForm({ ...editCommForm, location: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <textarea required rows={3} value={editCommForm.description} onChange={(e) => setEditCommForm({ ...editCommForm, description: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setEditCommTarget(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="pink" size="sm">Save Community</GlassButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal isOpen={Boolean(appealTarget)} onClose={() => setAppealTarget(null)} title="Decide Appeal" maxWidthClass="max-w-md">
        <div className="p-5 space-y-3 text-xs">
          <select value={appealDecision} onChange={(e) => setAppealDecision(e.target.value as any)} className="w-full px-3.5 py-2.5 glass-input rounded-xl">
            <option value="accepted">Accept Appeal (Restore Account)</option>
            <option value="rejected">Reject Appeal</option>
          </select>
          <textarea rows={3} value={appealNotes} onChange={(e) => setAppealNotes(e.target.value)} placeholder="Decision notes..." className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setAppealTarget(null)}>Cancel</GlassButton>
            <GlassButton
              variant="pink"
              size="sm"
              onClick={async () => {
                if (!appealTarget) return;
                await api.reviewAppeal(appealTarget.id, appealDecision, appealNotes);
                showFeedback(`Appeal ${appealDecision}.`);
                setAppealTarget(null);
                await loadAll();
              }}
            >
              Submit Decision
            </GlassButton>
          </div>
        </div>
      </GlassModal>

      <GlassModal isOpen={Boolean(showCleanOrphansConfirm && storage)} onClose={() => setShowCleanOrphansConfirm(false)} title="Clean Orphaned Files?" maxWidthClass="max-w-md">
        {storage && (
          <div className="p-5 space-y-3 text-xs">
            <p className="text-[#82796F]">
              {storage.orphans.count} unreferenced upload file(s) ({formatBytes(storage.orphans.totalBytes)}) will be removed.
            </p>
            <div className="flex justify-end gap-2">
              <GlassButton variant="glass" size="sm" onClick={() => setShowCleanOrphansConfirm(false)}>Cancel</GlassButton>
              <GlassButton
                variant="pink"
                size="sm"
                onClick={async () => {
                  await executeWithReauth('Clean orphaned upload files', async () => {
                    const res = await api.adminCleanOrphanedFiles();
                    showFeedback(`Cleaned ${res.deletedCount} file(s).`);
                    setShowCleanOrphansConfirm(false);
                    await loadAll();
                  });
                }}
              >
                Confirm Cleanup
              </GlassButton>
            </div>
          </div>
        )}
      </GlassModal>

      <GlassModal isOpen={showAddFeatureModal} onClose={() => setShowAddFeatureModal(false)} title="Register Feature Flag" maxWidthClass="max-w-md">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await api.adminRegisterFeature(newFeatureForm);
            showFeedback(`Registered feature flag "${newFeatureForm.key}".`);
            setShowAddFeatureModal(false);
            setNewFeatureForm({ key: '', name: '', description: '', category: 'discovery' });
            await loadAll();
            await syncPublicConfig();
          }}
          className="p-5 space-y-3 text-xs"
        >
          <input required placeholder="key (e.g. exam_timetable)" value={newFeatureForm.key} onChange={(e) => setNewFeatureForm({ ...newFeatureForm, key: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl font-mono" />
          <input required placeholder="Display Name" value={newFeatureForm.name} onChange={(e) => setNewFeatureForm({ ...newFeatureForm, name: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <textarea required rows={2} placeholder="Description" value={newFeatureForm.description} onChange={(e) => setNewFeatureForm({ ...newFeatureForm, description: e.target.value })} className="w-full px-3.5 py-2.5 glass-input rounded-xl" />
          <select value={newFeatureForm.category} onChange={(e) => setNewFeatureForm({ ...newFeatureForm, category: e.target.value as any })} className="w-full px-3.5 py-2.5 glass-input rounded-xl">
            <option value="core">Core</option>
            <option value="social">Social</option>
            <option value="discovery">Discovery</option>
            <option value="governance">Governance</option>
          </select>
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setShowAddFeatureModal(false)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="pink" size="sm">Register Feature</GlassButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal
        isOpen={Boolean(reauthPendingAction)}
        onClose={() => {
          if (isReauthBusy) return;
          setReauthPendingAction(null);
          setReauthPassword('');
          setReauthError(null);
        }}
        title="Confirm Admin Identity"
        subtitle={reauthPendingAction?.label || 'Sensitive administrative action'}
        maxWidthClass="max-w-sm"
      >
        <div className="p-5 space-y-3.5 text-xs">
          <p className="text-[#82796F] dark:text-[#A89F95] leading-relaxed">
            For security, sensitive administrative changes require recent verification. Confirm with your Admin password or registered passkey to continue.
          </p>
          {reauthError && (
            <div className="p-2.5 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/75 border border-[#D98BA5]/60 text-[#171613] dark:text-[#F5EFE3]">
              {reauthError}
            </div>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!reauthPendingAction || !reauthPassword || isReauthBusy) return;
              setIsReauthBusy(true);
              setReauthError(null);
              try {
                await api.reauthenticate(reauthPassword);
                const pending = reauthPendingAction;
                setReauthPendingAction(null);
                setReauthPassword('');
                await pending.retry();
              } catch (err: any) {
                setReauthError(err?.message || 'Password verification failed.');
              } finally {
                setIsReauthBusy(false);
              }
            }}
            className="space-y-3"
          >
            <GlassInput
              label="Current Admin Password"
              type="password"
              autoComplete="current-password"
              required
              value={reauthPassword}
              onChange={(e) => setReauthPassword(e.target.value)}
              placeholder="Enter Admin password"
              leftIcon={<Lock className="w-4 h-4" />}
            />
            <div className="flex flex-col gap-2">
              <GlassButton type="submit" variant="pink" size="md" disabled={isReauthBusy || !reauthPassword} className="w-full">
                {isReauthBusy ? 'Verifying...' : 'Confirm & Continue'}
              </GlassButton>
              {isPasskeySupported() && (
                <GlassButton
                  type="button"
                  variant="glass"
                  size="sm"
                  disabled={isReauthBusy}
                  onClick={async () => {
                    if (!reauthPendingAction || isReauthBusy) return;
                    setIsReauthBusy(true);
                    setReauthError(null);
                    try {
                      const options = await api.getPasskeyReauthOptions();
                      const assertion = await startAuthentication({ optionsJSON: options });
                      await api.verifyPasskeyReauth(assertion);
                      const pending = reauthPendingAction;
                      setReauthPendingAction(null);
                      setReauthPassword('');
                      await pending.retry();
                    } catch (err: any) {
                      setReauthError(formatPasskeyError(err, 'Passkey verification failed.'));
                    } finally {
                      setIsReauthBusy(false);
                    }
                  }}
                  className="w-full"
                >
                  <Fingerprint className="w-3.5 h-3.5 text-[#C4718E]" />
                  <span>Confirm with Passkey</span>
                </GlassButton>
              )}
            </div>
          </form>
        </div>
      </GlassModal>
    </div>
  );
};

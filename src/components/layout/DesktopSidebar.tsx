import React, { memo } from 'react';
import {
  Bell,
  Feather,
  FileText,
  Home,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sun,
  User,
  UserPlus,
  Users,
} from 'lucide-react';
import { NavigationTab, PlatformConfig, PresenceSummary, StudentProfile } from '../../types';
import { GlassButton, GlassSidebar } from '../glass';
import { SchoolbackdoorLogo } from '../glass/SchoolbackdoorLogo';
import { UserAvatar } from '../common/UserAvatar';
import { useTheme } from '../../utils/useTheme';
import { triggerHaptic } from '../../utils/haptics';

interface DesktopSidebarProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  onOpenCompose: () => void;
  profile: StudentProfile;
  unreadMessagesCount: number;
  unreadNoticesCount: number;
  onlinePresence?: PresenceSummary | null;
  platformConfig?: PlatformConfig | null;
  onOpenAuth?: (mode?: 'login' | 'register') => void;
  onLogout?: () => void;
}

export const DesktopSidebar: React.FC<DesktopSidebarProps> = memo(({
  currentTab,
  onSelectTab,
  onOpenCompose,
  profile,
  unreadMessagesCount,
  unreadNoticesCount,
  onlinePresence,
  platformConfig,
  onOpenAuth,
  onLogout,
}) => {
  const { preference, cycleTheme } = useTheme();
  const isAdmin = profile.role === 'admin';
  const isModerator = profile.role === 'moderator';
  const isAuthenticated = Boolean(profile.userId);

  const isNavFeatureVisible = (key: string) => {
    const feat = platformConfig?.features?.find((f) => f.key === key);
    if (!feat) return true;
    return feat.enabled && feat.visibleInNav;
  };

  const postsFeatureEnabled = platformConfig?.features?.find((f) => f.key === 'posts')?.enabled !== false;
  const globalMaint = platformConfig?.settings?.maintenance_mode === 'true';

  const rawNavItems: { tab: NavigationTab; label: string; icon: React.ReactNode; badge?: number; featureKey?: string }[] = [
    { tab: 'home', label: 'Home Feed', icon: <Home className="w-[18px] h-[18px]" />, featureKey: 'posts' },
    { tab: 'updates', label: 'Updates & Landmarks', icon: <Bell className="w-[18px] h-[18px]" />, badge: unreadNoticesCount, featureKey: 'updates' },
    { tab: 'chats', label: 'Messages & Chats', icon: <MessageSquare className="w-[18px] h-[18px]" />, badge: unreadMessagesCount, featureKey: 'chats' },
    { tab: 'communities', label: 'Communities', icon: <Users className="w-[18px] h-[18px]" />, featureKey: 'communities' },
    { tab: 'profile', label: 'Profile', icon: <User className="w-[18px] h-[18px]" /> },
    ...(isAdmin
      ? [
          {
            tab: 'admin' as NavigationTab,
            label: 'Admin Dashboard',
            icon: <ShieldAlert className="w-[18px] h-[18px] text-[#D98BA5]" />,
          },
        ]
      : []),
    ...(isModerator
      ? [
          {
            tab: 'mod' as NavigationTab,
            label: 'Moderator Desk',
            icon: <ShieldCheck className="w-[18px] h-[18px] text-[#D98BA5]" />,
          },
        ]
      : []),
    { tab: 'policies', label: 'Guidelines & Policies', icon: <FileText className="w-[18px] h-[18px]" /> },
    { tab: 'settings', label: 'Settings', icon: <Settings className="w-[18px] h-[18px]" /> },
  ];
  const navItems = rawNavItems.filter((item) => !item.featureKey || isAdmin || isNavFeatureVisible(item.featureKey));

  const siteName = platformConfig?.settings?.site_name || 'Schoolbackdoor';
  const campusZone = platformConfig?.settings?.campus_zone?.split('·')[0]?.trim() || 'Independent Student Network';

  const ThemeIcon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  const themeLabel =
    preference === 'dark' ? 'Dark' : preference === 'light' ? 'Light' : 'System';

  return (
    <GlassSidebar className="hidden md:flex flex-col w-64 lg:w-72 shrink-0 h-screen sticky top-0 px-4 py-5 justify-between select-none">
      <div className="flex flex-col gap-5 overflow-y-auto pr-0.5">
        {/* Brand Masthead */}
        <div className="flex flex-col pb-4 border-b border-[#F5EFE3]/12">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                onSelectTab('home');
              }}
              className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer rounded-xl p-1 -m-1 hover:bg-[#FFFCF7]/6 transition-colors"
            >
              <SchoolbackdoorLogo variant="light" size="md" />
              <div className="min-w-0">
                <div className="font-serif text-lg font-bold tracking-tight text-[#F5EFE3] truncate leading-tight">
                  {siteName}
                </div>
                <div className="text-[11px] text-[#A89F95] truncate">{campusZone}</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                cycleTheme();
              }}
              title={`Appearance: ${themeLabel} (click to switch)`}
              aria-label={`Appearance mode: ${themeLabel}. Click to switch theme`}
              className="w-9 h-9 rounded-xl bg-[#FFFCF7]/8 hover:bg-[#FFFCF7]/15 border border-[#FFFCF7]/12 text-[#F5EFE3]/85 hover:text-[#D98BA5] flex items-center justify-center shrink-0 transition-colors cursor-pointer"
            >
              <ThemeIcon className="w-4 h-4" />
            </button>
          </div>

          {onlinePresence && (
            <div className="flex items-center gap-2 mt-3 px-2.5 py-1.5 rounded-xl bg-[#FFFCF7]/7 border border-[#FFFCF7]/10 text-[11px] text-[#F5EFE3]/90 tabular-nums">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  onlinePresence.onlineCount > 0 ? 'bg-[#D98BA5] shadow-[0_0_8px_#D98BA5]' : 'bg-[#82796F]'
                }`}
                aria-hidden="true"
              />
              <span className="truncate">{onlinePresence.message}</span>
            </div>
          )}
        </div>

        {/* Primary Action Button */}
        {(postsFeatureEnabled || isAdmin) && (!globalMaint || isAdmin) && (
          <GlassButton variant="pink" onClick={onOpenCompose} className="w-full justify-center">
            <Feather className="w-4 h-4 text-[#171613]" />
            <span>New Post</span>
          </GlassButton>
        )}

        {/* Navigation List */}
        <nav className="flex flex-col gap-1" aria-label="Main Navigation">
          {navItems.map((item) => {
            const isActive = currentTab === item.tab;
            return (
              <button
                key={item.tab}
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  onSelectTab(item.tab);
                }}
                aria-current={isActive ? 'page' : undefined}
                className={`group flex items-center justify-between w-full min-h-[42px] px-3.5 py-2.5 rounded-xl text-xs lg:text-[13px] transition-all text-left cursor-pointer ${
                  isActive
                    ? 'glass-pink text-[#171613] font-semibold'
                    : 'text-[#F5EFE3]/80 hover:text-[#F5EFE3] hover:bg-[#FFFCF7]/8 font-medium'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={isActive ? 'text-[#171613]' : 'text-[#A89F95] group-hover:text-[#F5EFE3]'}>
                    {item.icon}
                  </span>
                  <span className="truncate">{item.label}</span>
                </div>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className={`text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-md font-bold ${
                      isActive ? 'bg-[#171613] text-[#F5EFE3]' : 'bg-[#D98BA5] text-[#171613]'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Identity Glass Card */}
      <div className="pt-3.5 mt-3 border-t border-[#F5EFE3]/12 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => {
            triggerHaptic('tap');
            onSelectTab('profile');
          }}
          className="flex items-center gap-2.5 w-full p-2 rounded-xl bg-[#FFFCF7]/6 hover:bg-[#FFFCF7]/12 border border-[#FFFCF7]/10 transition-colors text-left cursor-pointer"
        >
          <UserAvatar
            name={profile.name}
            initials={profile.avatarInitials || 'SB'}
            bg="bg-[#D98BA5] text-[#171613]"
            avatarUrl={profile.avatarUrl}
            avatarThumbUrl={profile.avatarThumbUrl}
            size="md"
          />
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="text-xs font-semibold text-[#F5EFE3] truncate">{profile.name}</span>
              {profile.verified !== false && (
                <ShieldCheck className="w-3.5 h-3.5 text-[#D98BA5] shrink-0" />
              )}
            </div>
            <div className="text-[11px] text-[#A89F95] truncate font-mono">{profile.handle}</div>
          </div>
        </button>

        <div className="flex items-center justify-between px-1 text-[11px] text-[#A89F95]">
          {onOpenAuth && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                onOpenAuth(isAuthenticated ? 'login' : 'register');
              }}
              className="hover:text-[#D98BA5] transition-colors flex items-center gap-1 py-1 cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{isAuthenticated ? 'Switch Account' : 'Sign In'}</span>
            </button>
          )}
          {isAuthenticated && onLogout && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                onLogout();
              }}
              className="hover:text-[#F6E2E6] transition-colors flex items-center gap-1 py-1 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          )}
        </div>
      </div>
    </GlassSidebar>
  );
});

DesktopSidebar.displayName = 'DesktopSidebar';

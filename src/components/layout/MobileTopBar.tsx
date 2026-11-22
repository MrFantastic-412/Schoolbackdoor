import React, { memo } from 'react';
import { Monitor, Moon, Settings, ShieldAlert, ShieldCheck, Sun, User, Users } from 'lucide-react';
import { NavigationTab, StudentProfile } from '../../types';
import { SchoolbackdoorLogo } from '../glass/SchoolbackdoorLogo';
import { useTheme } from '../../utils/useTheme';
import { triggerHaptic } from '../../utils/haptics';

interface MobileTopBarProps {
  currentTab: NavigationTab;
  onSelectTab?: (tab: NavigationTab) => void;
  onOpenSettings: () => void;
  profile?: StudentProfile;
  onOpenAuth?: (mode?: 'login' | 'register') => void;
}

export const MobileTopBar: React.FC<MobileTopBarProps> = memo(({
  currentTab,
  onSelectTab,
  onOpenSettings,
  profile,
  onOpenAuth,
}) => {
  const isAdmin = profile?.role === 'admin';
  const isModerator = profile?.role === 'moderator';
  const { preference, cycleTheme } = useTheme();
  const ThemeIcon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  const themeLabel =
    preference === 'dark' ? 'Dark' : preference === 'light' ? 'Light' : 'System';

  const getTabLabel = (tab: NavigationTab) => {
    switch (tab) {
      case 'home':
        return 'Home Feed';
      case 'updates':
        return 'Updates & Landmarks';
      case 'chats':
        return 'Messages';
      case 'communities':
        return 'Communities';
      case 'profile':
        return 'Profile';
      case 'settings':
        return 'Settings';
      case 'admin':
        return 'Admin Console';
      case 'mod':
        return 'Moderator Desk';
      case 'policies':
        return 'Policies & Safety';
      default:
        return 'Schoolbackdoor';
    }
  };

  return (
    <header className="md:hidden sticky top-0 z-30 flex items-center justify-between gap-2 px-2.5 sm:px-3.5 pt-[env(safe-area-inset-top)] min-h-[56px] glass-cream border-x-0 border-t-0 rounded-none">
      <button
        type="button"
        onClick={() => {
          triggerHaptic('tap');
          onSelectTab?.('home');
        }}
        className="flex items-center gap-2 min-w-0 text-left cursor-pointer py-1.5"
      >
        <SchoolbackdoorLogo variant="dark" size="sm" />
        <div className="flex flex-col min-w-0">
          <span className="font-serif font-bold text-sm sm:text-base text-[#171613] dark:text-[#F5EFE3] truncate leading-tight">
            Schoolbackdoor
          </span>
          <span className="text-[10px] text-[#82796F] dark:text-[#A89F95] font-sans truncate">
            {getTabLabel(currentTab)}
            <span className="hidden sm:inline"> · Independent Network</span>
          </span>
        </div>
      </button>

      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
        {onSelectTab && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onSelectTab('communities');
            }}
            aria-label="Open Communities"
            className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
              currentTab === 'communities'
                ? 'bg-[#D98BA5] text-[#171613]'
                : 'text-[#171613]/75 dark:text-[#F5EFE3]/80 hover:bg-[#E8DDCC]/70 dark:hover:bg-[#23211C]'
            }`}
          >
            <Users className="w-[18px] h-[18px]" />
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            triggerHaptic('tap');
            cycleTheme();
          }}
          title={`Theme: ${themeLabel}`}
          aria-label={`Appearance mode: ${themeLabel}. Tap to switch theme`}
          className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-[#171613]/75 dark:text-[#F5EFE3]/85 hover:bg-[#E8DDCC]/70 dark:hover:bg-[#23211C] transition-colors cursor-pointer"
        >
          <ThemeIcon className="w-[17px] h-[17px]" />
        </button>

        {isAdmin && onSelectTab && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onSelectTab('admin');
            }}
            aria-label="Open Admin Dashboard"
            className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
              currentTab === 'admin'
                ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#D98BA5]'
                : 'text-[#171613] dark:text-[#F5EFE3] hover:bg-[#D98BA5]/25'
            }`}
          >
            <ShieldAlert className="w-[18px] h-[18px]" />
          </button>
        )}

        {isModerator && onSelectTab && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onSelectTab('mod');
            }}
            aria-label="Open Moderator Desk"
            className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
              currentTab === 'mod'
                ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#D98BA5]'
                : 'text-[#171613] dark:text-[#F5EFE3] hover:bg-[#D98BA5]/25'
            }`}
          >
            <ShieldCheck className="w-[18px] h-[18px]" />
          </button>
        )}

        {onOpenAuth && !profile?.userId && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onOpenAuth('register');
            }}
            className="h-9 flex items-center gap-1 px-2.5 sm:px-3 rounded-xl bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] text-[11px] font-semibold whitespace-nowrap cursor-pointer"
            title="Sign in or create free account"
          >
            <User className="w-3 h-3 text-[#D98BA5]" />
            <span>Sign In</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            triggerHaptic('tap');
            onOpenSettings();
          }}
          aria-label="Open preferences"
          className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
            currentTab === 'settings'
              ? 'bg-[#D98BA5] text-[#171613]'
              : 'text-[#171613]/75 dark:text-[#F5EFE3]/80 hover:bg-[#E8DDCC]/70 dark:hover:bg-[#23211C]'
          }`}
        >
          <Settings className="w-[18px] h-[18px]" />
        </button>
      </div>
    </header>
  );
});

MobileTopBar.displayName = 'MobileTopBar';

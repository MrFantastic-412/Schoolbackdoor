import React, { memo } from 'react';
import { Bell, Home, MessageSquare, Plus, User } from 'lucide-react';
import { NavigationTab, PlatformConfig } from '../../types';
import { GlassNavigation } from '../glass';
import { triggerHaptic } from '../../utils/haptics';

interface MobileBottomNavProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  onOpenCompose: () => void;
  unreadMessagesCount: number;
  unreadNoticesCount: number;
  platformConfig?: PlatformConfig | null;
  isAdmin?: boolean;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = memo(({
  currentTab,
  onSelectTab,
  onOpenCompose,
  unreadMessagesCount,
  unreadNoticesCount,
  platformConfig,
  isAdmin = false,
}) => {
  const isNavFeatureVisible = (key: string) => {
    const feat = platformConfig?.features?.find((f) => f.key === key);
    if (!feat) return true;
    return feat.enabled && feat.visibleInNav;
  };
  const postsEnabled = platformConfig?.features?.find((f) => f.key === 'posts')?.enabled !== false;
  const globalMaint = platformConfig?.settings?.maintenance_mode === 'true';
  const canCreate = (postsEnabled || isAdmin) && (!globalMaint || isAdmin);

  type MobileNavTab = {
    id: NavigationTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    featureKey?: string;
  };

  const leftTabs: MobileNavTab[] = (
    [
      { id: 'home', label: 'Home', icon: <Home className="w-5 h-5" />, featureKey: 'posts' },
      { id: 'updates', label: 'Updates', icon: <Bell className="w-5 h-5" />, badge: unreadNoticesCount, featureKey: 'updates' },
    ] satisfies MobileNavTab[]
  ).filter((t) => !t.featureKey || isAdmin || isNavFeatureVisible(t.featureKey));

  const rightTabs: MobileNavTab[] = (
    [
      { id: 'chats', label: 'Chats', icon: <MessageSquare className="w-5 h-5" />, badge: unreadMessagesCount, featureKey: 'chats' },
      { id: 'profile', label: 'Profile', icon: <User className="w-5 h-5" /> },
    ] satisfies MobileNavTab[]
  ).filter((t) => !t.featureKey || isAdmin || isNavFeatureVisible(t.featureKey));

  const renderTabButton = (tab: { id: NavigationTab; label: string; icon: React.ReactNode; badge?: number }) => {
    const isActive = currentTab === tab.id;
    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => {
          triggerHaptic('tap');
          onSelectTab(tab.id);
        }}
        aria-current={isActive ? 'page' : undefined}
        className={`flex-1 min-h-[48px] rounded-xl flex flex-col items-center justify-center gap-0.5 py-1 px-1 cursor-pointer transition-all relative ${
          isActive
            ? 'bg-[#D98BA5]/25 text-[#171613] dark:text-[#F5EFE3]'
            : 'text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
        }`}
      >
        <div className="relative">
          <span className={isActive ? 'text-[#171613] dark:text-[#F5EFE3]' : 'text-[#82796F] dark:text-[#A89F95]'}>
            {tab.icon}
          </span>
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="absolute -top-1.5 -right-2 text-[9px] font-mono font-bold min-w-[16px] h-4 px-1 rounded-md bg-[#D98BA5] text-[#171613] border border-[#FFFCF7] dark:border-[#181714] flex items-center justify-center tabular-nums">
              {tab.badge}
            </span>
          )}
        </div>
        <span
          className={`text-[10px] tracking-tight leading-none ${
            isActive ? 'font-bold text-[#171613] dark:text-[#F5EFE3]' : 'font-medium text-[#82796F] dark:text-[#A89F95]'
          }`}
        >
          {tab.label}
        </span>
      </button>
    );
  };

  return (
    <div className="md:hidden fixed bottom-3 left-3 right-3 z-30 pb-[env(safe-area-inset-bottom)] pointer-events-none">
      <GlassNavigation className="pointer-events-auto max-w-md mx-auto gap-1.5">
        {leftTabs.map(renderTabButton)}

        {canCreate && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onOpenCompose();
            }}
            aria-label="Create post"
            className="glass-pink text-[#171613] w-12 h-12 rounded-xl flex items-center justify-center shrink-0 mx-0.5 active:scale-95 transition-transform cursor-pointer"
          >
            <Plus className="w-5 h-5 stroke-[2.5]" />
          </button>
        )}

        {rightTabs.map(renderTabButton)}
      </GlassNavigation>
    </div>
  );
});

MobileBottomNav.displayName = 'MobileBottomNav';

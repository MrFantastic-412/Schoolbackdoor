import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Flag,
  History,
  Lock,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserX,
  X,
} from 'lucide-react';
import {
  ModerationHistoryEntry,
  ModeratorCommunityReviewData,
  ModeratorDashboardData,
  ModeratorReportItem,
  NavigationTab,
  StudentProfile,
} from '../types';
import { api } from '../api/client';
import { GlassButton, GlassCard, GlassModal } from '../components/glass';
import { triggerHaptic } from '../utils/haptics';

interface ModeratorPageProps {
  profile: StudentProfile;
  onNavigateToTab?: (tab: NavigationTab) => void;
  latestReport?: any;
}

type ModTab = 'reports' | 'communities' | 'history';

export const ModeratorPage: React.FC<ModeratorPageProps> = ({
  profile,
  onNavigateToTab,
  latestReport,
}) => {
  const isAuthorized = profile.role === 'moderator' || profile.role === 'admin';
  const [activeTab, setActiveTab] = useState<ModTab>('reports');
  const [isLoading, setIsLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ msg: string; isErr: boolean } | null>(null);

  const [dashboard, setDashboard] = useState<ModeratorDashboardData | null>(null);
  const [reports, setReports] = useState<ModeratorReportItem[]>([]);
  const [reportStatusFilter, setReportStatusFilter] = useState<'all' | 'pending' | 'reviewed' | 'resolved' | 'dismissed'>('pending');
  const [reportScope, setReportScope] = useState<'all' | 'assigned' | 'escalated'>('all');
  const [communityReview, setCommunityReview] = useState<ModeratorCommunityReviewData>({
    flaggedPosts: [],
    communities: [],
  });
  const [history, setHistory] = useState<ModerationHistoryEntry[]>([]);
  const [historyScope, setHistoryScope] = useState<'mine' | 'team'>('mine');

  // Action Modals
  const [escalateTarget, setEscalateTarget] = useState<ModeratorReportItem | null>(null);
  const [escalateReason, setEscalateReason] = useState('');

  const [warnTarget, setWarnTarget] = useState<{ userId: string; handle: string } | null>(null);
  const [warnSeverity, setWarnSeverity] = useState<'minor' | 'standard' | 'severe'>('standard');
  const [warnReason, setWarnReason] = useState('');

  const [restrictTarget, setRestrictTarget] = useState<{ userId: string; handle: string } | null>(null);
  const [restrictHours, setRestrictHours] = useState(24);
  const [restrictReason, setRestrictReason] = useState('');

  const showToast = useCallback((msg: string, isErr = false) => {
    triggerHaptic(isErr ? 'error' : 'success');
    setFeedback({ msg, isErr });
    setTimeout(() => setFeedback(null), 4200);
  }, []);

  const loadData = useCallback(async () => {
    if (!isAuthorized) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const [dashRes, reportsRes, historyRes] = await Promise.all([
        api.modGetDashboard(),
        api.modListReports({
          status: reportStatusFilter === 'all' ? undefined : reportStatusFilter,
          scope: reportScope,
        }),
        api.modGetHistory(historyScope),
      ]);
      setDashboard(dashRes);
      setReports(reportsRes);
      setHistory(historyRes);

      if (dashRes?.permissions?.canReviewCommunities) {
        const commRes = await api.modListCommunities();
        setCommunityReview(commRes);
      }
    } catch (err: any) {
      showToast(err?.message || 'Unable to load Moderator Desk.', true);
    } finally {
      setIsLoading(false);
    }
  }, [historyScope, isAuthorized, reportScope, reportStatusFilter, showToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!latestReport || !isAuthorized) return;
    loadData();
  }, [isAuthorized, latestReport, loadData]);

  if (!isAuthorized) {
    return (
      <div className="max-w-xl mx-auto my-12 px-4">
        <GlassCard tone="strong" padding="lg" className="text-center">
          <div className="w-12 h-12 rounded-2xl bg-[#F6E2E6] dark:bg-[#4A2532]/75 border border-[#D98BA5]/40 flex items-center justify-center mx-auto mb-3">
            <ShieldAlert className="w-6 h-6 text-[#C4718E] dark:text-[#E5A4BA]" />
          </div>
          <h2 className="font-serif text-xl font-bold text-[#171613] dark:text-[#F5EFE3]">
            Moderator Role Required
          </h2>
          <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-2 leading-relaxed">
            The Schoolbackdoor Moderator Desk is restricted to authorized Moderator accounts assigned by the Admin.
          </p>
          {onNavigateToTab && (
            <GlassButton variant="black" size="sm" onClick={() => onNavigateToTab('home')} className="mt-5">
              Return to Feed
            </GlassButton>
          )}
        </GlassCard>
      </div>
    );
  }

  const perms = dashboard?.permissions;
  const maxHours = perms?.maxRestrictionHours ?? 24;

  const activeCapabilities = [
    perms?.canReviewReports && 'Reports Review',
    perms?.canHideContent && 'Content Removal',
    perms?.canWarnUsers && 'Warnings',
    perms?.canRestrictUsers && `Temp Restrict (≤${maxHours}h)`,
    perms?.canReviewCommunities && 'Community Safety',
    perms?.canEscalate && 'Admin Escalation',
  ].filter(Boolean) as string[];

  return (
    <div className="w-full max-w-6xl mx-auto px-3 sm:px-5 py-6">
      {/* Header */}
      <GlassCard tone="cream" padding="md" className="mb-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
              <ShieldCheck className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
              <span>Scoped Safety &amp; Community Moderation</span>
            </div>
            <h1 className="font-serif text-2xl sm:text-3xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
              Moderator Desk
            </h1>
            <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-1">
              Signed in as <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">{profile.name}</span> ({profile.handle})
              {activeCapabilities.length > 0 && ` · Active scope: ${activeCapabilities.join(' · ')}`}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onNavigateToTab && (
              <GlassButton variant="glass" size="sm" onClick={() => onNavigateToTab('settings')}>
                <Lock className="w-3.5 h-3.5" />
                <span>2FA &amp; Devices</span>
              </GlassButton>
            )}
            {profile.role === 'admin' && onNavigateToTab && (
              <GlassButton variant="glass" size="sm" onClick={() => onNavigateToTab('admin')}>
                Admin Console
              </GlassButton>
            )}
            <GlassButton variant="pink" size="sm" onClick={loadData} disabled={isLoading}>
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </GlassButton>
          </div>
        </div>
      </GlassCard>

      {feedback && (
        <div
          className={`mb-4 p-3.5 rounded-2xl text-xs flex items-center justify-between gap-2 animate-sb-in ${
            feedback.isErr
              ? 'glass-dark text-[#F5EFE3]'
              : 'glass-pink-tint border border-[#D98BA5]/50 text-[#171613] dark:text-[#F5EFE3]'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.isErr ? (
              <AlertTriangle className="w-4 h-4 text-[#D98BA5] shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
            )}
            <span className="font-medium">{feedback.msg}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <GlassCard tone="cream" padding="md">
          <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">Pending Reports</div>
          <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
            {dashboard?.stats.pendingReports ?? 0}
          </div>
          <div className="text-[11px] text-[#C4718E] dark:text-[#E5A4BA] mt-0.5">Awaiting review</div>
        </GlassCard>

        <GlassCard tone="cream" padding="md">
          <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">Escalated to Admin</div>
          <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
            {dashboard?.stats.escalatedReports ?? 0}
          </div>
          <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5">High-severity cases</div>
        </GlassCard>

        <GlassCard tone="cream" padding="md">
          <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">Restricted Accounts</div>
          <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
            {dashboard?.stats.activeRestrictedUsers ?? 0}
          </div>
          <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5">Currently cooling down</div>
        </GlassCard>

        <GlassCard tone="cream" padding="md">
          <div className="text-[11px] font-medium text-[#82796F] dark:text-[#A89F95]">My Logged Actions</div>
          <div className="text-2xl font-serif font-bold text-[#171613] dark:text-[#F5EFE3] mt-1 tabular-nums">
            {dashboard?.stats.myActionsCount ?? 0}
          </div>
          <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5 tabular-nums">
            {dashboard?.stats.myHandledReports ?? 0} reports handled
          </div>
        </GlassCard>
      </div>

      {/* Role Boundary Banner */}
      <div className="mb-5 p-3 rounded-xl border border-[#171613]/10 dark:border-white/10 bg-[#FFFCF7]/70 dark:bg-white/5 text-xs text-[#82796F] dark:text-[#A89F95] flex items-center gap-2.5">
        <Lock className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
        <span>
          Moderation scope enforces strict privacy: full user records, financial/ad ledgers, platform settings, and unflagged private direct messages are restricted to the Admin role.
        </span>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 pb-3 mb-5 border-b border-[#171613]/10 dark:border-white/10">
        {[
          { id: 'reports' as ModTab, label: 'Reports & Escalations', icon: <Scale className="w-3.5 h-3.5" /> },
          ...(perms?.canReviewCommunities
            ? [{ id: 'communities' as ModTab, label: 'Flagged Communities', icon: <Building2 className="w-3.5 h-3.5" /> }]
            : []),
          { id: 'history' as ModTab, label: 'Moderation History', icon: <History className="w-3.5 h-3.5" /> },
        ].map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                setActiveTab(t.id);
              }}
              className={`px-3.5 py-2 min-h-[38px] rounded-xl text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer border transition-colors ${
                active
                  ? 'glass-pink text-[#171613] border-[#D98BA5]/60 font-semibold'
                  : 'glass-subtle text-[#82796F] dark:text-[#A89F95] border-[#171613]/10 dark:border-white/10 hover:text-[#171613] dark:hover:text-[#F5EFE3]'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* 1. REPORTS QUEUE */}
      {activeTab === 'reports' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {(['pending', 'all', 'reviewed', 'resolved', 'dismissed'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setReportStatusFilter(st)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize cursor-pointer border whitespace-nowrap ${
                    reportStatusFilter === st
                      ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-transparent'
                      : 'bg-[#FFFCF7]/75 dark:bg-white/5 text-[#82796F] dark:text-[#A89F95] border-[#171613]/10 dark:border-white/10'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>

            <div className="flex gap-1.5">
              {(['all', 'assigned', 'escalated'] as const).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  onClick={() => setReportScope(sc)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize cursor-pointer border whitespace-nowrap ${
                    reportScope === sc
                      ? 'bg-[#D98BA5] text-[#171613] border-[#C4718E]/40 font-semibold'
                      : 'bg-[#FFFCF7]/75 dark:bg-white/5 text-[#82796F] dark:text-[#A89F95] border-[#171613]/10 dark:border-white/10'
                  }`}
                >
                  {sc === 'all' ? 'All Cases' : sc === 'assigned' ? 'Assigned to Me' : 'Escalated'}
                </button>
              ))}
            </div>
          </div>

          {reports.length === 0 ? (
            <GlassCard tone="cream" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
              No moderation reports match the selected filters.
            </GlassCard>
          ) : (
            <div className="space-y-3">
              {reports.map((r) => {
                const preview = r.targetPreview;
                const isProtectedTarget = preview?.authorRole === 'admin' || preview?.authorRole === 'moderator';
                return (
                  <GlassCard key={r.id} tone="cream" padding="md" className="space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-[#171613] dark:text-[#F5EFE3]">
                        <Flag className="w-3.5 h-3.5 text-[#C4718E]" />
                        <span className="font-mono font-semibold uppercase text-[11px]">
                          {r.target_type} · {r.reason}
                        </span>
                        {r.escalated_to_admin && (
                          <span className="text-[11px] font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                            · Escalated to Admin
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[11px] uppercase text-[#82796F] dark:text-[#A89F95]">
                        Status: {r.status}
                      </span>
                    </div>

                    <p className="text-[#82796F] dark:text-[#A89F95]">
                      {r.details || 'No additional reporter statement.'}
                    </p>

                    {preview?.exists && (
                      <div className="p-3 rounded-xl bg-[#FFFCF7]/80 dark:bg-white/5 border border-[#171613]/10 dark:border-white/10 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#82796F] dark:text-[#A89F95]">
                          <span>
                            Author: <strong className="text-[#171613] dark:text-[#F5EFE3]">{preview.authorName}</strong>{' '}
                            <span className="font-mono">({preview.authorHandle})</span>
                            {preview.warningsCount !== undefined && ` · Warnings: ${preview.warningsCount}`}
                          </span>
                          <span className="font-mono">
                            {preview.isHidden ? 'Hidden from feed' : 'Visible'}
                          </span>
                        </div>
                        {preview.snippet && (
                          <p className="text-xs text-[#171613] dark:text-[#F5EFE3] line-clamp-3">{preview.snippet}</p>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#171613]/10 dark:border-white/10">
                      <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">
                        Reporter: {r.reporter_handle || r.reporter_id} · Target: {r.target_id}
                      </span>

                      <div className="flex flex-wrap gap-1.5">
                        {perms?.canHideContent && r.target_type === 'post' && preview?.exists && !isProtectedTarget && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await api.modModerateContent(
                                  'post',
                                  r.target_id,
                                  preview.isHidden ? 'unhide' : 'hide',
                                  `Moderation action via report ${r.id}`
                                );
                                showToast(preview.isHidden ? 'Post restored.' : 'Violating post hidden.');
                                await loadData();
                              } catch (err: any) {
                                showToast(err.message, true);
                              }
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] font-medium flex items-center gap-1 cursor-pointer"
                          >
                            {preview.isHidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                            <span>{preview.isHidden ? 'Unhide Post' : 'Hide Post'}</span>
                          </button>
                        )}

                        {perms?.canWarnUsers && preview?.targetUserId && !isProtectedTarget && (
                          <button
                            type="button"
                            onClick={() => {
                              setWarnTarget({
                                userId: preview.targetUserId!,
                                handle: preview.authorHandle || '@student',
                              });
                              setWarnReason('');
                              setWarnSeverity('standard');
                            }}
                            className="px-2.5 py-1.5 rounded-lg border border-[#D98BA5]/50 bg-[#F6E2E6]/75 dark:bg-[#4A2532]/70 text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
                          >
                            Warn
                          </button>
                        )}

                        {perms?.canRestrictUsers && preview?.targetUserId && !isProtectedTarget && (
                          <button
                            type="button"
                            onClick={() => {
                              setRestrictTarget({
                                userId: preview.targetUserId!,
                                handle: preview.authorHandle || '@student',
                              });
                              setRestrictHours(Math.min(24, maxHours));
                              setRestrictReason('');
                            }}
                            className="px-2.5 py-1.5 rounded-lg border border-[#171613]/15 dark:border-white/15 bg-[#E8DDCC]/75 dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3] flex items-center gap-1 cursor-pointer"
                          >
                            <UserX className="w-3 h-3" />
                            <span>Restrict (≤{maxHours}h)</span>
                          </button>
                        )}

                        {r.status !== 'resolved' && r.status !== 'dismissed' && perms?.canReviewReports && (
                          <>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await api.modReviewReport(r.id, 'resolved', 'Resolved by Moderator review');
                                  showToast('Report marked resolved.');
                                  await loadData();
                                } catch (err: any) {
                                  showToast(err.message, true);
                                }
                              }}
                              className="px-2.5 py-1.5 rounded-lg bg-[#D98BA5] text-[#171613] font-semibold cursor-pointer"
                            >
                              Resolve
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await api.modReviewReport(r.id, 'dismissed', 'No violation found by Moderator');
                                  showToast('Report dismissed.');
                                  await loadData();
                                } catch (err: any) {
                                  showToast(err.message, true);
                                }
                              }}
                              className="px-2.5 py-1.5 rounded-lg border border-[#171613]/15 dark:border-white/15 text-[#82796F] dark:text-[#A89F95] cursor-pointer"
                            >
                              Dismiss
                            </button>
                          </>
                        )}

                        {perms?.canEscalate && !r.escalated_to_admin && (
                          <button
                            type="button"
                            onClick={() => {
                              setEscalateTarget(r);
                              setEscalateReason('');
                            }}
                            className="px-2.5 py-1.5 rounded-lg border border-[#C4718E]/60 text-[#C4718E] dark:text-[#E5A4BA] flex items-center gap-1 cursor-pointer"
                          >
                            <ArrowUpRight className="w-3 h-3" />
                            <span>Escalate to Admin</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 2. FLAGGED COMMUNITIES REVIEW */}
      {activeTab === 'communities' && (
        <div className="space-y-5">
          <div className="space-y-3">
            <h2 className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3]">
              Flagged Community Content
            </h2>
            {communityReview.flaggedPosts.length === 0 ? (
              <GlassCard tone="cream" padding="lg" className="text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                No flagged community posts awaiting safety review.
              </GlassCard>
            ) : (
              communityReview.flaggedPosts.map((fp) => (
                <GlassCard key={fp.postId} tone="cream" padding="md" className="text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-1 flex-1">
                    <div className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95]">
                      {fp.communityName} ({fp.communityAcronym}) · {fp.authorHandle} · {fp.reportsCount} report(s)
                    </div>
                    <p className="text-[#171613] dark:text-[#F5EFE3]">{fp.content}</p>
                  </div>
                  {perms?.canHideContent && (
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.modModerateContent(
                              'post',
                              fp.postId,
                              fp.isHidden ? 'unhide' : 'hide',
                              `Community safety review in ${fp.communityAcronym}`
                            );
                            showToast(fp.isHidden ? 'Community post restored.' : 'Community post hidden.');
                            await loadData();
                          } catch (err: any) {
                            showToast(err.message, true);
                          }
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] font-medium cursor-pointer"
                      >
                        {fp.isHidden ? 'Unhide' : 'Hide'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.modModerateContent(
                              'post',
                              fp.postId,
                              'remove',
                              `Removed guideline violation in ${fp.communityAcronym}`
                            );
                            showToast('Violating post removed.');
                            await loadData();
                          } catch (err: any) {
                            showToast(err.message, true);
                          }
                        }}
                        className="px-2.5 py-1.5 rounded-lg border border-[#C4718E]/50 text-[#C4718E] dark:text-[#E5A4BA] flex items-center gap-1 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Remove</span>
                      </button>
                    </div>
                  )}
                </GlassCard>
              ))
            )}
          </div>

          <GlassCard tone="cream" padding="none" className="overflow-x-auto">
            <div className="p-4 border-b border-[#171613]/10 dark:border-white/10 font-serif font-bold text-base text-[#171613] dark:text-[#F5EFE3]">
              Campus Communities &amp; Report Load
            </div>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase">
                  <th className="p-3">Community</th>
                  <th className="p-3">Area</th>
                  <th className="p-3 text-right">Members</th>
                  <th className="p-3 text-right">72h Posts</th>
                  <th className="p-3 text-right">Pending Reports</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8 tabular-nums">
                {communityReview.communities.map((c) => (
                  <tr key={c.id} className="hover:bg-[#FFFCF7]/65 dark:hover:bg-white/5">
                    <td className="p-3 font-medium text-[#171613] dark:text-[#F5EFE3]">
                      {c.name} <span className="font-mono text-[#82796F] dark:text-[#A89F95]">({c.acronym})</span>
                    </td>
                    <td className="p-3 text-[#82796F] dark:text-[#A89F95]">{c.location}</td>
                    <td className="p-3 text-right font-mono">{c.memberCount}</td>
                    <td className="p-3 text-right font-mono">{c.activePostsCount}</td>
                    <td className="p-3 text-right font-mono font-semibold text-[#C4718E] dark:text-[#E5A4BA]">
                      {c.pendingReportsCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>
        </div>
      )}

      {/* 3. MODERATION HISTORY */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setHistoryScope('mine')}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer border ${
                historyScope === 'mine'
                  ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-transparent'
                  : 'bg-[#FFFCF7]/75 dark:bg-white/5 text-[#82796F] dark:text-[#A89F95] border-[#171613]/10 dark:border-white/10'
              }`}
            >
              My Moderation History
            </button>
            <button
              type="button"
              onClick={() => setHistoryScope('team')}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer border ${
                historyScope === 'team'
                  ? 'bg-[#171613] dark:bg-[#F5EFE3] text-[#F5EFE3] dark:text-[#171613] border-transparent'
                  : 'bg-[#FFFCF7]/75 dark:bg-white/5 text-[#82796F] dark:text-[#A89F95] border-[#171613]/10 dark:border-white/10'
              }`}
            >
              Team Moderation Log
            </button>
          </div>

          <GlassCard tone="cream" padding="none" className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#E8DDCC]/55 dark:bg-white/5 border-b border-[#171613]/10 dark:border-white/10 text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase">
                  <th className="p-3">Moderator</th>
                  <th className="p-3">Action</th>
                  <th className="p-3">Target</th>
                  <th className="p-3">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171613]/8 dark:divide-white/8">
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-[#82796F] dark:text-[#A89F95]">
                      No moderation history entries recorded yet.
                    </td>
                  </tr>
                ) : (
                  history.map((h) => (
                    <tr key={h.id} className="hover:bg-[#FFFCF7]/65 dark:hover:bg-white/5">
                      <td className="p-3 font-mono text-[#171613] dark:text-[#F5EFE3]">{h.actorHandle}</td>
                      <td className="p-3 font-mono font-semibold text-[#171613] dark:text-[#F5EFE3]">{h.action}</td>
                      <td className="p-3 font-mono text-[11px] text-[#82796F] dark:text-[#A89F95]">
                        {h.targetType}:{h.targetId}
                      </td>
                      <td className="p-3 font-mono text-[11px] text-[#82796F] dark:text-[#A89F95] tabular-nums">
                        {new Date(h.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </GlassCard>
        </div>
      )}

      {/* ESCALATE TO ADMIN MODAL */}
      <GlassModal
        isOpen={Boolean(escalateTarget)}
        onClose={() => setEscalateTarget(null)}
        title={escalateTarget ? `Escalate Report — ${escalateTarget.target_id}` : 'Escalate to Admin'}
        maxWidthClass="max-w-md"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!escalateTarget) return;
            try {
              await api.modEscalateReport(escalateTarget.id, escalateReason);
              showToast('Case escalated to Admin (@THEBACKDOOR).');
              setEscalateTarget(null);
              setEscalateReason('');
              await loadData();
            } catch (err: any) {
              showToast(err.message, true);
            }
          }}
          className="p-5 space-y-3 text-xs"
        >
          <p className="text-[#82796F] dark:text-[#A89F95]">
            Provide clear context for the Admin on why this case requires suspension, legal escalation, or platform-wide intervention (min 5 characters).
          </p>
          <textarea
            required
            minLength={5}
            rows={3}
            value={escalateReason}
            onChange={(e) => setEscalateReason(e.target.value)}
            placeholder="Reason for Admin escalation..."
            className="w-full px-3.5 py-2.5 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3]"
          />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setEscalateTarget(null)}>
              Cancel
            </GlassButton>
            <GlassButton type="submit" variant="pink" size="sm">
              Escalate Case
            </GlassButton>
          </div>
        </form>
      </GlassModal>

      {/* WARN USER MODAL */}
      <GlassModal
        isOpen={Boolean(warnTarget)}
        onClose={() => setWarnTarget(null)}
        title={warnTarget ? `Issue Warning — ${warnTarget.handle}` : 'Issue Warning'}
        maxWidthClass="max-w-md"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!warnTarget) return;
            try {
              await api.modWarnUser(warnTarget.userId, warnReason, warnSeverity);
              showToast(`Warning issued to ${warnTarget.handle}.`);
              setWarnTarget(null);
              setWarnReason('');
              await loadData();
            } catch (err: any) {
              showToast(err.message, true);
            }
          }}
          className="p-5 space-y-3 text-xs"
        >
          <select
            value={warnSeverity}
            onChange={(e) => setWarnSeverity(e.target.value as any)}
            className="w-full px-3.5 py-2.5 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3]"
          >
            <option value="minor">Minor Guideline Notice</option>
            <option value="standard">Standard Warning</option>
            <option value="severe">Severe Final Warning</option>
          </select>
          <textarea
            required
            minLength={3}
            rows={3}
            value={warnReason}
            onChange={(e) => setWarnReason(e.target.value)}
            placeholder="Explain community guideline violation..."
            className="w-full px-3.5 py-2.5 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3]"
          />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setWarnTarget(null)}>
              Cancel
            </GlassButton>
            <GlassButton type="submit" variant="pink" size="sm">
              Send Warning
            </GlassButton>
          </div>
        </form>
      </GlassModal>

      {/* TEMPORARY RESTRICT USER MODAL */}
      <GlassModal
        isOpen={Boolean(restrictTarget)}
        onClose={() => setRestrictTarget(null)}
        title={restrictTarget ? `Restrict Account — ${restrictTarget.handle}` : 'Restrict Account'}
        maxWidthClass="max-w-md"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!restrictTarget) return;
            try {
              await api.modRestrictUser(restrictTarget.userId, restrictHours, restrictReason);
              showToast(`Restricted ${restrictTarget.handle} for ${restrictHours}h.`);
              setRestrictTarget(null);
              setRestrictReason('');
              await loadData();
            } catch (err: any) {
              showToast(err.message, true);
            }
          }}
          className="p-5 space-y-3 text-xs"
        >
          <div className="flex items-center gap-2 text-[#82796F] dark:text-[#A89F95]">
            <Clock className="w-3.5 h-3.5 text-[#C4718E]" />
            <span>Maximum allowed duration for your Moderator tier: {maxHours} hours</span>
          </div>
          <input
            type="number"
            min={1}
            max={maxHours}
            required
            value={restrictHours}
            onChange={(e) => setRestrictHours(Math.min(maxHours, Math.max(1, Number(e.target.value) || 1)))}
            className="w-full px-3.5 py-2.5 glass-input rounded-xl font-mono text-[#171613] dark:text-[#F5EFE3]"
          />
          <textarea
            required
            minLength={3}
            rows={3}
            value={restrictReason}
            onChange={(e) => setRestrictReason(e.target.value)}
            placeholder="Documented reason for temporary posting & messaging restriction..."
            className="w-full px-3.5 py-2.5 glass-input rounded-xl text-[#171613] dark:text-[#F5EFE3]"
          />
          <div className="flex justify-end gap-2">
            <GlassButton variant="glass" size="sm" onClick={() => setRestrictTarget(null)}>
              Cancel
            </GlassButton>
            <GlassButton type="submit" variant="black" size="sm">
              Apply Temporary Restriction
            </GlassButton>
          </div>
        </form>
      </GlassModal>
    </div>
  );
};

import React, { useState } from 'react';
import {
  AlertTriangle,
  Clock,
  FileText,
  LifeBuoy,
  Lock,
  Scale,
  Shield,
  Sparkles,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { GlassButton, GlassCard } from '../components/glass';
import { triggerHaptic } from '../utils/haptics';

type PolicySection =
  | 'privacy'
  | 'terms'
  | 'guidelines'
  | 'retention'
  | 'moderation'
  | 'free_access'
  | 'conduct'
  | 'support';

interface PoliciesPageProps {
  initialSection?: PolicySection;
  onNavigateToTab?: (tab: any) => void;
}

export const PoliciesPage: React.FC<PoliciesPageProps> = ({
  initialSection = 'privacy',
  onNavigateToTab,
}) => {
  const [activeSection, setActiveSection] = useState<PolicySection>(initialSection);

  const sections: Array<{ id: PolicySection; title: string; subtitle: string; icon: React.ReactNode }> = [
    {
      id: 'privacy',
      title: 'Privacy & Data Protection',
      subtitle: 'NDPA 2023, Personal Info & Anonymous Rules',
      icon: <Lock className="w-4 h-4" />,
    },
    {
      id: 'terms',
      title: 'Terms & User Responsibilities',
      subtitle: 'Independent Status, UGC, Copyright & Limits',
      icon: <FileText className="w-4 h-4" />,
    },
    {
      id: 'guidelines',
      title: 'Community Guidelines',
      subtitle: 'Harassment, Impersonation, Spam & Safety',
      icon: <AlertTriangle className="w-4 h-4" />,
    },
    {
      id: 'retention',
      title: 'Data Collection & Deletion',
      subtitle: 'Storage, 72-Hour Expiry & Account Erasure',
      icon: <Trash2 className="w-4 h-4" />,
    },
    {
      id: 'moderation',
      title: 'Reporting, Moderation & Bans',
      subtitle: 'Suspensions, Terminations & Appeals SLA',
      icon: <Scale className="w-4 h-4" />,
    },
    {
      id: 'free_access',
      title: '100% Free Access Charter',
      subtitle: 'Unrestricted Features · Zero Fees or Ads',
      icon: <Sparkles className="w-4 h-4" />,
    },
    {
      id: 'conduct',
      title: 'Administrative Conduct',
      subtitle: 'Single Admin Accountability & Audit Trails',
      icon: <UserCheck className="w-4 h-4" />,
    },
    {
      id: 'support',
      title: 'Support & Contact SLA',
      subtitle: 'Response Channels & Safety Escalation',
      icon: <LifeBuoy className="w-4 h-4" />,
    },
  ];

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6 md:py-8">
      {/* Header */}
      <div className="border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 pb-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider mb-1">
              <Shield className="w-3.5 h-3.5 text-[#C4718E]" />
              <span>Independent Student Social Network · Governance & Policies</span>
            </div>
            <h1 className="font-serif text-2xl md:text-3xl font-bold text-[#171613] dark:text-[#F5EFE3] tracking-tight">
              Schoolbackdoor Policies & Community Guidelines
            </h1>
            <p className="text-xs md:text-sm text-[#82796F] dark:text-[#A89F95] font-sans mt-1">
              Independent student social platform — NOT owned, operated, endorsed, or officially affiliated with any university administration.
            </p>
          </div>
          {onNavigateToTab && (
            <GlassButton
              variant="glass"
              size="sm"
              onClick={() => onNavigateToTab('settings')}
              className="self-start sm:self-auto"
            >
              Back to Settings
            </GlassButton>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Navigation Sidebar */}
        <div className="md:col-span-4 space-y-1.5">
          <p className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider px-2 pb-1">
            Policy Directory
          </p>
          {sections.map((s) => {
            const isActive = activeSection === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  setActiveSection(s.id);
                }}
                className={`w-full text-left p-3 rounded-2xl transition-all cursor-pointer flex items-start gap-3 border ${
                  isActive
                    ? 'bg-[#171613] text-[#F5EFE3] border-[#171613] dark:bg-[#D98BA5] dark:text-[#171613] dark:border-[#D98BA5] shadow-sm'
                    : 'glass-subtle text-[#171613] dark:text-[#F5EFE3] hover:bg-[#FFFCF7]/80 dark:hover:bg-[#23211C]/80'
                }`}
              >
                <div
                  className={`p-1.5 rounded-xl shrink-0 ${
                    isActive
                      ? 'bg-[#D98BA5] text-[#171613] dark:bg-[#171613] dark:text-[#F5EFE3]'
                      : 'bg-[#E8DDCC]/70 dark:bg-[#23211C] text-[#171613] dark:text-[#F5EFE3]'
                  }`}
                >
                  {s.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate">{s.title}</div>
                  <div
                    className={`text-[11px] truncate mt-0.5 ${
                      isActive ? 'text-[#F5EFE3]/75 dark:text-[#171613]/75' : 'text-[#82796F] dark:text-[#A89F95]'
                    }`}
                  >
                    {s.subtitle}
                  </div>
                </div>
              </button>
            );
          })}

          <GlassCard tone="pink" padding="sm" className="mt-4 text-xs">
            <div className="font-semibold flex items-center gap-1.5 mb-1 text-[#171613] dark:text-[#F5EFE3]">
              <Scale className="w-3.5 h-3.5 text-[#C4718E]" />
              <span>Independent Platform Notice</span>
            </div>
            <p className="text-[11px] text-[#171613]/80 dark:text-[#F5EFE3]/80 leading-relaxed">
              Schoolbackdoor is an independent community social network built for students. It is not an official university portal, and opinions or posts shared here reflect individual members rather than university management. Aligned with the Nigeria Data Protection Act (NDPA) 2023.
            </p>
          </GlassCard>
        </div>

        {/* Content Body */}
        <GlassCard tone="cream" padding="lg" className="md:col-span-8">
          {activeSection === 'privacy' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-01 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  Privacy & Protection of Personal Information
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Nigeria Data Protection Act (NDPA) 2023 · Applied across all Schoolbackdoor services
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    1. Scope & Independent Identity
                  </h3>
                  <p>
                    Schoolbackdoor is an independent social media platform built for students to share everyday life, humor, discussions, photos, and school-related conversations. Schoolbackdoor is NOT owned, operated, endorsed, or officially affiliated with any university. We process personal data solely to operate social networking features safely under the Nigeria Data Protection Act (NDPA) 2023.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    2. Personal Information Protection & Minimization
                  </h3>
                  <p>We collect only what is needed to run your account cleanly:</p>
                  <ul className="list-disc pl-5 mt-1.5 space-y-1 text-xs">
                    <li>
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Account Credentials:</strong> Unique username handle (<code>@username</code>), Gmail address (used for verification and password recovery), and salted <code>scrypt</code> password hash.
                    </li>
                    <li>
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Optional Profile Details:</strong> Display name, biography, department, academic level, hostel/area, and avatar color choice.
                    </li>
                    <li>
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Social Content:</strong> Posts, replies, reposts, photo uploads, community memberships, and private messages.
                    </li>
                  </ul>
                  <p className="mt-1.5 text-xs text-[#82796F] dark:text-[#A89F95]">
                    We never store plaintext passwords, never sell personal data to advertisers, and never expose your Gmail address publicly on your profile or posts.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    3. Anonymous Posting & Profile Privacy Controls
                  </h3>
                  <p>
                    Members may mark their profile as <em>Private</em> (restricting detailed bio, hostel, and post history from non-connected viewers) and may publish posts using the <em>Anonymous Member</em> (<code>@anonymous</code>) option. Anonymous posts hide your identity from other students and the public, while remaining traceable internally by the platform Admin solely to investigate abuse, threats, doxxing, or illegal activity.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    4. Your Enforceable Privacy Rights
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 text-xs">
                    <div className="p-3 rounded-xl glass-subtle">
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Access & Correction:</strong> Review and edit your profile details and privacy toggles anytime in Profile & Settings.
                    </div>
                    <div className="p-3 rounded-xl glass-subtle">
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Permanent Deletion:</strong> Erase your account, posts, chats, and sessions permanently under NDPA 2023.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'terms' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-02 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  Terms, User-Generated Content & Platform Limitations
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Account registration, content ownership, copyright, and service disclaimers
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    1. Account Registration, Age Requirement (17+/18+) &amp; Eligibility
                  </h3>
                  <p>
                    Registration requires confirming you are at least <strong>17+ / 18+</strong> years old, accepting these Terms &amp; Community Guidelines, a unique <code>@username</code>, a valid Gmail address (<code>@gmail.com</code>), and a strong password. You may sign in with either your <code>@username</code> or registered Gmail address. Because Schoolbackdoor is an independent social network, you do not need official university portal authorization to participate.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    2. User-Generated Content (UGC) & Open Social Expression
                  </h3>
                  <p>
                    Schoolbackdoor is a general social media network, not an academic-only forum. You are free to share personal updates, everyday campus experiences, entertainment, memes, humor, photos, discussions, opinions, and school-related topics, provided your content complies with our Community Guidelines and applicable laws.
                  </p>
                  <p className="mt-1.5">
                    You retain ownership of the content you post. By posting, you grant Schoolbackdoor a limited, non-exclusive license to display, store, and deliver your content to other members during its active 72-hour retention window or until you delete it.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    3. Copyright & Intellectual Property
                  </h3>
                  <p>
                    Only upload photos, memes, notes, videos, or text that you created or have permission to share. Re-uploading copyrighted course packs, private paid content, or third-party creative works without authorization is prohibited. Verified copyright takedown requests sent to our support desk will result in prompt removal and repeat-infringer enforcement.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    4. User Responsibilities & Platform Limitations
                  </h3>
                  <ul className="list-disc pl-5 mt-1 space-y-1 text-xs">
                    <li>
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Member Responsibility:</strong> You are solely responsible for everything posted from your account, for protecting your password, and for verifying real-world information shared by peers before acting on it.
                    </li>
                    <li>
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">No University Affiliation:</strong> Schoolbackdoor does not speak for any university, does not issue official academic transcripts or university rulings, and is not responsible for university policy decisions.
                    </li>
                    <li>
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Service Availability:</strong> The platform is provided free on an &quot;as-available&quot; basis; we do not guarantee uninterrupted uptime or permanent storage beyond the 72-hour automated expiration cycle.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'guidelines' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-03 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  Community Guidelines & Prohibited Content
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Keeping conversations vibrant, expressive, and safe for everyone
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div className="p-4 rounded-2xl glass-subtle text-xs">
                  <strong className="text-[#171613] dark:text-[#F5EFE3] block mb-1">Welcome on Schoolbackdoor:</strong>
                  <p className="text-[#82796F] dark:text-[#A89F95]">
                    Everyday stories, memes, banter, campus gist, debates, music/tech interests, photography, study help, hostel life, and honest opinions — all in one free student social feed.
                  </p>
                </div>

                <div className="p-4 rounded-2xl border border-[#D98BA5] bg-[#F6E2E6]/70 dark:bg-[#D98BA5]/15 text-[#171613] dark:text-[#F5EFE3]">
                  <div className="font-bold flex items-center gap-1.5 mb-2 text-xs">
                    <AlertTriangle className="w-4 h-4 text-[#C4718E]" />
                    <span>Strictly Prohibited Conduct:</span>
                  </div>
                  <ul className="list-disc pl-5 space-y-1.5 text-xs">
                    <li>
                      <strong>Harassment, Bullying & Threats:</strong> Targeted intimidation, sustained verbal abuse, hate speech, non-consensual intimate imagery, blackmail, or threats of physical harm.
                    </li>
                    <li>
                      <strong>Doxxing & Privacy Violations:</strong> Sharing private phone numbers, hostel room numbers, residential addresses, bank details, or private IDs without consent.
                    </li>
                    <li>
                      <strong>Impersonation & Fake Accounts:</strong> Pretending to be another student, creator, public figure, faculty/administration, or an official university office.
                    </li>
                    <li>
                      <strong>Spam, Scams & Prohibited Content:</strong> Automated bot spam, phishing links, Ponzi/investment scams, malware, illegal goods, violent extremism, or sexually explicit exploitation.
                    </li>
                    <li>
                      <strong>Abuse of Anonymous Posting:</strong> Using <code>@anonymous</code> to defame, threaten, dox, or harass named individuals.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'retention' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-04 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  Data Collection, Storage, Expiry & Deletion
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Transparent technical data lifecycle from creation through permanent erasure
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    1. Data Collection &amp; Multi-Device Session Security
                  </h3>
                  <p>
                    Account records, social connections, and active content are stored on secured application servers with salted <code>scrypt</code> password hashing, SHA-256 hashed session tokens, <strong>15-minute access cookies</strong>, rotating <strong>30-day inactivity refresh tokens</strong>, a <strong>90-day hard session lifetime</strong>, and up to <strong>5 concurrent signed-in devices</strong>. We never expose raw database identifiers, personal emails, or private direct messages to unauthorized users.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    2. The 72-Hour Ephemeral Rule
                  </h3>
                  <p>
                    To keep feeds fresh and protect conversational privacy, direct chat messages and standard unpinned posts automatically expire after <strong>72 hours</strong>.
                  </p>
                  <div className="p-3.5 mt-2 rounded-xl glass-subtle flex items-start gap-2.5 text-xs">
                    <Clock className="w-4 h-4 text-[#C4718E] shrink-0 mt-0.5" />
                    <div>
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Automated Purge Worker:</strong> An hourly background worker permanently removes expired messages, expired unpinned posts, and unreferenced uploaded images from storage and invalidates cached copies immediately.
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    3. Permanent Self-Service Account Deletion
                  </h3>
                  <p>
                    You can delete your account permanently at any time inside <strong>Settings → Data &amp; NDPA</strong> or via the public web deletion page at <a href="/account-deletion" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-[#C4718E]">/account-deletion</a>:
                  </p>
                  <ul className="list-disc pl-5 mt-1.5 space-y-1 text-xs">
                    <li>Your user profile, username, Gmail, password hash, and all active device sessions are erased immediately after password verification.</li>
                    <li>All authored posts, replies, likes, reposts, connections, and chat histories are cascaded and deleted.</li>
                    <li>A cryptographic SHA-256 tombstone ensures disaster-recovery snapshots (rotated after <strong>14 days</strong>) never restore your deleted account.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'moderation' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-05 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  Reporting, Moderation, Suspension & Termination
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  How flagged content is reviewed and when accounts are suspended or terminated
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    1. Reporting Inappropriate Content & Accounts
                  </h3>
                  <p>
                    Every post and user profile includes a <strong>Report</strong> button. Submitting a report immediately alerts the Admin moderation queue with the target reference and reason. You can also <strong>Block</strong> any user at any time to prevent direct messages, profile access, and social interactions.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    2. Enforcement, Suspension & Account Termination
                  </h3>
                  <div className="space-y-2 mt-2">
                    <div className="p-3 rounded-xl glass-subtle text-xs">
                      <strong className="text-[#171613] dark:text-[#F5EFE3]">Tier 1 — Content Removal & Warning:</strong> Violating posts or replies are removed and an in-app warning is recorded on the account.
                    </div>
                    <div className="p-3 rounded-xl border border-[#D98BA5]/60 bg-[#F6E2E6]/50 dark:bg-[#D98BA5]/18 text-xs text-[#171613] dark:text-[#F5EFE3]">
                      <strong>Tier 2 — Temporary Suspension (3 to 14 Days):</strong> Issued for harassment, repeated spam, impersonation attempts, or abusing anonymous posting. Active sessions are revoked immediately until the suspension ends.
                    </div>
                    <div className="p-3 rounded-xl bg-[#171613] dark:bg-[#23211C] text-[#F5EFE3] border border-transparent dark:border-[#D98BA5]/35 text-xs">
                      <strong>Tier 3 — Permanent Account Termination:</strong> Issued for severe threats, doxxing, non-consensual content, scams, CSAM/illegal content, or repeated severe violations after warning.
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    3. Right to Fair Appeal (48-Hour SLA)
                  </h3>
                  <p>
                    Members subjected to a warning or temporary suspension may contact support to request a review. Decisions are documented in the Admin audit trail within <strong>48 hours</strong>.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'free_access' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-06 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  100% Free Access Charter
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Unrestricted social networking for every registered user at zero cost
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    1. Permanently Free for Everyone
                  </h3>
                  <p>
                    Schoolbackdoor is completely free for all registered users. There are <strong>no subscription fees, no membership tiers, no trial expirations, no paywalls, no advertising, and no promoted posts</strong>.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    2. All Features Included
                  </h3>
                  <ul className="list-disc pl-5 mt-1.5 space-y-1 text-xs">
                    <li>Unlimited 1-on-1 direct messaging and group chats</li>
                    <li>Posting, replying, threaded comments, reposts, likes, shares, and photo uploads</li>
                    <li>Anonymous posting controls and private profile shielding</li>
                    <li>Creating and joining interest, social, hostel, and academic communities</li>
                    <li>Friend discovery, @username search, notifications, and campus landmarks</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'conduct' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-07 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  Administrative Conduct & Security Safeguards
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Single Admin accountability and strict privacy boundaries
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    1. Admin Account &amp; Scoped Moderator Permissions
                  </h3>
                  <p>
                    Schoolbackdoor separates full platform governance (reserved strictly for the authorized <strong>@THEBACKDOOR</strong> Admin account) from scoped safety moderation assigned to <strong>Moderator</strong> accounts. Both Admin and Moderator accounts enforce server-side role verification, optional TOTP two-factor authentication, session revocation, and full security audit logging.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-[#171613] dark:text-[#F5EFE3] text-sm mb-1.5">
                    2. Privacy Safeguards &amp; Audit Trails
                  </h3>
                  <p>
                    Moderators and Admins do not arbitrarily inspect private direct messages. Message or anonymous-author inspection occurs solely for verified safety, harassment, or legal investigations, and every administrative or security action is recorded in append-only audit and security event logs.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'support' && (
            <div className="space-y-6">
              <div>
                <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] uppercase tracking-wider">
                  Doc Ref: SB-POL-08 · Rev: 2026.11
                </span>
                <h2 className="font-serif text-xl md:text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1">
                  Support & Service Level Agreement (SLA)
                </h2>
                <p className="text-xs text-[#82796F] dark:text-[#A89F95] mt-0.5">
                  Contact channels, response targets, and safety escalation
                </p>
              </div>

              <div className="space-y-4 text-xs md:text-sm text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="p-3.5 rounded-xl glass-subtle">
                    <strong className="text-[#171613] dark:text-[#F5EFE3] block mb-1">General Community & Bug Reports</strong>
                    <p className="text-[#82796F] dark:text-[#A89F95]">
                      Account help, community questions, and technical bugs reviewed within <strong className="text-[#171613] dark:text-[#F5EFE3]">24 hours</strong>.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-xl glass-subtle">
                    <strong className="text-[#171613] dark:text-[#F5EFE3] block mb-1">Gmail Verification & Recovery</strong>
                    <p className="text-[#82796F] dark:text-[#A89F95]">
                      6-digit codes issued instantly; manual account recovery requests handled within <strong className="text-[#171613] dark:text-[#F5EFE3]">12 hours</strong>.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-xl glass-subtle">
                    <strong className="text-[#171613] dark:text-[#F5EFE3] block mb-1">Moderation & Copyright Appeals</strong>
                    <p className="text-[#82796F] dark:text-[#A89F95]">
                      Appeals and IP notices reviewed within <strong className="text-[#171613] dark:text-[#F5EFE3]">48 hours</strong>.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-xl glass-subtle">
                    <strong className="text-[#171613] dark:text-[#F5EFE3] block mb-1">Urgent Safety & Harassment Flags</strong>
                    <p className="text-[#82796F] dark:text-[#A89F95]">
                      Priority triage within <strong className="text-[#171613] dark:text-[#F5EFE3]">1 hour</strong>; reported posts hidden pending review.
                    </p>
                  </div>
                </div>

                <div className="pt-2 text-xs text-[#82796F] dark:text-[#A89F95] flex flex-col gap-1.5">
                  <span>Independent Support Desk: support@schoolbackdoor.app · Community Safety Team (Akure, Nigeria)</span>
                  <div className="flex flex-wrap gap-3">
                    <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline text-[#C4718E]">Public Privacy URL</a>
                    <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline text-[#C4718E]">Public Terms URL</a>
                    <a href="/support" target="_blank" rel="noopener noreferrer" className="underline text-[#C4718E]">Public Support URL</a>
                    <a href="/account-deletion" target="_blank" rel="noopener noreferrer" className="underline text-[#C4718E]">Public Account Deletion URL</a>
                  </div>
                </div>
              </div>
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
};

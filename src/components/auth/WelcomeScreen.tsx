import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  MessageSquare,
  Monitor,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
} from 'lucide-react';
import { GlassButton, GlassCard } from '../glass';
import { SchoolbackdoorLogo } from '../glass/SchoolbackdoorLogo';
import { ThemePreference, useTheme } from '../../utils/useTheme';
import { triggerHaptic } from '../../utils/haptics';

interface WelcomeScreenProps {
  onGetStarted: () => void;
  onSignIn: () => void;
  onBrowsePublicFeed: () => void;
  onlineMessage?: string;
}

const ONBOARDING_SLIDES = [
  {
    id: 'connect',
    eyebrow: '01 · Express Yourself',
    title: 'Everyday updates, humour, discussions & campus life',
    description:
      'Share personal moments, memes, photos, hot takes, or school questions across a relaxed social feed built for students.',
    highlight: 'Posts, replies, polls & photo grids',
    icon: Sparkles,
  },
  {
    id: 'communities',
    eyebrow: '02 · Communities & Friends',
    title: 'Find friends, join groups & follow interests',
    description:
      'Connect by @username, join social circles, tech guilds, and hostel chats, or post anonymously when you want honest feedback.',
    highlight: 'Groups, mentions & anonymous wall',
    icon: Users,
  },
  {
    id: 'chats',
    eyebrow: '03 · Real-Time Chats & Spots',
    title: 'Instant private DMs & interactive spot sharing',
    description:
      'Message friends one-on-one or in group rooms with photo attachments and saved spot pins — 100% free with zero ads.',
    highlight: 'Direct messages & saved locations',
    icon: MessageSquare,
  },
];

const THEME_MODES: Array<{ id: ThemePreference; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onGetStarted,
  onSignIn,
  onBrowsePublicFeed,
  onlineMessage,
}) => {
  const [step, setStep] = useState<'welcome' | 'onboarding'>('welcome');
  const [slideIndex, setSlideIndex] = useState(0);
  const { preference, setPreference } = useTheme();

  const activeSlide = ONBOARDING_SLIDES[slideIndex];
  const SlideIcon = activeSlide.icon;

  return (
    <div className="min-h-dvh w-full sb-liquid-canvas text-[#171613] dark:text-[#F5EFE3] flex flex-col justify-center relative overflow-hidden px-3.5 sm:px-4 py-5 md:py-10 transition-colors">
      <div className="w-full max-w-6xl mx-auto">
        <div className="flex justify-end mb-4">
          <div
            className="inline-flex items-center gap-1 p-1 rounded-xl glass-subtle border border-[#171613]/10 dark:border-white/12"
            role="group"
            aria-label="Appearance setting"
          >
            {THEME_MODES.map((m) => {
              const Icon = m.icon;
              const active = preference === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setPreference(m.id);
                  }}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                    active
                      ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613] shadow-sm'
                      : 'text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {step === 'welcome' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-7 items-center">
            {/* Signature Liquid-Wave Showcase Card */}
            <div className="lg:col-span-6 relative rounded-2xl overflow-hidden shadow-[0_28px_70px_-20px_rgba(23,22,19,0.42)] dark:shadow-[0_28px_70px_-20px_rgba(0,0,0,0.75)] border border-[#FFFCF7]/80 dark:border-white/12 min-h-[460px] sm:min-h-[580px] lg:min-h-[620px] flex flex-col justify-between bg-gradient-to-b from-[#FFFCF7] via-[#F5EFE3] to-[#EDD5DF]/70 dark:from-[#1B1915] dark:via-[#151411] dark:to-[#24191D]">
              <div
                className="absolute inset-x-0 top-0 h-[64%] pointer-events-none"
                style={{
                  background:
                    'radial-gradient(ellipse 72% 58% at 50% 24%, rgba(217,139,165,0.22) 0%, rgba(246,226,230,0.10) 50%, transparent 78%)',
                }}
                aria-hidden="true"
              />
              <div
                className="absolute inset-x-8 top-6 bottom-[46%] rounded-2xl border border-[#171613]/6 dark:border-[#F5EFE3]/8 pointer-events-none"
                aria-hidden="true"
              />

              {/* Centered Brand Masthead in Top Glow */}
              <div className="relative z-10 pt-10 sm:pt-12 px-6 flex flex-col items-center text-center text-[#171613] dark:text-[#F5EFE3]">
                <SchoolbackdoorLogo variant="dark" size="xl" />
                <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight text-[#171613] dark:text-[#F5EFE3] mt-2">
                  Schoolbackdoor
                </h1>
                <p className="text-xs sm:text-sm font-medium text-[#171613]/80 dark:text-[#F5EFE3]/80 tracking-wide mt-1">
                  Connect · Share · Belong
                </p>
                {onlineMessage && (
                  <div className="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-xl glass-subtle text-[11px] font-medium text-[#171613] dark:text-[#F5EFE3] tabular-nums">
                    <span className="w-2 h-2 rounded-full bg-[#D98BA5]" aria-hidden="true" />
                    <span>{onlineMessage}</span>
                  </div>
                )}
              </div>

              {/* Curved Dark Liquid Wave Overlay at Bottom */}
              <div className="relative z-10 mt-auto pt-16">
                <svg
                  viewBox="0 0 600 95"
                  preserveAspectRatio="none"
                  className="w-full h-16 sm:h-20 block -mb-px"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id="sbWaveRim" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#FFFCF7" stopOpacity="0.45" />
                      <stop offset="50%" stopColor="#D98BA5" stopOpacity="0.85" />
                      <stop offset="100%" stopColor="#FFFCF7" stopOpacity="0.3" />
                    </linearGradient>
                    <radialGradient id="sbDarkWaveGrad" cx="80%" cy="90%" r="85%">
                      <stop offset="0%" stopColor="#6D3F4F" stopOpacity="0.55" />
                      <stop offset="42%" stopColor="#1E1C18" stopOpacity="0.96" />
                      <stop offset="100%" stopColor="#171613" stopOpacity="0.98" />
                    </radialGradient>
                  </defs>
                  <path
                    d="M0,45 C140,95 280,-10 430,25 C510,43 565,58 600,32 L600,95 L0,95 Z"
                    fill="url(#sbDarkWaveGrad)"
                  />
                  <path
                    d="M0,45 C140,95 280,-10 430,25 C510,43 565,58 600,32"
                    fill="none"
                    stroke="url(#sbWaveRim)"
                    strokeWidth="2.5"
                  />
                </svg>

                <div
                  className="px-6 sm:px-8 pb-7 pt-1 text-center relative overflow-hidden"
                  style={{
                    background:
                      'radial-gradient(circle at 82% 88%, rgba(217,139,165,0.34), rgba(23,22,19,0.98) 58%)',
                  }}
                >
                  <h2 className="font-serif text-2xl sm:text-3xl font-bold text-[#FFFCF7] leading-tight">
                    Your Social Hangout
                    <br />
                    in One Place.
                  </h2>
                  <p className="text-xs sm:text-sm text-[#F5EFE3]/80 mt-2.5 max-w-sm mx-auto leading-relaxed">
                    An independent student social platform to connect, share, and belong.
                  </p>

                  <div className="mt-5 flex flex-col gap-2.5 max-w-xs mx-auto">
                    <GlassButton
                      variant="pink"
                      size="lg"
                      onClick={() => setStep('onboarding')}
                      className="w-full"
                    >
                      <span>Get Started</span>
                      <ArrowRight className="w-4 h-4" />
                    </GlassButton>

                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('tap');
                        onSignIn();
                      }}
                      className="w-full min-h-[44px] px-5 py-2.5 rounded-xl bg-[#FFFCF7]/8 hover:bg-[#FFFCF7]/15 border border-[#FFFCF7]/20 text-[#F5EFE3] text-xs md:text-sm font-semibold whitespace-nowrap transition-all cursor-pointer"
                    >
                      Sign In
                    </button>
                  </div>

                  {/* Interactive Pagination Indicator + Public Feed Escape */}
                  <div className="mt-5 flex flex-col items-center gap-2.5">
                    <div className="flex items-center gap-1.5" aria-hidden="true">
                      <span className="w-5 h-1.5 rounded-sm bg-[#D98BA5]" />
                      <span className="w-2 h-1.5 rounded-sm bg-[#F5EFE3]/35" />
                      <span className="w-2 h-1.5 rounded-sm bg-[#F5EFE3]/35" />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('tap');
                        onBrowsePublicFeed();
                      }}
                      className="text-[11px] text-[#F5EFE3]/70 hover:text-[#D98BA5] transition-colors cursor-pointer min-h-[36px] px-2"
                    >
                      Browse public feed →
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Desktop Editorial Companion Card */}
            <div className="hidden lg:block lg:col-span-6">
              <GlassCard tone="strong" padding="lg" className="space-y-6 animate-sb-in">
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#C4718E] dark:text-[#E5A4BA]">
                    Independent Student Social Network
                  </span>
                  <h2 className="font-serif text-3xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-1.5 leading-tight">
                    Social life, banter, and community built around students.
                  </h2>
                  <p className="text-sm text-[#82796F] dark:text-[#A89F95] mt-2.5 leading-relaxed">
                    Post everyday stories, memes, photos, discussions, or school tips — 100% free with zero ads. Schoolbackdoor is independently operated.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="p-4 rounded-2xl glass-subtle space-y-1.5">
                    <ShieldCheck className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <div className="font-serif font-bold text-sm text-[#171613] dark:text-[#F5EFE3]">
                      Simple Gmail &amp; @Handle Auth
                    </div>
                    <p className="text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                      Sign up in seconds with your unique @username and Gmail address, backed by scrypt hashing.
                    </p>
                  </div>
                  <div className="p-4 rounded-2xl glass-subtle space-y-1.5">
                    <Compass className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                    <div className="font-serif font-bold text-sm text-[#171613] dark:text-[#F5EFE3]">
                      72-Hour Ephemeral Feed
                    </div>
                    <p className="text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                      Posts, replies, reposts, and chats stay fresh, lightweight, and free from long-term clutter.
                    </p>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#171613]/10 dark:border-white/10 flex flex-wrap items-center justify-between gap-3">
                  <GlassButton variant="pink" size="md" onClick={onGetStarted}>
                    <span>Create Account</span>
                    <ArrowRight className="w-4 h-4" />
                  </GlassButton>
                  <button
                    type="button"
                    onClick={onBrowsePublicFeed}
                    className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] hover:text-[#C4718E] dark:hover:text-[#E5A4BA] transition-colors cursor-pointer min-h-[44px] px-2"
                  >
                    Preview Public Feed →
                  </button>
                </div>
              </GlassCard>
            </div>
          </div>
        ) : (
          /* Interactive Onboarding Carousel */
          <div className="w-full max-w-4xl mx-auto animate-sb-in">
            <GlassCard tone="strong" padding="none" className="overflow-hidden grid grid-cols-1 md:grid-cols-12">
              <div className="md:col-span-6 relative min-h-[240px] md:min-h-[440px] bg-gradient-to-br from-[#F6E2E6]/75 via-[#F5EFE3] to-[#E8DDCC]/75 dark:from-[#261A1E] dark:via-[#181714] dark:to-[#12110E] flex flex-col justify-between border-b md:border-b-0 md:border-r border-[#171613]/10 dark:border-white/10">
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background:
                      'radial-gradient(circle at 25% 22%, rgba(217,139,165,0.22), transparent 58%), radial-gradient(circle at 80% 82%, rgba(217,139,165,0.16), transparent 55%)',
                  }}
                  aria-hidden="true"
                />
                <div className="relative z-10 p-5 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setStep('welcome');
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-xl glass-dark text-[#F5EFE3] text-xs font-medium cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Welcome</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      onBrowsePublicFeed();
                    }}
                    className="px-3.5 py-2 min-h-[38px] rounded-xl glass-dark text-[#F5EFE3]/85 hover:text-[#F5EFE3] text-xs font-medium cursor-pointer"
                  >
                    Skip tour
                  </button>
                </div>

                <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 pb-8 pt-2 text-center">
                  <div className="w-16 h-16 rounded-2xl glass-strong flex items-center justify-center shadow-lg border border-[#D98BA5]/30">
                    <SlideIcon className="w-7 h-7 text-[#C4718E] dark:text-[#E5A4BA]" />
                  </div>
                  <div className="mt-4 font-mono text-[11px] uppercase tracking-[0.2em] text-[#82796F] dark:text-[#A89F95] tabular-nums">
                    Step 0{slideIndex + 1} / 0{ONBOARDING_SLIDES.length}
                  </div>
                  <div className="mt-1.5 text-xs font-medium text-[#171613]/85 dark:text-[#F5EFE3]/85">
                    {activeSlide.highlight}
                  </div>
                </div>
              </div>

              <div className="md:col-span-6 p-6 md:p-8 flex flex-col justify-between gap-6">
                <div>
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-[#C4718E] dark:text-[#E5A4BA]">
                    <SlideIcon className="w-3.5 h-3.5 text-[#D98BA5]" />
                    <span>{activeSlide.eyebrow}</span>
                  </div>
                  <h2 className="font-serif text-2xl md:text-3xl font-bold text-[#171613] dark:text-[#F5EFE3] mt-2 leading-tight">
                    {activeSlide.title}
                  </h2>
                  <p className="text-xs md:text-sm text-[#82796F] dark:text-[#A89F95] mt-3 leading-relaxed">
                    {activeSlide.description}
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2" role="tablist" aria-label="Onboarding steps">
                    {ONBOARDING_SLIDES.map((slide, idx) => (
                      <button
                        key={slide.id}
                        type="button"
                        onClick={() => {
                          triggerHaptic('tap');
                          setSlideIndex(idx);
                        }}
                        aria-label={`Step ${idx + 1}: ${slide.title}`}
                        className={`h-2 rounded-sm transition-all cursor-pointer ${
                          idx === slideIndex
                            ? 'w-8 bg-[#D98BA5]'
                            : 'w-2.5 bg-[#E8DDCC] dark:bg-[#2A2722] hover:bg-[#D98BA5]/50'
                        }`}
                      />
                    ))}
                  </div>

                  <div className="flex items-center gap-2.5">
                    {slideIndex > 0 && (
                      <GlassButton
                        variant="glass"
                        onClick={() => setSlideIndex((i) => Math.max(0, i - 1))}
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>Back</span>
                      </GlassButton>
                    )}

                    {slideIndex < ONBOARDING_SLIDES.length - 1 ? (
                      <GlassButton
                        variant="pink"
                        onClick={() => setSlideIndex((i) => Math.min(ONBOARDING_SLIDES.length - 1, i + 1))}
                        className="flex-1"
                      >
                        <span>Continue</span>
                        <ArrowRight className="w-4 h-4" />
                      </GlassButton>
                    ) : (
                      <div className="flex-1 flex flex-col sm:flex-row gap-2">
                        <GlassButton variant="pink" onClick={onGetStarted} className="flex-1">
                          <span>Create Student Account</span>
                        </GlassButton>
                        <GlassButton variant="black" onClick={onSignIn}>
                          <span>Sign In</span>
                        </GlassButton>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  );
};

import React from 'react';
import { GlassCard } from '../glass';

export const FeedSkeleton: React.FC<{ count?: number }> = ({ count = 3 }) => {
  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col gap-4 py-4" aria-busy="true" aria-label="Loading campus dispatches">
      {Array.from({ length: count }).map((_, idx) => (
        <GlassCard key={idx} tone="subtle" padding="md" className="animate-pulse">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#E8DDCC] dark:bg-[#2A2722] shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-36 rounded-lg bg-[#E8DDCC] dark:bg-[#2A2722]" />
              <div className="h-2.5 w-48 rounded-lg bg-[#E8DDCC]/70 dark:bg-[#2A2722]/70" />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-3.5 w-full rounded-lg bg-[#E8DDCC]/85 dark:bg-[#2A2722]/85" />
            <div className="h-3.5 w-11/12 rounded-lg bg-[#E8DDCC]/70 dark:bg-[#2A2722]/70" />
            <div className="h-3.5 w-3/4 rounded-lg bg-[#E8DDCC]/55 dark:bg-[#2A2722]/55" />
          </div>
          <div className="mt-4 pt-3 border-t border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center gap-5">
            <div className="h-6 w-14 rounded-xl bg-[#E8DDCC]/75 dark:bg-[#2A2722]/75" />
            <div className="h-6 w-14 rounded-xl bg-[#E8DDCC]/75 dark:bg-[#2A2722]/75" />
            <div className="h-6 w-14 rounded-xl bg-[#E8DDCC]/75 dark:bg-[#2A2722]/75" />
          </div>
        </GlassCard>
      ))}
    </div>
  );
};

export const ChatThreadSkeleton: React.FC = () => {
  return (
    <div className="flex-1 flex flex-col gap-3 p-4 animate-pulse" aria-busy="true" aria-label="Loading conversation">
      <div className="flex justify-start">
        <div className="h-12 w-56 rounded-2xl bg-[#FFFCF7]/80 dark:bg-[#23211C] border border-[#171613]/8 dark:border-[#F5EFE3]/10" />
      </div>
      <div className="flex justify-end">
        <div className="h-14 w-64 rounded-2xl bg-[#F6E2E6]/70 dark:bg-[#D98BA5]/20 border border-[#D98BA5]/25" />
      </div>
      <div className="flex justify-start">
        <div className="h-10 w-44 rounded-2xl bg-[#FFFCF7]/80 dark:bg-[#23211C] border border-[#171613]/8 dark:border-[#F5EFE3]/10" />
      </div>
      <div className="flex justify-end">
        <div className="h-12 w-52 rounded-2xl bg-[#F6E2E6]/70 dark:bg-[#D98BA5]/20 border border-[#D98BA5]/25" />
      </div>
    </div>
  );
};

export const CommunityGridSkeleton: React.FC<{ count?: number }> = ({ count = 4 }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-pulse" aria-busy="true" aria-label="Loading communities">
      {Array.from({ length: count }).map((_, idx) => (
        <GlassCard key={idx} tone="subtle" padding="md" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="h-5 w-40 rounded-lg bg-[#E8DDCC] dark:bg-[#2A2722]" />
            <div className="h-6 w-16 rounded-md bg-[#E8DDCC]/75 dark:bg-[#2A2722]/75" />
          </div>
          <div className="h-3.5 w-full rounded-lg bg-[#E8DDCC]/75 dark:bg-[#2A2722]/75" />
          <div className="h-3.5 w-4/5 rounded-lg bg-[#E8DDCC]/60 dark:bg-[#2A2722]/60" />
          <div className="pt-2 flex items-center justify-between">
            <div className="h-3 w-24 rounded-lg bg-[#E8DDCC]/70 dark:bg-[#2A2722]/70" />
            <div className="h-8 w-20 rounded-xl bg-[#E8DDCC] dark:bg-[#2A2722]" />
          </div>
        </GlassCard>
      ))}
    </div>
  );
};

export const ListRowsSkeleton: React.FC<{ rows?: number }> = ({ rows = 4 }) => {
  return (
    <div className="flex flex-col gap-3 animate-pulse" aria-busy="true" aria-label="Loading records">
      {Array.from({ length: rows }).map((_, idx) => (
        <div
          key={idx}
          className="rounded-2xl p-4 bg-[#FFFCF7]/70 dark:bg-[#1E1C18]/80 border border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-9 h-9 rounded-full bg-[#E8DDCC] dark:bg-[#2A2722] shrink-0" />
            <div className="space-y-2 flex-1">
              <div className="h-3.5 w-44 max-w-full rounded-lg bg-[#E8DDCC] dark:bg-[#2A2722]" />
              <div className="h-2.5 w-64 max-w-full rounded-lg bg-[#E8DDCC]/65 dark:bg-[#2A2722]/65" />
            </div>
          </div>
          <div className="h-7 w-16 rounded-xl bg-[#E8DDCC]/80 dark:bg-[#2A2722]/80 shrink-0" />
        </div>
      ))}
    </div>
  );
};

export const AdminDashboardSkeleton: React.FC = () => {
  return (
    <div className="space-y-5 animate-pulse" aria-busy="true" aria-label="Loading Admin Dashboard">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {Array.from({ length: 4 }).map((_, idx) => (
          <GlassCard key={idx} tone="cream" padding="md" className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-[#E8DDCC] dark:bg-[#2A2722] shrink-0" />
            <div className="space-y-2 flex-1">
              <div className="h-3 w-20 rounded bg-[#E8DDCC]/80 dark:bg-[#2A2722]/80" />
              <div className="h-6 w-24 rounded bg-[#E8DDCC] dark:bg-[#2A2722]" />
              <div className="h-2.5 w-28 rounded bg-[#E8DDCC]/65 dark:bg-[#2A2722]/65" />
            </div>
          </GlassCard>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <GlassCard tone="cream" padding="md" className="lg:col-span-8 h-56">
          <div className="h-4 w-40 rounded bg-[#E8DDCC] dark:bg-[#2A2722] mb-4" />
          <div className="h-36 w-full rounded-2xl bg-[#E8DDCC]/60 dark:bg-[#2A2722]/60" />
        </GlassCard>
        <GlassCard tone="cream" padding="md" className="lg:col-span-4 h-56">
          <div className="h-4 w-32 rounded bg-[#E8DDCC] dark:bg-[#2A2722] mb-4" />
          <div className="h-36 w-36 mx-auto rounded-full bg-[#E8DDCC]/65 dark:bg-[#2A2722]/65" />
        </GlassCard>
      </div>
    </div>
  );
};

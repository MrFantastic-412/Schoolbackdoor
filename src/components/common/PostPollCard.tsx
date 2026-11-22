import React from 'react';
import { BarChart3, Check } from 'lucide-react';
import { PostPoll } from '../../types';
import { triggerHaptic } from '../../utils/haptics';

interface PostPollCardProps {
  postId: string;
  poll: PostPoll;
  onVote?: (postId: string, optionId: string) => void;
  disabled?: boolean;
}

export const PostPollCard: React.FC<PostPollCardProps> = ({
  postId,
  poll,
  onVote,
  disabled = false,
}) => {
  const userVotedSet = new Set(poll.userVotedOptionIds || []);
  const hasVoted = userVotedSet.size > 0;
  const totalVotes = Math.max(0, Number(poll.totalVotes || 0));

  const maxVotes = poll.options.reduce((max, o) => Math.max(max, o.votes), 0);

  return (
    <div
      className="mt-3 rounded-2xl border border-[#171613]/12 dark:border-[#F5EFE3]/12 bg-[#FFFCF7]/75 dark:bg-[#23211C]/80 p-3.5 flex flex-col gap-2.5"
      aria-label="Interactive poll"
    >
      {poll.question && (
        <div className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] leading-snug">
          {poll.question}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {poll.options.map((opt) => {
          const isSelected = userVotedSet.has(opt.id);
          const pct = totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0;
          const isLeading = hasVoted && maxVotes > 0 && opt.votes === maxVotes;

          return (
            <button
              key={opt.id}
              type="button"
              disabled={disabled || !onVote}
              onClick={() => {
                triggerHaptic('like');
                onVote?.(postId, opt.id);
              }}
              aria-pressed={isSelected}
              className={`relative w-full min-h-[44px] px-3.5 py-2 rounded-xl border text-left overflow-hidden transition-colors cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C4718E] ${
                isSelected
                  ? 'border-[#C4718E] bg-[#FFFCF7] dark:bg-[#181714]'
                  : 'border-[#171613]/12 dark:border-[#F5EFE3]/12 bg-[#FFFCF7]/90 dark:bg-[#181714]/80 hover:border-[#D98BA5] hover:bg-[#F6E2E6]/35 dark:hover:bg-[#D98BA5]/12'
              }`}
            >
              {hasVoted && (
                <div
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 transition-all duration-300 ease-out ${
                    isSelected
                      ? 'bg-[#D98BA5]/35 dark:bg-[#D98BA5]/30'
                      : isLeading
                      ? 'bg-[#D98BA5]/20 dark:bg-[#D98BA5]/18'
                      : 'bg-[#E8DDCC]/70 dark:bg-[#F5EFE3]/10'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              )}

              <div className="relative z-10 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-4 h-4 ${poll.allowMultiple ? 'rounded-[5px]' : 'rounded-full'} border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected
                        ? 'bg-[#171613] border-[#171613] text-[#F5EFE3] dark:bg-[#D98BA5] dark:border-[#D98BA5] dark:text-[#171613]'
                        : 'border-[#82796F]/55 dark:border-[#A89F95]/55 bg-[#FFFCF7] dark:bg-[#23211C]'
                    }`}
                  >
                    {isSelected && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                  </span>
                  <span
                    className={`text-xs sm:text-[13px] leading-snug break-words ${
                      isSelected || isLeading
                        ? 'font-semibold text-[#171613] dark:text-[#F5EFE3]'
                        : 'font-medium text-[#171613]/90 dark:text-[#F5EFE3]/90'
                    }`}
                  >
                    {opt.label}
                  </span>
                </span>

                {hasVoted && (
                  <span className="text-xs font-mono font-semibold text-[#171613] dark:text-[#F5EFE3] tabular-nums shrink-0">
                    {pct}%
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-[#82796F] dark:text-[#A89F95]">
        <div className="flex items-center gap-1.5 tabular-nums">
          <BarChart3 className="w-3.5 h-3.5 text-[#C4718E] shrink-0" />
          <span className="font-mono font-medium text-[#171613]/85 dark:text-[#F5EFE3]/85">
            {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
          </span>
          <span aria-hidden="true">·</span>
          <span>{poll.allowMultiple ? 'Multiple choices allowed' : 'Single choice'}</span>
        </div>

        <span className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
          {hasVoted
            ? poll.allowMultiple
              ? 'Tap to toggle'
              : 'Tap option to switch'
            : 'Tap to vote'}
        </span>
      </div>
    </div>
  );
};

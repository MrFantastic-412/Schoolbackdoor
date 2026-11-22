import React, { useMemo } from 'react';
import { ResolvedMention } from '../../types';
import { tokenizeMentionText } from '../../utils/mentions';
import { triggerHaptic } from '../../utils/haptics';

interface MentionTextProps {
  text: string;
  mentions?: ResolvedMention[];
  onMentionClick?: (userId: string) => void;
  bubbleTone?: 'default' | 'dark';
  className?: string;
}

export const MentionText: React.FC<MentionTextProps> = ({
  text,
  mentions,
  onMentionClick,
  bubbleTone = 'default',
  className = '',
}) => {
  const segments = useMemo(() => tokenizeMentionText(text, mentions), [mentions, text]);

  return (
    <span className={className}>
      {segments.map((seg, idx) => {
        if (seg.type === 'text') {
          return <React.Fragment key={idx}>{seg.value}</React.Fragment>;
        }

        const pillStyles =
          bubbleTone === 'dark'
            ? 'text-[#F0B4C7] hover:text-[#FFFCF7] bg-[#D98BA5]/18 hover:bg-[#D98BA5]/30 underline decoration-[#D98BA5]/55 underline-offset-2'
            : 'text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#FFFCF7] bg-[#F6E2E6]/65 dark:bg-[#D98BA5]/16 hover:bg-[#F6E2E6] dark:hover:bg-[#D98BA5]/28';

        if (!onMentionClick) {
          return (
            <span
              key={`${seg.mention.userId}-${idx}`}
              className={`font-semibold rounded px-1 py-0.5 transition-colors inline ${pillStyles}`}
            >
              {seg.value}
            </span>
          );
        }

        return (
          <button
            key={`${seg.mention.userId}-${idx}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              triggerHaptic('tap');
              onMentionClick(seg.mention.userId);
            }}
            title={`View ${seg.mention.name}'s profile (${seg.mention.handle})`}
            aria-label={`View profile for ${seg.mention.name} ${seg.mention.handle}`}
            className={`font-semibold rounded px-1 py-0.5 transition-colors inline cursor-pointer focus-visible:outline-2 focus-visible:outline-[#D98BA5] ${pillStyles}`}
          >
            {seg.value}
          </button>
        );
      })}
    </span>
  );
};

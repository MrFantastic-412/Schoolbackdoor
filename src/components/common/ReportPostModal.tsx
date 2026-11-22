import React, { useEffect, useState } from 'react';
import { Flag, ShieldAlert } from 'lucide-react';
import { Post } from '../../types';
import { GlassButton, GlassModal } from '../glass';
import { triggerHaptic } from '../../utils/haptics';

interface ReportPostModalProps {
  post: Post | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (postId: string, reason: string, details?: string) => Promise<void>;
}

const REPORT_REASONS = [
  {
    id: 'Harassment, bullying, or hate speech',
    label: 'Harassment, bullying, or hate speech',
    hint: 'Targeted insults, threats, or discriminatory remarks.',
  },
  {
    id: 'Inappropriate or explicit media',
    label: 'Inappropriate or explicit media',
    hint: 'NSFW, graphic, or non-consensual content.',
  },
  {
    id: 'Spam, phishing, or scam',
    label: 'Spam, phishing, or scam',
    hint: 'Fraudulent links, payment scams, or unsolicited promotions.',
  },
  {
    id: 'Misinformation or fake official circular',
    label: 'Misinformation or fake circular',
    hint: 'Fabricated Senate, SUG, or examination notices.',
  },
  {
    id: 'Privacy violation or doxxing',
    label: 'Privacy violation or doxxing',
    hint: 'Sharing private phone numbers, matric records, or hostel locations without consent.',
  },
  {
    id: 'Other campus policy violation',
    label: 'Other policy violation',
    hint: 'Any other breach of community guidelines.',
  },
];

export const ReportPostModal: React.FC<ReportPostModalProps> = ({
  post,
  isOpen,
  onClose,
  onSubmit,
}) => {
  const [selectedReason, setSelectedReason] = useState(REPORT_REASONS[0].id);
  const [details, setDetails] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedReason(REPORT_REASONS[0].id);
      setDetails('');
      setError(null);
      setIsSubmitting(false);
    }
  }, [isOpen, post?.id]);

  if (!post) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit(post.id, selectedReason, details.trim() || undefined);
      triggerHaptic('success');
      onClose();
    } catch (err: any) {
      triggerHaptic('error');
      setError(err?.message || 'Could not submit report. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <GlassModal
      isOpen={isOpen}
      onClose={onClose}
      title="Flag Inappropriate Dispatch"
      subtitle="Submit a confidential moderation report to the Schoolbackdoor Admin"
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4 text-xs">
        <div className="p-3 rounded-2xl bg-[#E8DDCC]/45 dark:bg-[#23211C] border border-[#171613]/10 dark:border-[#F5EFE3]/10 space-y-1">
          <div className="flex items-center justify-between gap-2 text-[11px] text-[#82796F] dark:text-[#A89F95]">
            <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
              {post.authorName} ({post.authorHandle})
            </span>
            <span className="font-mono">{post.department}</span>
          </div>
          <p className="text-xs text-[#171613]/85 dark:text-[#F5EFE3]/85 line-clamp-2 leading-relaxed">{post.content}</p>
        </div>

        <div className="space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#82796F] dark:text-[#A89F95]">
            Reason for flagging
          </label>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {REPORT_REASONS.map((r) => {
              const active = selectedReason === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setSelectedReason(r.id);
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#F6E2E6]/80 dark:bg-[#D98BA5]/20 border-[#C4718E] text-[#171613] dark:text-[#F5EFE3]'
                      : 'bg-[#FFFCF7]/70 dark:bg-[#1E1C18] border-[#171613]/10 dark:border-[#F5EFE3]/10 text-[#171613] dark:text-[#F5EFE3] hover:bg-[#FFFCF7] dark:hover:bg-[#23211C]'
                  }`}
                >
                  <div className="font-semibold text-xs">{r.label}</div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-0.5">{r.hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#82796F] dark:text-[#A89F95]">
            Additional context (optional)
          </label>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={400}
            rows={2}
            placeholder="Describe why this post violates campus safety or community policies..."
            className="w-full p-3 glass-input rounded-xl text-xs text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] resize-none"
          />
        </div>

        <div className="flex items-start gap-2 text-[11px] text-[#82796F] dark:text-[#A89F95] bg-[#FFFCF7]/70 dark:bg-[#1E1C18] px-3 py-2 rounded-xl border border-[#171613]/8 dark:border-[#F5EFE3]/10">
          <ShieldAlert className="w-3.5 h-3.5 text-[#C4718E] shrink-0 mt-0.5" />
          <span>
            Admins receive an instant moderation alert. Your student identity remains confidential from the post author.
          </span>
        </div>

        {error && (
          <div className="p-2.5 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#C4718E] text-xs text-[#171613] dark:text-[#F5EFE3] font-medium">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-[#171613]/10 dark:border-[#F5EFE3]/10">
          <GlassButton type="button" variant="ghost" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </GlassButton>
          <GlassButton type="submit" variant="pink" size="sm" loading={isSubmitting} disabled={isSubmitting}>
            <Flag className="w-3.5 h-3.5" />
            <span>{isSubmitting ? 'Submitting Report...' : 'Submit Report'}</span>
          </GlassButton>
        </div>
      </form>
    </GlassModal>
  );
};

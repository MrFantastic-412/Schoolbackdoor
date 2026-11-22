import React, { useEffect, useState } from 'react';
import { AlertCircle, Search, ShieldCheck } from 'lucide-react';
import { EligibleChatPartner } from '../../types';
import { api } from '../../api/client';
import { GlassInput, GlassModal } from '../glass';
import { UserAvatar } from '../common/UserAvatar';
import { useDebounce } from '../../utils/useDebounce';
import { triggerHaptic } from '../../utils/haptics';

interface NewChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onChatSelected: (chatId: string) => void;
}

export const NewChatModal: React.FC<NewChatModalProps> = ({
  isOpen,
  onClose,
  onChatSelected,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedQuery = useDebounce(searchQuery, 250);
  const [partners, setPartners] = useState<EligibleChatPartner[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setPartners([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    api
      .searchEligibleChatPartners(debouncedQuery)
      .then((results) => {
        if (!cancelled) setPartners(results);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || 'Failed to search students.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, isOpen]);

  if (!isOpen) return null;

  const handleStartChat = async (partner: EligibleChatPartner) => {
    triggerHaptic('tap');
    setIsCreating(true);
    setError(null);
    try {
      const res = await api.createDirectChat(partner.userId);
      triggerHaptic('success');
      onChatSelected(res.chatId);
      onClose();
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Cannot start conversation.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <GlassModal
      isOpen={isOpen}
      onClose={onClose}
      title="New Direct Conversation"
      subtitle="Search verified coursemates across student circles"
      maxWidthClass="max-w-md"
    >
      <div className="flex flex-col max-h-[70vh]">
        <div className="p-4 border-b border-[#171613]/10 dark:border-white/10">
          <GlassInput
            type="text"
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="w-4 h-4" />}
            placeholder="Search by name, @handle, or department..."
          />
        </div>

        {error && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/70 border border-[#D98BA5] text-[#171613] dark:text-[#F5EFE3] text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-2.5 overflow-y-auto flex-1 divide-y divide-[#171613]/8 dark:divide-white/8">
          {isLoading ? (
            <div className="py-8 text-center text-xs text-[#82796F] dark:text-[#A89F95] font-mono">
              Searching campus directory...
            </div>
          ) : partners.length > 0 ? (
            partners.map((p) => (
              <button
                key={p.userId}
                type="button"
                onClick={() => handleStartChat(p)}
                disabled={isCreating}
                className="w-full p-2.5 min-h-[48px] flex items-center justify-between gap-3 hover:bg-[#FFFCF7]/75 dark:hover:bg-white/8 rounded-xl transition-colors text-left cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <UserAvatar
                    name={p.name}
                    initials={p.avatarInitials}
                    avatarUrl={p.avatarUrl}
                    avatarThumbUrl={p.avatarThumbUrl}
                    size="md"
                  />
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] truncate">
                        {p.name}
                      </span>
                      {p.verified && <ShieldCheck className="w-3.5 h-3.5 text-[#D98BA5] shrink-0" />}
                    </div>
                    <span className="text-[11px] text-[#82796F] dark:text-[#A89F95] font-mono truncate">
                      {p.handle} · {p.department} ({p.level})
                    </span>
                  </div>
                </div>

                <span className="text-[11px] px-3 py-1.5 rounded-xl bg-[#D98BA5] text-[#171613] font-semibold shrink-0">
                  Message
                </span>
              </button>
            ))
          ) : (
            <div className="py-8 text-center text-xs text-[#82796F] dark:text-[#A89F95]">
              {searchQuery ? 'No students found matching that name or handle.' : 'Type a name or handle to find coursemates.'}
            </div>
          )}
        </div>

        <div className="p-3 bg-[#E8DDCC]/40 dark:bg-white/5 border-t border-[#171613]/10 dark:border-white/10 text-[11px] text-[#82796F] dark:text-[#A89F95] text-center">
          Respects campus privacy &amp; mutual blocking restrictions · Dispatches expire in 72h
        </div>
      </div>
    </GlassModal>
  );
};

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AtSign, Loader2, ShieldCheck } from 'lucide-react';
import { MentionCandidate } from '../../types';
import { api } from '../../api/client';
import { ActiveMentionQuery, findActiveMentionQuery } from '../../utils/mentions';
import { UserAvatar } from './UserAvatar';
import { triggerHaptic } from '../../utils/haptics';

interface UseMentionAutocompleteOptions {
  value: string;
  onChange: (nextValue: string) => void;
  chatId?: string;
  communityId?: string;
  enabled?: boolean;
  maxLength?: number;
}

export function useMentionAutocomplete({
  value,
  onChange,
  chatId,
  communityId,
  enabled = true,
  maxLength,
}: UseMentionAutocompleteOptions) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const requestSeqRef = useRef(0);
  const [activeQuery, setActiveQuery] = useState<ActiveMentionQuery | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const dismiss = useCallback(() => {
    setActiveQuery(null);
    setCandidates([]);
    setSelectedIndex(0);
  }, []);

  const syncFromCursor = useCallback(
    (nextText: string, cursorPos: number | null | undefined) => {
      if (!enabled) {
        setActiveQuery(null);
        return;
      }
      const detected = findActiveMentionQuery(nextText, cursorPos);
      setActiveQuery(detected);
      if (detected) {
        setSelectedIndex(0);
      } else {
        setCandidates([]);
      }
    },
    [enabled]
  );

  // Close popup automatically if input becomes empty externally (e.g. after submit)
  useEffect(() => {
    if (!value) {
      setActiveQuery(null);
      setCandidates([]);
    }
  }, [value]);

  // Debounced candidate query
  useEffect(() => {
    if (!enabled || !activeQuery) {
      setIsLoading(false);
      return;
    }

    if (!api.hasActiveSession()) {
      setCandidates([]);
      setIsLoading(false);
      return;
    }

    const seq = ++requestSeqRef.current;
    setIsLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const list = await api.getMentionCandidates({
          q: activeQuery.query,
          chatId,
          communityId,
          limit: 8,
        });
        if (requestSeqRef.current === seq) {
          setCandidates(list);
          setSelectedIndex(0);
        }
      } catch {
        if (requestSeqRef.current === seq) {
          setCandidates([]);
        }
      } finally {
        if (requestSeqRef.current === seq) {
          setIsLoading(false);
        }
      }
    }, 110);

    return () => window.clearTimeout(timer);
  }, [activeQuery, chatId, communityId, enabled]);

  const selectCandidate = useCallback(
    (candidate: MentionCandidate) => {
      if (!activeQuery) return;
      triggerHaptic('tap');

      const handleText = candidate.handle.startsWith('@')
        ? candidate.handle
        : `@${candidate.handle}`;
      const inserted = `${handleText} `;
      const before = value.slice(0, activeQuery.startIndex);
      const after = value.slice(activeQuery.endIndex);
      let nextValue = `${before}${inserted}${after}`;
      let nextCaret = before.length + inserted.length;

      if (typeof maxLength === 'number' && nextValue.length > maxLength) {
        nextValue = nextValue.slice(0, maxLength);
        nextCaret = Math.min(nextCaret, nextValue.length);
      }

      onChange(nextValue);
      dismiss();

      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          try {
            el.setSelectionRange(nextCaret, nextCaret);
          } catch {
            // ignore selection errors on unsupported elements
          }
        }
      });
    },
    [activeQuery, dismiss, maxLength, onChange, value]
  );

  const handleValueChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const nextText = e.target.value;
      const cursor = e.target.selectionStart;
      onChange(nextText);
      syncFromCursor(nextText, cursor);
    },
    [onChange, syncFromCursor]
  );

  const handleCursorEvent = useCallback(
    (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const target = e.currentTarget;
      syncFromCursor(target.value, target.selectionStart);
    },
    [syncFromCursor]
  );

  /**
   * Handles dropdown keyboard navigation.
   * Returns `true` when the key event was consumed (e.g. Enter selecting a candidate).
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean => {
      if (!activeQuery) return false;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        return true;
      }

      if (candidates.length === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % candidates.length);
        return true;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
        return true;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        const chosen = candidates[selectedIndex] || candidates[0];
        if (chosen) {
          e.preventDefault();
          e.stopPropagation();
          selectCandidate(chosen);
          return true;
        }
      }

      return false;
    },
    [activeQuery, candidates, dismiss, selectCandidate, selectedIndex]
  );

  return {
    inputRef,
    activeQuery,
    candidates,
    isLoading,
    selectedIndex,
    isOpen: Boolean(activeQuery && (candidates.length > 0 || isLoading || activeQuery.query.length > 0)),
    selectCandidate,
    dismiss,
    handleValueChange,
    handleCursorEvent,
    handleKeyDown,
  };
}

interface MentionSuggestionsDropdownProps {
  isOpen: boolean;
  candidates: MentionCandidate[];
  isLoading: boolean;
  selectedIndex: number;
  query: string;
  placement?: 'above' | 'below';
  onSelect: (candidate: MentionCandidate) => void;
  className?: string;
}

export const MentionSuggestionsDropdown: React.FC<MentionSuggestionsDropdownProps> = ({
  isOpen,
  candidates,
  isLoading,
  selectedIndex,
  query,
  placement = 'below',
  onSelect,
  className = '',
}) => {
  if (!isOpen) return null;

  const positionClass =
    placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-1.5';

  return (
    <div
      role="listbox"
      aria-label="Mention suggestions"
      className={`absolute left-0 right-0 ${positionClass} z-50 glass-strong rounded-2xl border border-[#171613]/14 dark:border-[#F5EFE3]/16 shadow-xl overflow-hidden animate-sb-in ${className}`}
    >
      <div className="px-3 py-1.5 border-b border-[#171613]/8 dark:border-[#F5EFE3]/10 flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#82796F] dark:text-[#A89F95] bg-[#FFFCF7]/60 dark:bg-[#1E1C18]/90">
        <span className="inline-flex items-center gap-1">
          <AtSign className="w-3 h-3 text-[#C4718E] dark:text-[#E5A4BA]" />
          <span>{query ? `Matches for @${query}` : 'Mention a member'}</span>
        </span>
        {isLoading && <Loader2 className="w-3 h-3 animate-spin text-[#C4718E]" />}
      </div>

      {candidates.length > 0 ? (
        <div className="max-h-56 overflow-y-auto divide-y divide-[#171613]/6 dark:divide-[#F5EFE3]/8">
          {candidates.map((c, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={c.userId}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseDown={(e) => {
                  // Prevent input blur before selection completes
                  e.preventDefault();
                  onSelect(c);
                }}
                className={`w-full px-3 py-2 min-h-[44px] flex items-center justify-between gap-2.5 text-left cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-[#F6E2E6]/85 dark:bg-[#D98BA5]/22'
                    : 'hover:bg-[#FFFCF7]/75 dark:hover:bg-[#2A2722]/75'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <UserAvatar
                    name={c.name}
                    initials={c.avatarInitials || 'SB'}
                    avatarUrl={c.avatarUrl}
                    avatarThumbUrl={c.avatarThumbUrl}
                    size="sm"
                  />
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3] truncate">
                        {c.name}
                      </span>
                      {c.verified && (
                        <ShieldCheck className="w-3 h-3 text-[#D98BA5] shrink-0" />
                      )}
                    </div>
                    <span className="text-[11px] font-mono text-[#82796F] dark:text-[#A89F95] truncate">
                      {c.handle} · {c.department}
                    </span>
                  </div>
                </div>

                {c.isConnected && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[#E8DDCC]/75 dark:bg-[#23211C] text-[#171613] dark:text-[#F5EFE3] shrink-0">
                    Connected
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-3.5 py-3 text-xs text-[#82796F] dark:text-[#A89F95]">
          {isLoading ? 'Looking up usernames...' : `No matching member found for "@${query}"`}
        </div>
      )}
    </div>
  );
};

interface MentionInputProps {
  as?: 'input' | 'textarea';
  value: string;
  onChange: (nextValue: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
  containerClassName?: string;
  chatId?: string;
  communityId?: string;
  placement?: 'above' | 'below';
  ariaLabel?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

export const MentionInput: React.FC<MentionInputProps> = ({
  as = 'textarea',
  value,
  onChange,
  placeholder,
  rows = 3,
  maxLength,
  disabled = false,
  required = false,
  autoFocus = false,
  className = '',
  containerClassName = 'relative w-full',
  chatId,
  communityId,
  placement = 'below',
  ariaLabel,
  onKeyDown,
}) => {
  const mention = useMentionAutocomplete({
    value,
    onChange,
    chatId,
    communityId,
    enabled: !disabled,
    maxLength,
  });

  const handleCombinedKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const consumed = mention.handleKeyDown(e);
    if (!consumed) {
      onKeyDown?.(e);
    }
  };

  return (
    <div className={containerClassName}>
      <MentionSuggestionsDropdown
        isOpen={mention.isOpen}
        candidates={mention.candidates}
        isLoading={mention.isLoading}
        selectedIndex={mention.selectedIndex}
        query={mention.activeQuery?.query || ''}
        placement={placement}
        onSelect={mention.selectCandidate}
      />

      {as === 'textarea' ? (
        <textarea
          ref={mention.inputRef as React.RefObject<HTMLTextAreaElement>}
          value={value}
          onChange={mention.handleValueChange}
          onClick={mention.handleCursorEvent}
          onKeyUp={mention.handleCursorEvent}
          onKeyDown={handleCombinedKeyDown}
          onBlur={() => window.setTimeout(mention.dismiss, 160)}
          placeholder={placeholder}
          rows={rows}
          maxLength={maxLength}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          className={className}
        />
      ) : (
        <input
          ref={mention.inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={value}
          onChange={mention.handleValueChange}
          onClick={mention.handleCursorEvent}
          onKeyUp={mention.handleCursorEvent}
          onKeyDown={handleCombinedKeyDown}
          onBlur={() => window.setTimeout(mention.dismiss, 160)}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          className={className}
        />
      )}
    </div>
  );
};

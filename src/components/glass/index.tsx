import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, X } from 'lucide-react';
import { triggerHaptic } from '../../utils/haptics';

let openModalStackCount = 0;
let previousBodyOverflow = '';

export interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'subtle' | 'cream' | 'strong' | 'dark' | 'pink';
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export const GlassCard: React.FC<GlassCardProps> = ({
  tone = 'cream',
  padding = 'md',
  className = '',
  children,
  ...props
}) => {
  const toneClass =
    tone === 'subtle'
      ? 'glass-subtle text-[#171613] dark:text-[#F5EFE3]'
      : tone === 'strong'
      ? 'glass-strong text-[#171613] dark:text-[#F5EFE3]'
      : tone === 'dark'
      ? 'glass-dark text-[#F5EFE3]'
      : tone === 'pink'
      ? 'glass-pink-tint text-[#171613] dark:text-[#F5EFE3]'
      : 'glass-cream text-[#171613] dark:text-[#F5EFE3]';

  const padClass =
    padding === 'none'
      ? ''
      : padding === 'sm'
      ? 'p-3.5'
      : padding === 'lg'
      ? 'p-5 md:p-6'
      : 'p-4 md:p-5';

  return (
    <div className={`rounded-2xl transition-all duration-150 ${toneClass} ${padClass} ${className}`} {...props}>
      {children}
    </div>
  );
};

export interface GlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'pink' | 'black' | 'glass' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const GlassButton: React.FC<GlassButtonProps> = ({
  variant = 'pink',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  type = 'button',
  onClick,
  ...props
}) => {
  const variantClass =
    variant === 'pink'
      ? 'glass-pink text-[#171613] font-semibold hover:brightness-[1.03] active:scale-[0.985]'
      : variant === 'black'
      ? 'bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613] border border-[#FFFCF7]/18 dark:border-[#F5EFE3]/25 shadow-[0_8px_20px_-8px_rgba(23,22,19,0.45)] hover:bg-[#262420] dark:hover:bg-[#E8DDCC] active:scale-[0.985]'
      : variant === 'ghost'
      ? 'bg-transparent text-[#171613] dark:text-[#F5EFE3] hover:bg-[#171613]/6 dark:hover:bg-[#F5EFE3]/10 active:scale-[0.985]'
      : 'glass-cream text-[#171613] dark:text-[#F5EFE3] hover:bg-[#FFFCF7]/95 dark:hover:bg-[#23211C] active:scale-[0.985]';

  const sizeClass =
    size === 'sm'
      ? 'min-h-[36px] px-3.5 py-1.5 text-xs rounded-xl'
      : size === 'lg'
      ? 'min-h-[46px] px-5.5 py-2.5 text-sm rounded-xl'
      : 'min-h-[42px] px-4.5 py-2 text-xs md:text-sm rounded-xl';

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!disabled && !loading) {
      triggerHaptic('tap');
    }
    onClick?.(e);
  };

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={handleClick}
      className={`inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${variantClass} ${sizeClass} ${className}`}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0"
        />
      )}
      {children}
    </button>
  );
};

export interface GlassInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  leftIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  errorText?: string;
}

export const GlassInput: React.FC<GlassInputProps> = ({
  label,
  leftIcon,
  rightSlot,
  errorText,
  className = '',
  id,
  ...props
}) => {
  const inputId = id || (label ? `sb-input-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined);
  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-[11px] font-semibold tracking-wide text-[#82796F] dark:text-[#A89F95] uppercase mb-1.5"
        >
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {leftIcon && (
          <span className="absolute left-3.5 text-[#82796F] dark:text-[#A89F95] pointer-events-none flex items-center">
            {leftIcon}
          </span>
        )}
        <input
          id={inputId}
          className={`w-full min-h-[42px] glass-input rounded-xl py-2.5 text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F]/80 dark:placeholder:text-[#A89F95]/65 ${
            leftIcon ? 'pl-10' : 'pl-3.5'
          } ${rightSlot ? 'pr-11' : 'pr-3.5'} ${className}`}
          {...props}
        />
        {rightSlot && (
          <div className="absolute right-2 flex items-center">{rightSlot}</div>
        )}
      </div>
      {errorText && (
        <p className="mt-1 text-[11px] font-medium text-[#171613] dark:text-[#F5EFE3] bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5]/45 px-2.5 py-1 rounded-lg">
          {errorText}
        </p>
      )}
    </div>
  );
};

export interface GlassTabItem<T extends string = string> {
  id: T;
  label: string;
  count?: number;
  icon?: React.ReactNode;
}

export interface GlassTabProps<T extends string = string> {
  items: GlassTabItem<T>[];
  activeId: T;
  onChange: (id: T) => void;
  variant?: 'cream' | 'dark' | 'pink';
  className?: string;
}

export function GlassTab<T extends string = string>({
  items,
  activeId,
  onChange,
  variant = 'cream',
  className = '',
}: GlassTabProps<T>) {
  return (
    <div
      role="tablist"
      className={`inline-flex flex-wrap max-w-full items-center gap-1 p-1 rounded-xl ${
        variant === 'dark' ? 'bg-[#171613] text-[#F5EFE3]' : 'glass-subtle'
      } ${className}`}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onChange(item.id);
            }}
            className={`inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
              active
                ? variant === 'pink'
                  ? 'glass-pink text-[#171613] font-semibold'
                  : variant === 'dark'
                  ? 'glass-pink text-[#171613] font-semibold'
                  : 'bg-[#171613] text-[#F5EFE3] dark:bg-[#F5EFE3] dark:text-[#171613] font-semibold shadow-xs'
                : variant === 'dark'
                ? 'text-[#F5EFE3]/75 hover:text-[#F5EFE3]'
                : 'text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] hover:bg-[#FFFCF7]/70 dark:hover:bg-[#F5EFE3]/8'
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.count !== undefined && (
              <span
                className={`text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-md ${
                  active
                    ? variant === 'pink'
                      ? 'bg-[#171613] text-[#F5EFE3]'
                      : 'bg-[#D98BA5] text-[#171613]'
                    : 'bg-[#E8DDCC] dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3]'
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface GlassNavigationProps {
  className?: string;
  children: React.ReactNode;
}

export const GlassNavigation: React.FC<GlassNavigationProps> = ({ className = '', children }) => (
  <nav
    className={`glass-strong rounded-2xl px-2 py-1.5 flex items-center justify-around ${className}`}
  >
    {children}
  </nav>
);

export interface GlassSidebarProps {
  className?: string;
  children: React.ReactNode;
}

export const GlassSidebar: React.FC<GlassSidebarProps> = ({ className = '', children }) => (
  <aside
    className={`bg-[#171613] text-[#F5EFE3] border-r border-[#F5EFE3]/10 shadow-[8px_0_32px_-14px_rgba(23,22,19,0.48)] relative overflow-hidden ${className}`}
  >
    <div
      className="pointer-events-none absolute -top-24 -right-24 w-56 h-56 rounded-full bg-[#D98BA5]/12 blur-3xl"
      aria-hidden="true"
    />
    <div
      className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-[#FFFCF7]/25 via-[#D98BA5]/25 to-transparent"
      aria-hidden="true"
    />
    {children}
  </aside>
);

export interface GlassModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  maxWidthClass?: string;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
}

export const GlassModal: React.FC<GlassModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  maxWidthClass = 'max-w-lg',
  headerRight,
  children,
}) => {
  const handleDismiss = () => {
    triggerHaptic('close');
    onClose();
  };

  useEffect(() => {
    if (!isOpen) return;
    if (openModalStackCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openModalStackCount += 1;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        triggerHaptic('close');
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      openModalStackCount = Math.max(0, openModalStackCount - 1);
      if (openModalStackCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          handleDismiss();
        }
      }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-[#171613]/55 dark:bg-black/72 backdrop-blur-sm animate-sb-in"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`glass-strong w-full ${maxWidthClass} rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[92dvh] sm:max-h-[90dvh] pb-[env(safe-area-inset-bottom)] sm:pb-0 animate-sb-sheet`}
      >
        {(title || headerRight) && (
          <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 flex items-center justify-between gap-2.5 bg-[#FFFCF7]/70 dark:bg-[#181714]/88 shrink-0">
            <div className="min-w-0">
              {title && (
                <h2 className="font-serif font-bold text-base sm:text-lg text-[#171613] dark:text-[#F5EFE3] truncate">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="text-[11px] text-[#82796F] dark:text-[#A89F95] truncate mt-0.5">{subtitle}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {headerRight}
              <button
                type="button"
                onClick={handleDismiss}
                aria-label="Close dialog"
                className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#E8DDCC]/70 dark:bg-[#2A2722] text-[#171613] dark:text-[#F5EFE3] hover:bg-[#D98BA5]/30 dark:hover:bg-[#D98BA5]/25 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
        <div className="overflow-y-auto overscroll-contain flex-1 min-h-0">{children}</div>
      </div>
    </div>
  );
};

export interface GlassDropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export interface GlassDropdownProps {
  value: string;
  options: GlassDropdownOption[];
  onChange: (value: string) => void;
  label?: string;
  className?: string;
}

export const GlassDropdown: React.FC<GlassDropdownProps> = ({
  value,
  options,
  onChange,
  label,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeOption = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {label && (
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-[#82796F] dark:text-[#A89F95] mb-1.5">
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          triggerHaptic('tap');
          setOpen((o) => !o);
        }}
        className="w-full min-h-[42px] px-3.5 py-2 rounded-xl glass-input flex items-center justify-between gap-2 text-xs md:text-sm font-medium text-[#171613] dark:text-[#F5EFE3] cursor-pointer"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="flex items-center gap-2 truncate">
          {activeOption?.icon}
          <span className="truncate">{activeOption?.label}</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-[#82796F] dark:text-[#A89F95] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 mt-1.5 z-40 glass-strong rounded-xl p-1.5 shadow-xl max-h-60 overflow-y-auto animate-sb-in"
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                role="option"
                aria-selected={selected}
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full min-h-[38px] px-3 py-2 rounded-lg text-left text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                  selected
                    ? 'bg-[#D98BA5]/25 text-[#171613] dark:text-[#F5EFE3] font-semibold'
                    : 'text-[#171613] dark:text-[#F5EFE3] hover:bg-[#E8DDCC]/60 dark:hover:bg-[#2A2722]'
                }`}
              >
                {opt.icon}
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export interface GlassNotificationProps {
  message: string | null;
  tone?: 'default' | 'success' | 'error';
  onDismiss?: () => void;
}

export const GlassNotification: React.FC<GlassNotificationProps> = ({
  message,
  tone = 'default',
  onDismiss,
}) => {
  if (!message) return null;
  const isError = tone === 'error';
  const isSuccess = tone === 'success';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live="polite"
      className={`fixed bottom-24 md:bottom-6 right-4 md:right-6 left-4 sm:left-auto z-50 max-w-sm px-4 py-3 rounded-xl text-xs font-medium flex items-center gap-2.5 animate-sb-in ${
        isError
          ? 'bg-[#3D1C26] text-[#FFFCF7] border border-[#D98BA5]/55 shadow-xl'
          : 'glass-dark text-[#F5EFE3]'
      }`}
    >
      {isError ? (
        <AlertCircle className="w-4 h-4 text-[#F3B6C9] shrink-0" />
      ) : isSuccess ? (
        <CheckCircle2 className="w-4 h-4 text-[#D98BA5] shrink-0" />
      ) : (
        <span className="w-2 h-2 rounded-full bg-[#D98BA5] shrink-0" />
      )}
      <span className="leading-snug flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={() => {
            triggerHaptic('close');
            onDismiss();
          }}
          aria-label="Dismiss notification"
          className="text-[#F5EFE3]/65 hover:text-[#F5EFE3] p-1 rounded-lg cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};

export interface GlassFloatingActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  label?: string;
}

export const GlassFloatingActionButton: React.FC<GlassFloatingActionButtonProps> = ({
  icon,
  label,
  className = '',
  onClick,
  ...props
}) => (
  <button
    type="button"
    aria-label={label || 'Create'}
    onClick={(e) => {
      triggerHaptic('tap');
      onClick?.(e);
    }}
    className={`glass-pink text-[#171613] rounded-xl flex items-center justify-center gap-2 transition-all hover:brightness-[1.04] active:scale-95 cursor-pointer ${
      label ? 'h-11 px-4 font-semibold text-xs' : 'w-11 h-11'
    } ${className}`}
    {...props}
  >
    {icon}
    {label && <span>{label}</span>}
  </button>
);

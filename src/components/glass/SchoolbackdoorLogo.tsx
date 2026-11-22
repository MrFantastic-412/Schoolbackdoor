import React from 'react';

interface SchoolbackdoorLogoProps {
  variant?: 'light' | 'dark' | 'pink';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const APP_LOGO_SRC = '/assets/aistudio/cbl_1989ed48.png';

/**
 * Official Schoolbackdoor brand door mark.
 */
export const SchoolbackdoorLogo: React.FC<SchoolbackdoorLogoProps> = ({
  variant = 'dark',
  size = 'md',
  className = '',
}) => {
  const dim =
    size === 'sm'
      ? 'w-8 h-8'
      : size === 'lg'
      ? 'w-14 h-14'
      : size === 'xl'
      ? 'w-20 h-20'
      : 'w-10 h-10';

  const shadowClass =
    variant === 'light'
      ? 'drop-shadow-[0_3px_10px_rgba(217,139,165,0.24)]'
      : 'drop-shadow-[0_4px_10px_rgba(23,22,19,0.16)] dark:drop-shadow-[0_4px_12px_rgba(217,139,165,0.2)]';

  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 select-none ${dim} ${className}`}
      aria-hidden="true"
    >
      <img
        src={APP_LOGO_SRC}
        alt=""
        decoding="async"
        className={`w-full h-full object-contain ${shadowClass}`}
      />
    </span>
  );
};

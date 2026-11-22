import React, { useEffect, useState } from 'react';
import { getThumbnailUrl, resolveMediaUrl } from '../../utils/mediaUrl';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

interface UserAvatarProps {
  name?: string;
  initials?: string;
  bg?: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  isAnonymous?: boolean;
  size?: AvatarSize;
  className?: string;
  alt?: string;
}

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: 'w-7 h-7 text-[10px]',
  sm: 'w-8 h-8 text-[11px]',
  md: 'w-10 h-10 text-xs',
  lg: 'w-12 h-12 text-sm',
  xl: 'w-16 h-16 text-lg',
  '2xl': 'w-24 h-24 text-2xl',
};

export const UserAvatar: React.FC<UserAvatarProps> = ({
  name,
  initials,
  bg,
  avatarUrl,
  avatarThumbUrl,
  isAnonymous = false,
  size = 'md',
  className = '',
  alt,
}) => {
  const safeThumb = isAnonymous ? '' : resolveMediaUrl(avatarThumbUrl) || getThumbnailUrl(avatarUrl);
  const safeFull = isAnonymous ? '' : resolveMediaUrl(avatarUrl);
  const primarySrc = safeThumb || safeFull;

  const [imgSrc, setImgSrc] = useState<string>(primarySrc);
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    setImgSrc(primarySrc);
    setFailed(false);
  }, [primarySrc]);

  const displayInitials = isAnonymous
    ? 'AN'
    : (initials || (name ? name.slice(0, 2) : 'SB')).slice(0, 2).toUpperCase();

  const bgClass = isAnonymous
    ? 'bg-stone-700 text-stone-100'
    : bg || 'bg-stone-800 text-stone-100 dark:bg-stone-200 dark:text-stone-900';

  const handleImgError = () => {
    if (safeFull && imgSrc !== safeFull) {
      setImgSrc(safeFull);
      return;
    }
    setFailed(true);
  };

  return (
    <div
      className={`rounded-full overflow-hidden flex items-center justify-center font-semibold shrink-0 select-none ${
        SIZE_CLASSES[size]
      } ${!imgSrc || failed ? bgClass : 'bg-stone-200 dark:bg-stone-800'} ${className}`}
    >
      {imgSrc && !failed ? (
        <img
          src={imgSrc}
          alt={alt || (isAnonymous ? 'Anonymous' : name || 'Profile picture')}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onError={handleImgError}
          className="w-full h-full object-cover"
        />
      ) : (
        <span>{displayInitials}</span>
      )}
    </div>
  );
};

import React, { memo } from 'react';
import { getThumbnailUrl, resolveMediaUrl } from '../../utils/mediaUrl';

interface PostImageGridProps {
  images: string[];
  onImageClick: (index: number) => void;
  className?: string;
}

const handleThumbError = (rawUrl: string) => (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.currentTarget;
  if (img.dataset.fallbackApplied === '1') return;
  img.dataset.fallbackApplied = '1';
  img.src = resolveMediaUrl(rawUrl);
};

export const PostImageGrid: React.FC<PostImageGridProps> = memo(({
  images,
  onImageClick,
  className = '',
}) => {
  if (!images || images.length === 0) return null;

  const count = images.length;

  if (count === 1) {
    return (
      <div
        className={`mt-3 rounded-xl overflow-hidden border border-[#171613]/10 dark:border-[#F5EFE3]/12 cursor-pointer bg-[#E8DDCC]/45 dark:bg-[#23211C]/70 group relative ${className}`}
        onClick={() => onImageClick(0)}
      >
        <img
          src={getThumbnailUrl(images[0])}
          onError={handleThumbError(images[0])}
          alt="Dispatch attachment"
          loading="lazy"
          decoding="async"
          className="w-full max-h-80 object-cover transition-transform duration-200 group-hover:scale-[1.01]"
        />
      </div>
    );
  }

  if (count === 2) {
    return (
      <div className={`mt-3 grid grid-cols-2 gap-2 rounded-xl overflow-hidden ${className}`}>
        {images.map((img, idx) => (
          <div
            key={idx}
            className="h-44 sm:h-52 rounded-lg overflow-hidden border border-[#171613]/10 dark:border-[#F5EFE3]/12 cursor-pointer bg-[#E8DDCC]/45 dark:bg-[#23211C]/70 group relative"
            onClick={() => onImageClick(idx)}
          >
            <img
              src={getThumbnailUrl(img)}
              onError={handleThumbError(img)}
              alt={`Attachment ${idx + 1}`}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            />
          </div>
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className={`mt-3 grid grid-cols-2 gap-2 rounded-xl overflow-hidden h-56 sm:h-64 ${className}`}>
        <div
          className="h-full rounded-lg overflow-hidden border border-[#171613]/10 dark:border-[#F5EFE3]/12 cursor-pointer bg-[#E8DDCC]/45 dark:bg-[#23211C]/70 group relative"
          onClick={() => onImageClick(0)}
        >
          <img
            src={getThumbnailUrl(images[0])}
            onError={handleThumbError(images[0])}
            alt="Attachment 1"
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        </div>
        <div className="grid grid-rows-2 gap-2 h-full">
          {images.slice(1, 3).map((img, idx) => (
            <div
              key={idx + 1}
              className="h-full rounded-lg overflow-hidden border border-[#171613]/10 dark:border-[#F5EFE3]/12 cursor-pointer bg-[#E8DDCC]/45 dark:bg-[#23211C]/70 group relative"
              onClick={() => onImageClick(idx + 1)}
            >
              <img
                src={getThumbnailUrl(img)}
                onError={handleThumbError(img)}
                alt={`Attachment ${idx + 2}`}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 4 images (2x2 grid)
  return (
    <div className={`mt-3 grid grid-cols-2 gap-2 rounded-xl overflow-hidden ${className}`}>
      {images.slice(0, 4).map((img, idx) => (
        <div
          key={idx}
          className="h-36 sm:h-44 rounded-lg overflow-hidden border border-[#171613]/10 dark:border-[#F5EFE3]/12 cursor-pointer bg-[#E8DDCC]/45 dark:bg-[#23211C]/70 group relative"
          onClick={() => onImageClick(idx)}
        >
          <img
            src={getThumbnailUrl(img)}
            onError={handleThumbError(img)}
            alt={`Attachment ${idx + 1}`}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        </div>
      ))}
    </div>
  );
});

PostImageGrid.displayName = 'PostImageGrid';

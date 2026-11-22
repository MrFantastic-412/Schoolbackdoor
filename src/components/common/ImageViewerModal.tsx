import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ImageOff, Maximize2, Minimize2, X } from 'lucide-react';
import { getThumbnailUrl, resolveMediaUrl } from '../../utils/mediaUrl';
import { triggerHaptic } from '../../utils/haptics';

interface ImageViewerModalProps {
  isOpen: boolean;
  images: string[];
  initialIndex?: number;
  onClose: () => void;
  title?: string;
}

export const ImageViewerModal: React.FC<ImageViewerModalProps> = ({
  isOpen,
  images,
  initialIndex = 0,
  onClose,
  title,
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isZoomed, setIsZoomed] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setCurrentIndex(initialIndex);
    setIsZoomed(false);
    setHasError(false);
  }, [initialIndex, isOpen]);

  useEffect(() => {
    setHasError(false);
  }, [currentIndex]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && images.length > 1) {
        setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
      } else if (e.key === 'ArrowRight' && images.length > 1) {
        setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, images.length, onClose]);

  if (!isOpen || images.length === 0) return null;

  const currentImage = images[currentIndex];
  const resolvedCurrentImage = resolveMediaUrl(currentImage);

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic('tap');
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
    setIsZoomed(false);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic('tap');
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
    setIsZoomed(false);
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic('tap');
    const link = document.createElement('a');
    link.href = resolvedCurrentImage;
    link.download = `schoolbackdoor-photo-${Date.now()}.jpg`;
    link.click();
  };

  const handleCloseViewer = () => {
    triggerHaptic('close');
    onClose();
  };

  return (
    <div
      onClick={handleCloseViewer}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-[#0F0E0C]/92 backdrop-blur-md animate-sb-in select-none"
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Image viewer'}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute top-4 left-4 right-4 z-60 flex items-center justify-between text-[#F5EFE3] text-xs"
      >
        <div className="flex items-center gap-2">
          {images.length > 1 && (
            <span className="font-mono text-xs px-2.5 py-1 rounded-lg glass-dark text-[#F5EFE3]">
              {currentIndex + 1} / {images.length}
            </span>
          )}
          {title && (
            <span className="font-sans font-medium text-[#F5EFE3]/85 truncate max-w-[200px] sm:max-w-md hidden sm:inline">
              {title}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              setIsZoomed(!isZoomed);
            }}
            aria-label={isZoomed ? 'Zoom out' : 'Zoom in'}
            className="w-10 h-10 rounded-xl glass-dark text-[#F5EFE3] hover:text-[#D98BA5] flex items-center justify-center transition-colors cursor-pointer"
            title={isZoomed ? 'Actual size' : 'Expand'}
          >
            {isZoomed ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={handleDownload}
            aria-label="Download image"
            className="w-10 h-10 rounded-xl glass-dark text-[#F5EFE3] hover:text-[#D98BA5] flex items-center justify-center transition-colors cursor-pointer"
            title="Download image"
          >
            <Download className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleCloseViewer}
            aria-label="Close viewer"
            className="w-10 h-10 rounded-xl glass-dark text-[#F5EFE3] hover:text-[#D98BA5] flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {images.length > 1 && (
        <button
          type="button"
          onClick={handlePrev}
          aria-label="Previous image"
          className="absolute left-3 sm:left-6 z-60 w-10 h-10 rounded-xl glass-dark text-[#F5EFE3] hover:text-[#D98BA5] flex items-center justify-center transition-all cursor-pointer shadow-lg hover:scale-105"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        className="max-w-5xl max-h-[85vh] flex items-center justify-center overflow-auto"
      >
        {hasError || !resolvedCurrentImage ? (
          <div className="px-8 py-12 rounded-2xl glass-dark text-[#F5EFE3]/80 flex flex-col items-center gap-2 text-center">
            <ImageOff className="w-7 h-7 opacity-75" />
            <span className="text-xs font-medium">Unable to display image</span>
          </div>
        ) : (
          <img
            src={resolvedCurrentImage}
            alt={title || `Photo ${currentIndex + 1}`}
            decoding="async"
            onError={() => setHasError(true)}
            className={`rounded-2xl shadow-2xl transition-transform duration-200 object-contain ${
              isZoomed
                ? 'max-h-none max-w-none scale-125 cursor-zoom-out'
                : 'max-h-[80vh] max-w-full cursor-zoom-in'
            }`}
            onClick={() => {
              triggerHaptic('tap');
              setIsZoomed(!isZoomed);
            }}
          />
        )}
      </div>

      {images.length > 1 && (
        <button
          type="button"
          onClick={handleNext}
          aria-label="Next image"
          className="absolute right-3 sm:right-6 z-60 w-10 h-10 rounded-xl glass-dark text-[#F5EFE3] hover:text-[#D98BA5] flex items-center justify-center transition-all cursor-pointer shadow-lg hover:scale-105"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      {images.length > 1 && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-60 flex items-center gap-2 p-2 rounded-xl glass-dark"
        >
          {images.map((img, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                setCurrentIndex(idx);
                setIsZoomed(false);
              }}
              className={`w-10 h-10 rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                idx === currentIndex
                  ? 'border-[#D98BA5] scale-105 shadow-xs'
                  : 'border-transparent opacity-60 hover:opacity-100'
              }`}
            >
              <img
                src={getThumbnailUrl(img)}
                onError={(e) => {
                  const el = e.currentTarget;
                  if (el.dataset.fallbackApplied === '1') return;
                  el.dataset.fallbackApplied = '1';
                  el.src = resolveMediaUrl(img);
                }}
                loading="lazy"
                decoding="async"
                alt={`Thumb ${idx + 1}`}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

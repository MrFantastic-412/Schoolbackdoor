import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, Minus, Plus, RotateCcw, Trash2, UploadCloud, X } from 'lucide-react';
import {
  IMAGE_UPLOAD_ACCEPT,
  IMAGE_UPLOAD_GUIDANCE,
  loadImageForCrop,
  renderCroppedAvatar,
  CroppedAvatarResult,
} from '../../utils/imageCompression';
import { UserAvatar } from '../common/UserAvatar';

interface AvatarCropModalProps {
  isOpen: boolean;
  initialFile?: File | null;
  currentAvatarUrl?: string;
  currentAvatarThumbUrl?: string;
  userName?: string;
  initials?: string;
  avatarBg?: string;
  title?: string;
  onClose: () => void;
  onSave: (
    cropped: CroppedAvatarResult,
    onProgress: (percent: number) => void
  ) => Promise<void>;
  onRemove?: () => Promise<void>;
}

const CROP_VIEWPORT_PX = 256;

export const AvatarCropModal: React.FC<AvatarCropModalProps> = ({
  isOpen,
  initialFile = null,
  currentAvatarUrl,
  currentAvatarThumbUrl,
  userName,
  initials,
  avatarBg,
  title = 'Profile Picture',
  onClose,
  onSave,
  onRemove,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; startOffsetX: number; startOffsetY: number } | null>(
    null
  );

  const [loadedImage, setLoadedImage] = useState<{
    src: string;
    width: number;
    height: number;
    originalSize: number;
  } | null>(null);
  const [scale, setScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);

  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const clampOffsets = useCallback(
    (nextX: number, nextY: number, nextScale: number, imgW: number, imgH: number) => {
      const baseScale = Math.max(CROP_VIEWPORT_PX / imgW, CROP_VIEWPORT_PX / imgH);
      const dispW = imgW * baseScale * nextScale;
      const dispH = imgH * baseScale * nextScale;
      const maxX = Math.max(0, (dispW - CROP_VIEWPORT_PX) / 2);
      const maxY = Math.max(0, (dispH - CROP_VIEWPORT_PX) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, nextX)),
        y: Math.min(maxY, Math.max(-maxY, nextY)),
      };
    },
    []
  );

  const processSelectedFile = useCallback(async (file: File) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsLoadingFile(true);
    try {
      const loaded = await loadImageForCrop(file);
      setLoadedImage(loaded);
      setScale(1);
      setOffsetX(0);
      setOffsetY(0);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load selected image.');
    } finally {
      setIsLoadingFile(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setLoadedImage(null);
      setScale(1);
      setOffsetX(0);
      setOffsetY(0);
      setProgress(0);
      setErrorMsg(null);
      setSuccessMsg(null);
      setIsSaving(false);
      setIsRemoving(false);
      return;
    }

    if (initialFile) {
      void processSelectedFile(initialFile);
    }
  }, [isOpen, initialFile, processSelectedFile]);

  const displayGeometry = useMemo(() => {
    if (!loadedImage) return null;
    const baseScale = Math.max(
      CROP_VIEWPORT_PX / loadedImage.width,
      CROP_VIEWPORT_PX / loadedImage.height
    );
    const dispW = loadedImage.width * baseScale * scale;
    const dispH = loadedImage.height * baseScale * scale;
    const left = (CROP_VIEWPORT_PX - dispW) / 2 + offsetX;
    const top = (CROP_VIEWPORT_PX - dispH) / 2 + offsetY;
    return { dispW, dispH, left, top };
  }, [loadedImage, scale, offsetX, offsetY]);

  if (!isOpen) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await processSelectedFile(file);
  };

  const handleZoomChange = (nextScaleRaw: number) => {
    const nextScale = Math.min(3, Math.max(1, Number(nextScaleRaw.toFixed(2))));
    setScale(nextScale);
    if (loadedImage) {
      const clamped = clampOffsets(offsetX, offsetY, nextScale, loadedImage.width, loadedImage.height);
      setOffsetX(clamped.x);
      setOffsetY(clamped.y);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loadedImage) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || !loadedImage) return;
    const dx = e.clientX - dragStartRef.current.pointerX;
    const dy = e.clientY - dragStartRef.current.pointerY;
    const clamped = clampOffsets(
      dragStartRef.current.startOffsetX + dx,
      dragStartRef.current.startOffsetY + dy,
      scale,
      loadedImage.width,
      loadedImage.height
    );
    setOffsetX(clamped.x);
    setOffsetY(clamped.y);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore if already released
      }
      dragStartRef.current = null;
    }
  };

  const handleSaveCropped = async () => {
    if (!loadedImage || isSaving || isRemoving) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsSaving(true);
    setProgress(12);
    try {
      const cropped = await renderCroppedAvatar(loadedImage.src, {
        scale,
        offsetX,
        offsetY,
        viewportSize: CROP_VIEWPORT_PX,
      });
      setProgress(35);
      await onSave(cropped, (pct) => {
        setProgress(Math.max(35, Math.min(100, pct)));
      });
      setProgress(100);
      setSuccessMsg('Profile picture updated.');
      setTimeout(() => {
        onClose();
      }, 450);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to save profile picture.');
      setProgress(0);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveAvatar = async () => {
    if (!onRemove || isSaving || isRemoving) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsRemoving(true);
    try {
      await onRemove();
      setLoadedImage(null);
      setSuccessMsg('Profile picture removed.');
      setTimeout(() => {
        onClose();
      }, 400);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to remove profile picture.');
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md max-h-[92dvh] flex flex-col rounded-2xl bg-[#FFFCF7] dark:bg-[#1E1C18] border border-stone-200 dark:border-stone-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 sm:py-4 border-b border-stone-200 dark:border-stone-800 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-[#171613] dark:text-[#F5EFE3]">{title}</h2>
            <p className="text-xs text-[#82796F] dark:text-stone-400 mt-0.5">
              {IMAGE_UPLOAD_GUIDANCE}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving || isRemoving}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
            aria-label="Close photo editor"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            onChange={handleFileChange}
            className="hidden"
          />

          {loadedImage && displayGeometry ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center">
                <div
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  className="relative overflow-hidden rounded-full bg-stone-900 border-2 border-[#C4718E] dark:border-[#E5A4BA] cursor-grab active:cursor-grabbing touch-none select-none shadow-inner"
                  style={{ width: CROP_VIEWPORT_PX, height: CROP_VIEWPORT_PX }}
                >
                  <img
                    src={loadedImage.src}
                    alt="Crop preview"
                    draggable={false}
                    className="absolute max-w-none pointer-events-none select-none"
                    style={{
                      width: `${displayGeometry.dispW}px`,
                      height: `${displayGeometry.dispH}px`,
                      left: `${displayGeometry.left}px`,
                      top: `${displayGeometry.top}px`,
                    }}
                  />
                  <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-white/30" />
                </div>
                <p className="text-xs text-[#82796F] dark:text-stone-400 mt-2">
                  Drag to reposition · Pinch or slide to zoom
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleZoomChange(scale - 0.15)}
                  disabled={scale <= 1}
                  aria-label="Zoom out"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 transition-colors"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.05}
                  value={scale}
                  onChange={(e) => handleZoomChange(Number(e.target.value))}
                  aria-label="Zoom level"
                  className="flex-1 accent-[#C4718E] dark:accent-[#E5A4BA] cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => handleZoomChange(scale + 0.15)}
                  disabled={scale >= 3}
                  aria-label="Zoom in"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScale(1);
                    setOffsetX(0);
                    setOffsetY(0);
                  }}
                  aria-label="Reset crop"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center py-4 space-y-4">
              <div className="relative">
                <UserAvatar
                  name={userName}
                  initials={initials}
                  bg={avatarBg}
                  avatarUrl={currentAvatarUrl}
                  avatarThumbUrl={currentAvatarThumbUrl}
                  size="2xl"
                  className="ring-2 ring-stone-200 dark:ring-stone-700"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoadingFile}
                  className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-[#171613] dark:bg-[#F5EFE3] text-[#FFFCF7] dark:text-[#171613] flex items-center justify-center shadow-md hover:opacity-90 transition-opacity"
                  aria-label="Select profile picture"
                >
                  <Camera className="w-4 h-4" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoadingFile}
                className="w-full py-3.5 px-4 rounded-xl border border-dashed border-stone-300 dark:border-stone-700 hover:border-[#C4718E] dark:hover:border-[#E5A4BA] bg-stone-50/70 dark:bg-stone-900/40 flex flex-col items-center gap-1.5 text-center transition-colors"
              >
                <UploadCloud className="w-5 h-5 text-[#C4718E] dark:text-[#E5A4BA]" />
                <span className="text-sm font-medium text-[#171613] dark:text-[#F5EFE3]">
                  {isLoadingFile
                    ? 'Preparing image...'
                    : currentAvatarUrl
                    ? 'Choose a new photo to replace'
                    : 'Choose a profile picture'}
                </span>
                <span className="text-xs text-[#82796F] dark:text-stone-400">
                  {IMAGE_UPLOAD_GUIDANCE}
                </span>
              </button>
            </div>
          )}

          {isSaving && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-stone-600 dark:text-stone-300">
                <span>Optimizing & uploading photo</span>
                <span className="tabular-nums font-medium">{progress}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
                <div
                  className="h-full bg-[#C4718E] dark:bg-[#E5A4BA] transition-all duration-150"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 px-3.5 py-2.5 text-xs font-medium text-rose-700 dark:text-rose-200">
              {errorMsg}
            </div>
          )}

          {successMsg && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 px-3.5 py-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-200">
              {successMsg}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-t border-stone-200 dark:border-stone-800 bg-stone-50/70 dark:bg-[#181714]">
          <div className="flex items-center gap-2">
            {loadedImage && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSaving || isRemoving}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-stone-300 dark:border-stone-700 text-xs font-medium text-[#171613] dark:text-[#F5EFE3] hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center gap-1.5 transition-colors"
              >
                <ImagePlus className="w-4 h-4" />
                Change photo
              </button>
            )}
            {onRemove && currentAvatarUrl && !loadedImage && (
              <button
                type="button"
                onClick={handleRemoveAvatar}
                disabled={isSaving || isRemoving}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-rose-200 dark:border-rose-900/70 text-xs font-medium text-rose-600 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 inline-flex items-center gap-1.5 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                {isRemoving ? 'Removing...' : 'Remove'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving || isRemoving}
              className="min-h-[44px] px-4 py-2 rounded-xl text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
            >
              Cancel
            </button>
            {loadedImage && (
              <button
                type="button"
                onClick={handleSaveCropped}
                disabled={isSaving || isRemoving}
                className="min-h-[44px] px-5 py-2 rounded-xl bg-[#171613] dark:bg-[#F5EFE3] text-[#FFFCF7] dark:text-[#171613] text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {isSaving ? 'Saving...' : 'Save Photo'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

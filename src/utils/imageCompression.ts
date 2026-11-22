/**
 * Client-side image validation, compression, and avatar cropping utility.
 * Canvas re-encoding strips EXIF/GPS/camera metadata automatically, downscales to <= 1080px,
 * uses WebP/JPEG compression, and builds compact thumbnail variants.
 */

export const MAX_IMAGE_SIZE_MB = 20;
export const MAX_PRE_COMPRESSION_SIZE = MAX_IMAGE_SIZE_MB * 1024 * 1024; // 20MB (20,971,520 bytes)
export const MAX_IMAGE_SIZE_BYTES = MAX_PRE_COMPRESSION_SIZE;
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const IMAGE_UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp';
export const IMAGE_UPLOAD_GUIDANCE = `Max ${MAX_IMAGE_SIZE_MB}MB · JPEG, PNG, WebP`;

export const MAX_DIMENSION = 1080; // Mobile-friendly max width/height
export const THUMB_MAX_DIMENSION = 320;
export const AVATAR_DIMENSION = 512;
export const AVATAR_THUMB_DIMENSION = 160;
export const COMPRESSION_QUALITY = 0.78;
export const MAX_ATTACHMENTS_POST = 4; // Max 4 photos per dispatch/comment/message

export interface CompressionResult {
  dataUrl: string;
  thumbnailDataUrl?: string;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
}

export interface LoadedCropImage {
  src: string;
  width: number;
  height: number;
  originalSize: number;
}

export interface CroppedAvatarResult {
  dataUrl: string;
  thumbnailDataUrl: string;
  compressedSize: number;
  width: number;
  height: number;
}

function encodeCanvasImage(canvas: HTMLCanvasElement, quality: number): string {
  let out = canvas.toDataURL('image/webp', quality);
  if (!out.startsWith('data:image/webp')) {
    out = canvas.toDataURL('image/jpeg', quality);
  }
  return out;
}

function approxDataUrlBytes(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return Math.round((b64.length * 3) / 4);
}

/**
 * Validates image file size (strictly <= 20MB) and allowed format (JPEG, PNG, WebP).
 */
export function validateImageFile(file: File): void {
  if (!file) {
    throw new Error('Please choose an image file.');
  }

  const normalizedType = (file.type || '').toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : (file.type || '').toLowerCase();

  if (normalizedType) {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(normalizedType as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
      throw new Error('Unsupported image format. Please choose a JPEG, PNG, or WebP image.');
    }
  } else {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      throw new Error('Unsupported image format. Please choose a JPEG, PNG, or WebP image.');
    }
  }

  if (file.size <= 0) {
    throw new Error('The selected image file appears to be empty.');
  }

  if (file.size > MAX_PRE_COMPRESSION_SIZE) {
    throw new Error(
      `Image exceeds the maximum allowed size of ${MAX_IMAGE_SIZE_MB}MB. Please choose a smaller image.`
    );
  }
}

/**
 * Validates and compresses a single image file on the client side using HTML5 Canvas.
 */
export async function compressImageFile(
  file: File,
  onProgress?: (percent: number) => void
): Promise<CompressionResult> {
  validateImageFile(file);
  onProgress?.(10);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(new Error('Failed to read image file from your device.'));
    };

    reader.onload = (e) => {
      onProgress?.(40);
      const img = new Image();

      img.onerror = () => {
        reject(new Error('Failed to process image data. The file may be corrupted.'));
      };

      img.onload = () => {
        try {
          onProgress?.(60);
          let { width, height } = img;

          // Downscale if either dimension exceeds MAX_DIMENSION
          if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
            if (width > height) {
              height = Math.max(1, Math.round((height * MAX_DIMENSION) / width));
              width = MAX_DIMENSION;
            } else {
              width = Math.max(1, Math.round((width * MAX_DIMENSION) / height));
              height = MAX_DIMENSION;
            }
          }

          // Off-screen canvas drawing (automatically strips EXIF/GPS/camera headers)
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas 2D context unavailable for compression.'));
            return;
          }

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, width, height);

          onProgress?.(82);
          let compressedDataUrl = encodeCanvasImage(canvas, COMPRESSION_QUALITY);
          let approxBytes = approxDataUrlBytes(compressedDataUrl);

          if (approxBytes > 2.5 * 1024 * 1024) {
            compressedDataUrl = encodeCanvasImage(canvas, 0.65);
            approxBytes = approxDataUrlBytes(compressedDataUrl);
          }

          // Generate compact <= 320px thumbnail variant
          let thumbnailDataUrl: string | undefined;
          if (width > THUMB_MAX_DIMENSION || height > THUMB_MAX_DIMENSION) {
            let tw = width;
            let th = height;
            if (tw > th) {
              th = Math.max(1, Math.round((th * THUMB_MAX_DIMENSION) / tw));
              tw = THUMB_MAX_DIMENSION;
            } else {
              tw = Math.max(1, Math.round((tw * THUMB_MAX_DIMENSION) / th));
              th = THUMB_MAX_DIMENSION;
            }
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = tw;
            thumbCanvas.height = th;
            const thumbCtx = thumbCanvas.getContext('2d');
            if (thumbCtx) {
              thumbCtx.imageSmoothingEnabled = true;
              thumbCtx.imageSmoothingQuality = 'medium';
              thumbCtx.drawImage(canvas, 0, 0, tw, th);
              thumbnailDataUrl = encodeCanvasImage(thumbCanvas, 0.68);
            }
          }

          onProgress?.(100);
          resolve({
            dataUrl: compressedDataUrl,
            thumbnailDataUrl,
            originalSize: file.size,
            compressedSize: approxBytes,
            width,
            height,
          });
        } catch (err: any) {
          reject(new Error(err?.message || 'Error occurred while compressing image.'));
        }
      };

      img.src = e.target?.result as string;
    };

    reader.readAsDataURL(file);
  });
}

/**
 * Loads and validates a user-chosen image file for interactive profile picture preview & crop.
 */
export async function loadImageForCrop(file: File): Promise<LoadedCropImage> {
  validateImageFile(file);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file from your device.'));
    reader.onload = (e) => {
      const src = e.target?.result as string;
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load image for cropping.'));
      img.onload = () => {
        resolve({
          src,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          originalSize: file.size,
        });
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Renders an exact square/circular crop of an image into an optimized 512x512 avatar
 * plus a 160x160 thumbnail variant, stripping EXIF/GPS metadata via Canvas re-encoding.
 */
export async function renderCroppedAvatar(
  src: string,
  crop: { scale: number; offsetX: number; offsetY: number; viewportSize: number }
): Promise<CroppedAvatarResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error('Unable to render cropped profile picture.'));
    img.onload = () => {
      try {
        const imgW = img.naturalWidth || img.width;
        const imgH = img.naturalHeight || img.height;
        const vp = Math.max(100, crop.viewportSize);
        const baseScale = Math.max(vp / imgW, vp / imgH);
        const dispW = imgW * baseScale * crop.scale;
        const dispH = imgH * baseScale * crop.scale;
        const drawX = (vp - dispW) / 2 + crop.offsetX;
        const drawY = (vp - dispH) / 2 + crop.offsetY;

        const outCanvas = document.createElement('canvas');
        outCanvas.width = AVATAR_DIMENSION;
        outCanvas.height = AVATAR_DIMENSION;
        const ctx = outCanvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 2D context unavailable for avatar cropping.'));
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const ratio = AVATAR_DIMENSION / vp;
        ctx.drawImage(img, drawX * ratio, drawY * ratio, dispW * ratio, dispH * ratio);

        const dataUrl = encodeCanvasImage(outCanvas, 0.84);

        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = AVATAR_THUMB_DIMENSION;
        thumbCanvas.height = AVATAR_THUMB_DIMENSION;
        const thumbCtx = thumbCanvas.getContext('2d');
        if (!thumbCtx) {
          reject(new Error('Canvas 2D context unavailable for avatar thumbnail.'));
          return;
        }
        thumbCtx.imageSmoothingEnabled = true;
        thumbCtx.imageSmoothingQuality = 'high';
        thumbCtx.drawImage(outCanvas, 0, 0, AVATAR_THUMB_DIMENSION, AVATAR_THUMB_DIMENSION);

        const thumbnailDataUrl = encodeCanvasImage(thumbCanvas, 0.74);

        resolve({
          dataUrl,
          thumbnailDataUrl,
          compressedSize: approxDataUrlBytes(dataUrl),
          width: AVATAR_DIMENSION,
          height: AVATAR_DIMENSION,
        });
      } catch (err: any) {
        reject(new Error(err?.message || 'Failed to crop profile picture.'));
      }
    };
    img.src = src;
  });
}

/**
 * Compresses multiple image files with a maximum count limit.
 */
export async function compressMultipleImages(
  files: File[] | FileList,
  maxCount = MAX_ATTACHMENTS_POST,
  onProgress?: (percent: number) => void
): Promise<{ results: CompressionResult[]; error?: string }> {
  const fileArray = Array.from(files);

  if (fileArray.length > maxCount) {
    return {
      results: [],
      error: `You can attach at most ${maxCount} photos per upload.`,
    };
  }

  const results: CompressionResult[] = [];
  const total = Math.max(1, fileArray.length);

  for (let i = 0; i < fileArray.length; i++) {
    const file = fileArray[i];
    try {
      const res = await compressImageFile(file, (pct) => {
        if (onProgress) {
          const overall = Math.round(((i + pct / 100) / total) * 100);
          onProgress(overall);
        }
      });
      results.push(res);
    } catch (err: any) {
      return {
        results,
        error: err.message || 'Image compression error.',
      };
    }
  }

  return { results };
}

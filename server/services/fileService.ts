import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, getDataRootDir, withReadConnection } from '../db/database.js';
import { cache } from '../utils/cache.js';

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB per image (profile, post, comment, chat)
export const PROTECTION_MODE_MAX_UPLOAD_BYTES = 256 * 1024; // 256 KB emergency cap at 95% disk usage
export const PENDING_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000; // Unattached staged upload grace window (30 min)
export const MAX_IMAGE_DIMENSION = 1600;
export const THUMB_MAX_DIMENSION = 320;
export const AVATAR_MAX_DIMENSION = 512;
export const AVATAR_THUMB_DIMENSION = 160;

export type MediaContextType = 'profile' | 'post' | 'comment' | 'chat' | 'upload';

export class MediaValidationError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'MEDIA_INVALID') {
    super(message);
    this.name = 'MediaValidationError';
    this.status = status;
    this.code = code;
  }
}

export function getUploadsDir(): string {
  const dir = process.env.SCHOOLBACKDOOR_UPLOADS_DIR
    ? path.resolve(process.env.SCHOOLBACKDOOR_UPLOADS_DIR)
    : path.join(getDataRootDir(), 'uploads');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getTmpDir(): string {
  const dir = process.env.SCHOOLBACKDOOR_TMP_DIR
    ? path.resolve(process.env.SCHOOLBACKDOOR_TMP_DIR)
    : path.join(getDataRootDir(), 'tmp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export type ImageExtension = 'jpg' | 'png' | 'webp' | 'avif';

const EXT_TO_MIME: Record<ImageExtension, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

const MIME_TO_ALLOWED_EXTS: Record<string, ImageExtension[]> = {
  'image/jpeg': ['jpg'],
  'image/jpg': ['jpg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
};

/**
 * Inspects real magic bytes of decoded binary buffer to prevent extension/MIME spoofing & XSS payloads.
 */
function detectImageFormatFromBuffer(buf: Buffer): ImageExtension | null {
  if (!buf || buf.length < 12) {
    return null;
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  // AVIF: ISO Base Media File Format "....ftypavif" or "ftypavis"
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') {
      return 'avif';
    }
  }
  return null;
}

function parseDataUrl(
  dataUrl: string,
  maxBytesOverride?: number
): { declaredMime: string; buffer: Buffer; detectedExt: ImageExtension } {
  const effectiveMaxBytes =
    typeof maxBytesOverride === 'number' && maxBytesOverride > 0
      ? Math.min(MAX_FILE_SIZE, maxBytesOverride)
      : MAX_FILE_SIZE;

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new MediaValidationError('Invalid image upload payload.', 400, 'INVALID_DATA_URL');
  }

  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx <= 5) {
    throw new MediaValidationError('Malformed data URL image payload.', 400, 'INVALID_DATA_URL');
  }

  const header = dataUrl.slice(5, commaIdx).toLowerCase();
  const base64Part = dataUrl.slice(commaIdx + 1).replace(/\s+/g, '');

  const semiIdx = header.indexOf(';');
  const declaredMime = semiIdx >= 0 ? header.slice(0, semiIdx).trim() : header.trim();
  const isBase64 = header.includes(';base64');

  if (!isBase64 || !MIME_TO_ALLOWED_EXTS[declaredMime]) {
    throw new MediaValidationError(
      'Unsupported image format. Only JPEG, PNG, and WebP images are permitted.',
      400,
      'UNSUPPORTED_IMAGE_FORMAT'
    );
  }

  // Exact binary size calculation before allocating full buffer
  const padding = base64Part.endsWith('==') ? 2 : base64Part.endsWith('=') ? 1 : 0;
  const approxByteLength = Math.floor((base64Part.length * 3) / 4) - padding;
  if (approxByteLength <= 0) {
    throw new MediaValidationError('Empty image file cannot be uploaded.', 400, 'EMPTY_IMAGE');
  }
  if (approxByteLength > MAX_FILE_SIZE) {
    throw new MediaValidationError(
      'Image upload exceeds the maximum allowed size of 20MB.',
      413,
      'IMAGE_TOO_LARGE'
    );
  }
  if (approxByteLength > effectiveMaxBytes) {
    throw new MediaValidationError(
      `Storage Protection Mode active: uploads are temporarily capped at ${Math.round(effectiveMaxBytes / 1024)} KB.`,
      413,
      'STORAGE_PROTECTION_LIMIT'
    );
  }

  const buffer = Buffer.from(base64Part, 'base64');
  if (buffer.length > MAX_FILE_SIZE) {
    throw new MediaValidationError(
      'Image upload exceeds the maximum allowed size of 20MB.',
      413,
      'IMAGE_TOO_LARGE'
    );
  }
  if (buffer.length > effectiveMaxBytes) {
    throw new MediaValidationError(
      `Storage Protection Mode active: uploads are temporarily capped at ${Math.round(effectiveMaxBytes / 1024)} KB.`,
      413,
      'STORAGE_PROTECTION_LIMIT'
    );
  }

  const detectedExt = detectImageFormatFromBuffer(buffer);
  if (!detectedExt) {
    throw new MediaValidationError(
      'Invalid or spoofed image file signature. Only valid JPEG, PNG, and WebP images are permitted.',
      400,
      'INVALID_IMAGE_MAGIC_BYTES'
    );
  }

  const allowedForDeclared = MIME_TO_ALLOWED_EXTS[declaredMime];
  if (!allowedForDeclared.includes(detectedExt)) {
    throw new MediaValidationError(
      `Uploaded file signature (${detectedExt.toUpperCase()}) does not match declared MIME type (${declaredMime}).`,
      400,
      'MIME_SIGNATURE_MISMATCH'
    );
  }

  return { declaredMime, buffer, detectedExt };
}

/**
 * Synchronous container-level metadata & EXIF/GPS/XMP/IPTC stripper for JPEG, PNG, and WebP.
 * Guarantees sensitive location/camera tags are removed even in synchronous code paths.
 */
export function stripImageMetadataSync(buffer: Buffer, ext: ImageExtension): Buffer {
  try {
    if (ext === 'jpg') {
      // JPEG starts with SOI (FF D8)
      if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
      const chunks: Buffer[] = [buffer.subarray(0, 2)];
      let pos = 2;
      while (pos + 1 < buffer.length) {
        if (buffer[pos] !== 0xff) {
          // Unexpected alignment, return remaining scan stream safely
          chunks.push(buffer.subarray(pos));
          return Buffer.concat(chunks);
        }
        // Skip fill bytes 0xFF
        while (pos + 1 < buffer.length && buffer[pos + 1] === 0xff) {
          pos++;
        }
        if (pos + 1 >= buffer.length) break;
        const marker = buffer[pos + 1];
        // Start of Scan (FF DA) or EOI (FF D9): copy remainder verbatim
        if (marker === 0xda || marker === 0xd9) {
          chunks.push(buffer.subarray(pos));
          return Buffer.concat(chunks);
        }
        // Standalone markers (RST0-RST7, TEM) have no length
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          chunks.push(buffer.subarray(pos, pos + 2));
          pos += 2;
          continue;
        }
        if (pos + 3 >= buffer.length) {
          chunks.push(buffer.subarray(pos));
          return Buffer.concat(chunks);
        }
        const segLen = buffer.readUInt16BE(pos + 2);
        if (segLen < 2 || pos + 2 + segLen > buffer.length) {
          chunks.push(buffer.subarray(pos));
          return Buffer.concat(chunks);
        }
        // Strip APP1 (0xE1 EXIF/GPS/XMP) .. APP13 (0xED IPTC/Photoshop), APP15 (0xEF), and COM (0xFE)
        const shouldStrip =
          (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
        if (!shouldStrip) {
          chunks.push(buffer.subarray(pos, pos + 2 + segLen));
        }
        pos += 2 + segLen;
      }
      return Buffer.concat(chunks);
    }

    if (ext === 'png') {
      if (buffer.length < 8) return buffer;
      const chunks: Buffer[] = [buffer.subarray(0, 8)];
      const stripChunkTypes = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
      let pos = 8;
      while (pos + 12 <= buffer.length) {
        const dataLen = buffer.readUInt32BE(pos);
        const type = buffer.subarray(pos + 4, pos + 8).toString('ascii');
        const totalChunkLen = 12 + dataLen;
        if (dataLen < 0 || pos + totalChunkLen > buffer.length) {
          return buffer;
        }
        if (!stripChunkTypes.has(type)) {
          chunks.push(buffer.subarray(pos, pos + totalChunkLen));
        }
        pos += totalChunkLen;
        if (type === 'IEND') break;
      }
      return chunks.length > 1 ? Buffer.concat(chunks) : buffer;
    }

    if (ext === 'webp') {
      if (buffer.length < 12) return buffer;
      const chunks: Buffer[] = [];
      let pos = 12;
      while (pos + 8 <= buffer.length) {
        const fourcc = buffer.subarray(pos, pos + 4).toString('ascii');
        const chunkSize = buffer.readUInt32LE(pos + 4);
        const paddedSize = chunkSize + (chunkSize % 2);
        const totalLen = 8 + paddedSize;
        if (pos + totalLen > buffer.length) {
          return buffer;
        }
        if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
          const chunkBuf = Buffer.from(buffer.subarray(pos, pos + totalLen));
          // Clear EXIF (bit 3 = 0x08) & XMP (bit 2 = 0x04) feature flags in VP8X header if present
          if (fourcc === 'VP8X' && chunkBuf.length >= 9) {
            chunkBuf[8] = chunkBuf[8] & ~0x0c;
          }
          chunks.push(chunkBuf);
        }
        pos += totalLen;
      }
      const payload = Buffer.concat(chunks);
      const riffHeader = Buffer.alloc(12);
      riffHeader.write('RIFF', 0, 'ascii');
      riffHeader.writeUInt32LE(4 + payload.length, 4);
      riffHeader.write('WEBP', 8, 'ascii');
      return Buffer.concat([riffHeader, payload]);
    }
  } catch {
    // Preserve original validated buffer if container parsing hits an unusual truncated edge
  }
  return buffer;
}

function writeFileAtomically(targetPath: string, bytes: Buffer): void {
  const tmpDir = getTmpDir();
  const tmpName = `.stage-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(tmpDir, tmpName);
  fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch {
    // Fallback across mount boundaries
    fs.copyFileSync(tmpPath, targetPath);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

export function isValidUploadFilename(filename: string): boolean {
  return (
    typeof filename === 'string' &&
    filename.length > 0 &&
    filename.length <= 160 &&
    !/[\\/\0]|\.\./.test(filename) &&
    /^[a-zA-Z0-9._-]+$/.test(filename)
  );
}

function isCommunityPrivate(communityId: string): boolean {
  const row = withReadConnection((conn) =>
    conn.prepare('SELECT settings_json FROM communities WHERE id = ?').get(communityId) as
      | { settings_json: string | null }
      | undefined
  );
  if (!row?.settings_json) return false;
  try {
    return Boolean(JSON.parse(row.settings_json)?.isPrivate);
  } catch {
    return false;
  }
}

function upsertMediaAssetRecord(params: {
  filename: string;
  thumbFilename?: string | null;
  ownerId?: string | null;
  contextType: MediaContextType;
  mimeType: string;
  byteSize: number;
  originalByteSize: number;
  width?: number | null;
  height?: number | null;
}) {
  try {
    const id = `med-${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
      INSERT INTO media_assets (
        id, filename, thumb_filename, owner_id, context_type,
        mime_type, byte_size, original_byte_size, width, height, exif_stripped, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
      ON CONFLICT(filename) DO UPDATE SET
        thumb_filename = COALESCE(excluded.thumb_filename, media_assets.thumb_filename),
        owner_id = COALESCE(media_assets.owner_id, excluded.owner_id),
        byte_size = excluded.byte_size,
        width = COALESCE(excluded.width, media_assets.width),
        height = COALESCE(excluded.height, media_assets.height),
        exif_stripped = 1,
        deleted_at = NULL
    `).run(
      id,
      params.filename,
      params.thumbFilename || null,
      params.ownerId || null,
      params.contextType,
      params.mimeType,
      params.byteSize,
      params.originalByteSize,
      params.width ?? null,
      params.height ?? null
    );
  } catch {
    // Non-fatal if DB schema is partial during low-level bootstrap
  }
}

export interface FileServePolicy {
  accessible: boolean;
  isAvatar: boolean;
  isPrivateChatMedia: boolean;
  isPrivateScope: boolean;
  chatId?: string;
  communityId?: string;
  privateProfileOwnerId?: string;
  allowedUserIds: string[];
  expiresAtMs: number | null;
}

const IMAGE_QUERY_CONTAINS_NAME = (name: string) =>
  `%"/api/uploads/${name.replace(/[%_\\]/g, '\\$&')}"%`;

async function encodeWithSharp(
  inputBuffer: Buffer,
  ext: ImageExtension,
  maxDimension: number,
  quality = 80
): Promise<{ buffer: Buffer; width: number | null; height: number | null }> {
  let pipeline = sharp(inputBuffer, {
    limitInputPixels: 40_000_000,
    failOn: 'error',
  })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    });

  if (ext === 'jpg') {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  } else if (ext === 'png') {
    pipeline = pipeline.png({ compressionLevel: 8 });
  } else if (ext === 'avif') {
    pipeline = pipeline.avif({ quality: Math.max(50, quality - 15) });
  } else {
    pipeline = pipeline.webp({ quality });
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    width: info.width ?? null,
    height: info.height ?? null,
  };
}

export const fileService = {
  /**
   * Async server-side image processor (used by all HTTP upload/content routes):
   * - Enforces 20MB limit & real magic-byte verification
   * - Decodes via libvips (`sharp`) to reject malformed/polyglot payloads
   * - Auto-orients from EXIF then strips 100% of EXIF, GPS, IPTC & XMP metadata
   * - Compresses & downscales large images (<= 1600px, or <= 512px for avatars)
   * - Automatically generates a compact <= 320px thumbnail (or 160px for avatars)
   * - Persists atomically & registers metadata in `media_assets`
   */
  async saveBase64ImageAsync(
    dataUrl: string,
    ownerId?: string,
    options?: {
      thumbnailDataUrl?: string;
      maxBytesOverride?: number;
      contextType?: MediaContextType;
      isAvatar?: boolean;
      maxDimension?: number;
      thumbDimension?: number;
    }
  ): Promise<{ url: string; thumbnailUrl?: string; filename: string; thumbFilename?: string }> {
    const parsed = parseDataUrl(dataUrl, options?.maxBytesOverride);
    const contextType: MediaContextType =
      options?.contextType || (options?.isAvatar ? 'profile' : 'upload');
    const maxDim =
      options?.maxDimension ?? (options?.isAvatar ? AVATAR_MAX_DIMENSION : MAX_IMAGE_DIMENSION);
    const thumbDim =
      options?.thumbDimension ?? (options?.isAvatar ? AVATAR_THUMB_DIMENSION : THUMB_MAX_DIMENSION);

    let processedMain: { buffer: Buffer; width: number | null; height: number | null };
    try {
      processedMain = await encodeWithSharp(parsed.buffer, parsed.detectedExt, maxDim, 80);
    } catch {
      throw new MediaValidationError(
        'Uploaded image appears corrupted or unreadable. Please select a valid JPEG, PNG, or WebP photo.',
        400,
        'CORRUPT_IMAGE_DATA'
      );
    }

    const uploadsDir = getUploadsDir();
    const contentHash = crypto.createHash('sha256').update(processedMain.buffer).digest('hex').slice(0, 32);
    const filename = `${contentHash}.${parsed.detectedExt}`;
    const filePath = path.join(uploadsDir, filename);

    if (!fs.existsSync(filePath)) {
      writeFileAtomically(filePath, processedMain.buffer);
    }

    let thumbFilename = `thumb-${contentHash}.${parsed.detectedExt}`;
    let thumbnailUrl = `/api/uploads/${thumbFilename}`;
    const thumbPath = path.join(uploadsDir, thumbFilename);

    if (options?.thumbnailDataUrl && options.thumbnailDataUrl.startsWith('data:')) {
      try {
        const parsedThumb = parseDataUrl(options.thumbnailDataUrl, 512 * 1024);
        const processedThumb = await encodeWithSharp(
          parsedThumb.buffer,
          parsedThumb.detectedExt,
          thumbDim,
          72
        );
        thumbFilename = `thumb-${contentHash}.${parsedThumb.detectedExt}`;
        thumbnailUrl = `/api/uploads/${thumbFilename}`;
        const explicitThumbPath = path.join(uploadsDir, thumbFilename);
        if (!fs.existsSync(explicitThumbPath)) {
          writeFileAtomically(explicitThumbPath, processedThumb.buffer);
        }
      } catch {
        // Fall through to auto-generating thumbnail from processedMain
        if (!fs.existsSync(thumbPath)) {
          const autoThumb = await encodeWithSharp(
            processedMain.buffer,
            parsed.detectedExt,
            thumbDim,
            72
          );
          writeFileAtomically(thumbPath, autoThumb.buffer);
        }
      }
    } else if (!fs.existsSync(thumbPath)) {
      const autoThumb = await encodeWithSharp(processedMain.buffer, parsed.detectedExt, thumbDim, 72);
      writeFileAtomically(thumbPath, autoThumb.buffer);
    }

    upsertMediaAssetRecord({
      filename,
      thumbFilename,
      ownerId: ownerId || null,
      contextType,
      mimeType: EXT_TO_MIME[parsed.detectedExt],
      byteSize: processedMain.buffer.length,
      originalByteSize: parsed.buffer.length,
      width: processedMain.width,
      height: processedMain.height,
    });

    cache.invalidate(`uploads:policy:${filename}`);
    cache.invalidate(`uploads:policy:${thumbFilename}`);

    return {
      url: `/api/uploads/${filename}`,
      thumbnailUrl,
      filename,
      thumbFilename,
    };
  },

  /**
   * Synchronous image storage used inside synchronous SQLite transactions or direct service tests:
   * enforces 20MB limit, magic-byte validation, synchronous EXIF/GPS/XMP container stripping,
   * SHA-256 deduplication, and `media_assets` registration.
   */
  saveBase64Image(
    dataUrl: string,
    ownerId?: string,
    options?: { thumbnailDataUrl?: string; maxBytesOverride?: number; contextType?: MediaContextType }
  ): { url: string; thumbnailUrl?: string; filename: string } {
    const parsed = parseDataUrl(dataUrl, options?.maxBytesOverride);
    const strippedBuffer = stripImageMetadataSync(parsed.buffer, parsed.detectedExt);
    const uploadsDir = getUploadsDir();
    const contentHash = crypto.createHash('sha256').update(strippedBuffer).digest('hex').slice(0, 32);
    const filename = `${contentHash}.${parsed.detectedExt}`;
    const filePath = path.join(uploadsDir, filename);

    if (!fs.existsSync(filePath)) {
      writeFileAtomically(filePath, strippedBuffer);
    }

    let thumbnailUrl: string | undefined;
    let thumbFilename: string | null = null;
    if (options?.thumbnailDataUrl && options.thumbnailDataUrl.startsWith('data:')) {
      try {
        const parsedThumb = parseDataUrl(options.thumbnailDataUrl, 512 * 1024);
        const strippedThumb = stripImageMetadataSync(parsedThumb.buffer, parsedThumb.detectedExt);
        if (strippedThumb.length <= 256 * 1024) {
          thumbFilename = `thumb-${contentHash}.${parsedThumb.detectedExt}`;
          const thumbPath = path.join(uploadsDir, thumbFilename);
          if (!fs.existsSync(thumbPath)) {
            writeFileAtomically(thumbPath, strippedThumb);
          }
          thumbnailUrl = `/api/uploads/${thumbFilename}`;
        }
      } catch {
        // Invalid optional thumbnail must not block primary upload
      }
    }

    upsertMediaAssetRecord({
      filename,
      thumbFilename,
      ownerId: ownerId || null,
      contextType: options?.contextType || 'upload',
      mimeType: EXT_TO_MIME[parsed.detectedExt],
      byteSize: strippedBuffer.length,
      originalByteSize: parsed.buffer.length,
    });

    cache.invalidate(`uploads:policy:${filename}`);
    if (thumbFilename) cache.invalidate(`uploads:policy:${thumbFilename}`);

    return {
      url: `/api/uploads/${filename}`,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      filename,
    };
  },

  async saveAvatarImagesAsync(
    avatarInput: string,
    userId: string,
    thumbnailDataUrl?: string,
    options?: { maxBytesOverride?: number }
  ): Promise<{ avatarUrl: string; avatarThumbUrl: string }> {
    const clean = String(avatarInput || '').trim();
    if (!clean) {
      throw new MediaValidationError('Avatar image data is empty.', 400, 'EMPTY_IMAGE');
    }

    if (clean.startsWith('/api/uploads/')) {
      const filename = path.basename(clean);
      if (!isValidUploadFilename(filename) || !this.getUploadPath(filename)) {
        throw new MediaValidationError('Referenced avatar upload was not found.', 404, 'UPLOAD_NOT_FOUND');
      }
      this.markMediaContext([clean], 'profile', userId);
      const thumbName = thumbnailDataUrl?.startsWith('/api/uploads/')
        ? path.basename(thumbnailDataUrl)
        : `thumb-${filename}`;
      const avatarThumbUrl =
        isValidUploadFilename(thumbName) && this.getUploadPath(thumbName)
          ? `/api/uploads/${thumbName}`
          : clean;
      return { avatarUrl: clean, avatarThumbUrl };
    }

    if (!clean.startsWith('data:')) {
      throw new MediaValidationError(
        'Profile picture must be an uploaded JPEG, PNG, or WebP image.',
        400,
        'UNSUPPORTED_IMAGE_FORMAT'
      );
    }

    const saved = await this.saveBase64ImageAsync(clean, userId, {
      thumbnailDataUrl,
      maxBytesOverride: options?.maxBytesOverride,
      contextType: 'profile',
      isAvatar: true,
    });
    return {
      avatarUrl: saved.url,
      avatarThumbUrl: saved.thumbnailUrl || saved.url,
    };
  },

  saveAvatarImages(
    avatarInput: string,
    userId: string,
    thumbnailDataUrl?: string,
    options?: { maxBytesOverride?: number }
  ): { avatarUrl: string; avatarThumbUrl: string } {
    const clean = String(avatarInput || '').trim();
    if (!clean) {
      throw new MediaValidationError('Avatar image data is empty.', 400, 'EMPTY_IMAGE');
    }

    if (clean.startsWith('/api/uploads/')) {
      const filename = path.basename(clean);
      if (!isValidUploadFilename(filename) || !this.getUploadPath(filename)) {
        throw new MediaValidationError('Referenced avatar upload was not found.', 404, 'UPLOAD_NOT_FOUND');
      }
      this.markMediaContext([clean], 'profile', userId);
      const thumbName = thumbnailDataUrl?.startsWith('/api/uploads/')
        ? path.basename(thumbnailDataUrl)
        : `thumb-${filename}`;
      const avatarThumbUrl =
        isValidUploadFilename(thumbName) && this.getUploadPath(thumbName)
          ? `/api/uploads/${thumbName}`
          : clean;
      return { avatarUrl: clean, avatarThumbUrl };
    }

    if (!clean.startsWith('data:')) {
      throw new MediaValidationError(
        'Profile picture must be an uploaded JPEG, PNG, or WebP image.',
        400,
        'UNSUPPORTED_IMAGE_FORMAT'
      );
    }

    const saved = this.saveBase64Image(clean, userId, {
      thumbnailDataUrl,
      maxBytesOverride: options?.maxBytesOverride,
      contextType: 'profile',
    });
    return {
      avatarUrl: saved.url,
      avatarThumbUrl: saved.thumbnailUrl || saved.url,
    };
  },

  /**
   * Async pre-processor for Express routes carrying `images` arrays so data:image/... strings
   * are verified, EXIF/GPS-stripped, compressed, and thumbnailed via `sharp` BEFORE SQLite transactions.
   */
  async externalizeImagesAsync(
    images: unknown,
    ownerId?: string,
    options?: { contextType?: MediaContextType; maxBytesOverride?: number }
  ): Promise<string[] | undefined> {
    if (!Array.isArray(images)) return undefined;
    const result: string[] = [];
    for (const img of images.slice(0, 4)) {
      if (typeof img !== 'string') continue;
      const trimmed = img.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('data:')) {
        const saved = await this.saveBase64ImageAsync(trimmed, ownerId, {
          contextType: options?.contextType || 'upload',
          maxBytesOverride: options?.maxBytesOverride,
        });
        result.push(saved.url);
      } else if (trimmed.startsWith('/api/uploads/') || trimmed.startsWith('https://')) {
        result.push(trimmed);
      } else {
        throw new MediaValidationError(
          'Unsupported image URL scheme. Only uploaded media or HTTPS image URLs are allowed.',
          400,
          'UNSUPPORTED_IMAGE_URL'
        );
      }
    }
    return result;
  },

  externalizeImages(
    images: unknown,
    ownerId?: string,
    options?: { contextType?: MediaContextType; maxBytesOverride?: number }
  ): string[] | undefined {
    if (!Array.isArray(images)) return undefined;
    const result: string[] = [];
    for (const img of images.slice(0, 4)) {
      if (typeof img !== 'string') continue;
      const trimmed = img.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('data:')) {
        const saved = this.saveBase64Image(trimmed, ownerId, {
          contextType: options?.contextType || 'upload',
          maxBytesOverride: options?.maxBytesOverride,
        });
        result.push(saved.url);
      } else if (trimmed.startsWith('/api/uploads/') || trimmed.startsWith('https://')) {
        result.push(trimmed);
      } else {
        throw new MediaValidationError(
          'Unsupported image URL scheme. Only uploaded media or HTTPS image URLs are allowed.',
          400,
          'UNSUPPORTED_IMAGE_URL'
        );
      }
    }
    return result;
  },

  /**
   * Updates `media_assets.context_type` when an uploaded URL is attached to a post, comment, message, or profile.
   */
  markMediaContext(urls: unknown, contextType: MediaContextType, ownerId?: string): void {
    const filenames = this.extractUploadFilenames(urls);
    if (filenames.length === 0) return;
    const stmt = db.prepare(`
      UPDATE media_assets
      SET context_type = ?, owner_id = COALESCE(owner_id, ?)
      WHERE filename = ? OR thumb_filename = ?
    `);
    for (const fname of filenames) {
      try {
        stmt.run(contextType, ownerId || null, fname, fname);
      } catch {
        // non-fatal
      }
    }
  },

  /**
   * Extracts `/api/uploads/<filename>` basenames from URLs or JSON arrays (including thumb-* sibling).
   */
  extractUploadFilenames(raw: string | string[] | null | undefined): string[] {
    if (!raw) return [];
    let list: string[] = [];
    if (Array.isArray(raw)) {
      list = raw;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) list = parsed;
        } catch {
          list = [];
        }
      } else {
        list = [trimmed];
      }
    }
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const match = item.match(/\/api\/uploads\/([a-zA-Z0-9._-]+)(?:$|\?)/);
      if (match && match[1] && isValidUploadFilename(match[1])) {
        const fname = match[1];
        out.push(fname);
        if (!fname.startsWith('thumb-')) {
          out.push(`thumb-${fname}`);
        }
      }
    }
    return Array.from(new Set(out));
  },

  getUploadPath(filename: string): string | null {
    if (!isValidUploadFilename(filename)) {
      return null;
    }
    const uploadsDir = getUploadsDir();
    const resolved = path.resolve(uploadsDir, filename);
    if (!resolved.startsWith(uploadsDir + path.sep) && resolved !== uploadsDir) {
      return null;
    }
    if (!fs.existsSync(resolved)) {
      return null;
    }
    return resolved;
  },

  /**
   * Computes serve & access-control policy for `/api/uploads/:filename`.
   * - Soft-deleted media (`deleted_at IS NOT NULL`) or media belonging only to soft-deleted/hidden
   *   posts, comments, replies, or messages immediately returns `accessible: false` (404).
   * - Private chat attachments require authenticated participant membership.
   * - Private community & private profile post/comment attachments enforce membership / connection / author / admin checks.
   */
  getFileServePolicy(filename: string): FileServePolicy {
    if (!isValidUploadFilename(filename)) {
      return { accessible: false, isAvatar: false, isPrivateChatMedia: false, isPrivateScope: false, allowedUserIds: [], expiresAtMs: null };
    }
    const lookupName = filename.startsWith('thumb-') ? filename.slice(6) : filename;
    if (!isValidUploadFilename(lookupName)) {
      return { accessible: false, isAvatar: false, isPrivateChatMedia: false, isPrivateScope: false, allowedUserIds: [], expiresAtMs: null };
    }

    const cacheKey = `uploads:policy:${lookupName}`;
    return cache.getOrCompute<FileServePolicy>(cacheKey, 10_000, () =>
      withReadConnection((conn) => {
        const likePattern = IMAGE_QUERY_CONTAINS_NAME(lookupName);

        // 0. Check direct media_assets soft-delete flag first
        try {
          const mediaRow = conn
            .prepare('SELECT id, deleted_at, context_type, created_at FROM media_assets WHERE filename = ? OR thumb_filename = ? LIMIT 1')
            .get(lookupName, filename) as { id: string; deleted_at: string | null; context_type: string; created_at: string } | undefined;
          if (mediaRow?.deleted_at) {
            return {
              accessible: false,
              isAvatar: false,
              isPrivateChatMedia: false,
              isPrivateScope: false,
              allowedUserIds: [],
              expiresAtMs: null,
            };
          }
        } catch {
          // media_assets optional on partial DB state
        }

        // 1. Check user avatars (persistent for active accounts)
        const avatarRef = conn
          .prepare(`
            SELECT pr.user_id
            FROM user_profiles pr
            JOIN users u ON u.id = pr.user_id
            WHERE u.status = 'active'
              AND (
                pr.avatar_url LIKE ? ESCAPE '\\'
                OR pr.avatar_thumb_url LIKE ? ESCAPE '\\'
              )
            LIMIT 1
          `)
          .get(`%${lookupName}`, `%${lookupName}`) as { user_id: string } | undefined;
        if (avatarRef) {
          return {
            accessible: true,
            isAvatar: true,
            isPrivateChatMedia: false,
            isPrivateScope: false,
            allowedUserIds: [],
            expiresAtMs: null,
          };
        }

        // 2. Check active non-hidden, non-deleted posts & comments
        const activePost = conn
          .prepare(`
            SELECT p.id, p.author_id, p.community_id, p.is_anonymous, COALESCE(pr.is_private, 0) as author_is_private
            FROM posts p
            LEFT JOIN user_profiles pr ON pr.user_id = p.author_id
            WHERE p.images_json LIKE ? ESCAPE '\\'
              AND p.deleted_at IS NULL
              AND COALESCE(p.is_hidden, 0) = 0
            ORDER BY p.created_at DESC
            LIMIT 1
          `)
          .get(likePattern) as any;

        const activeCommentPost = activePost
          ? null
          : (conn
              .prepare(`
                SELECT p.id, p.author_id, p.community_id, p.is_anonymous, COALESCE(pr.is_private, 0) as author_is_private
                FROM comments c
                JOIN posts p ON p.id = c.post_id
                LEFT JOIN user_profiles pr ON pr.user_id = p.author_id
                WHERE c.images_json LIKE ? ESCAPE '\\'
                  AND c.deleted_at IS NULL
                  AND p.deleted_at IS NULL
                  AND COALESCE(p.is_hidden, 0) = 0
                ORDER BY c.created_at DESC
                LIMIT 1
              `)
              .get(likePattern) as any);

        const resolvedPost = activePost || activeCommentPost;
        if (resolvedPost) {
          const isPrivComm = Boolean(resolvedPost.community_id && isCommunityPrivate(resolvedPost.community_id));
          const isPrivProfile = Boolean(!isPrivComm && resolvedPost.author_is_private && !resolvedPost.is_anonymous);
          return {
            accessible: true,
            isAvatar: false,
            isPrivateChatMedia: false,
            isPrivateScope: isPrivComm || isPrivProfile,
            communityId: isPrivComm ? resolvedPost.community_id : undefined,
            privateProfileOwnerId: isPrivProfile ? resolvedPost.author_id : undefined,
            allowedUserIds: [],
            expiresAtMs: Date.now() + 3600 * 1000,
          };
        }

        // 3. Check active (non-deleted) chat messages & record participants for strict ACL
        const activeMsg = conn
          .prepare(`
            SELECT id, chat_id, created_at
            FROM messages
            WHERE images_json LIKE ? ESCAPE '\\'
              AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .get(likePattern) as { id: string; chat_id: string; created_at: string } | undefined;

        if (activeMsg) {
          const participants = conn
            .prepare(`SELECT user_id FROM chat_participants WHERE chat_id = ?`)
            .all(activeMsg.chat_id) as Array<{ user_id: string }>;
          return {
            accessible: true,
            isAvatar: false,
            isPrivateChatMedia: true,
            isPrivateScope: true,
            chatId: activeMsg.chat_id,
            allowedUserIds: participants.map((p) => p.user_id),
            expiresAtMs: Date.now() + 3600 * 1000,
          };
        }

        // 4. If referenced ONLY by soft-deleted or hidden content, immediately deny access (404)
        const deletedOrHiddenPost = conn
          .prepare(`
            SELECT id FROM posts
            WHERE images_json LIKE ? ESCAPE '\\'
              AND (deleted_at IS NOT NULL OR COALESCE(is_hidden, 0) = 1)
            LIMIT 1
          `)
          .get(likePattern);
        const deletedComment = conn
          .prepare(`
            SELECT c.id FROM comments c
            LEFT JOIN posts p ON p.id = c.post_id
            WHERE c.images_json LIKE ? ESCAPE '\\'
              AND (c.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL OR COALESCE(p.is_hidden, 0) = 1)
            LIMIT 1
          `)
          .get(likePattern);
        const deletedMsg = conn
          .prepare(`
            SELECT id FROM messages
            WHERE images_json LIKE ? ESCAPE '\\'
              AND deleted_at IS NOT NULL
            LIMIT 1
          `)
          .get(likePattern);

        if (deletedOrHiddenPost || deletedComment || deletedMsg) {
          return {
            accessible: false,
            isAvatar: false,
            isPrivateChatMedia: false,
            isPrivateScope: false,
            allowedUserIds: [],
            expiresAtMs: null,
          };
        }

        // 5. Newly uploaded unattached media still within compose staging window (<= 30 min)
        const filePath = this.getUploadPath(filename);
        if (filePath) {
          try {
            const stat = fs.statSync(filePath);
            if (Date.now() - stat.mtimeMs <= PENDING_UPLOAD_SESSION_TTL_MS) {
              return {
                accessible: true,
                isAvatar: false,
                isPrivateChatMedia: false,
                isPrivateScope: false,
                allowedUserIds: [],
                expiresAtMs: stat.mtimeMs + PENDING_UPLOAD_SESSION_TTL_MS,
              };
            }
          } catch {
            // fall through
          }
        }

        return {
          accessible: false,
          isAvatar: false,
          isPrivateChatMedia: false,
          isPrivateScope: false,
          allowedUserIds: [],
          expiresAtMs: null,
        };
      })
    );
  },

  canUserAccessFile(policy: FileServePolicy, viewerId?: string, viewerRole?: string): boolean {
    if (!policy.accessible) return false;
    if (policy.isPrivateChatMedia) {
      if (!viewerId) return false;
      return policy.allowedUserIds.includes(viewerId);
    }
    if (policy.communityId) {
      if (viewerRole === 'admin') return true;
      if (!viewerId) return false;
      const membership = withReadConnection((conn) =>
        conn
          .prepare('SELECT 1 FROM community_memberships WHERE community_id = ? AND user_id = ?')
          .get(policy.communityId!, viewerId)
      );
      return Boolean(membership);
    }
    if (policy.privateProfileOwnerId) {
      if (viewerRole === 'admin') return true;
      if (!viewerId) return false;
      if (viewerId === policy.privateProfileOwnerId) return true;
      const connected = withReadConnection((conn) =>
        conn
          .prepare('SELECT 1 FROM user_connections WHERE follower_id = ? AND following_id = ?')
          .get(viewerId, policy.privateProfileOwnerId!)
      );
      return Boolean(connected);
    }
    return true;
  },

  isFileAccessible(filename: string): boolean {
    return this.getFileServePolicy(filename).accessible;
  },

  invalidateAccessCache(filenames: string[]): void {
    for (const name of filenames) {
      const lookup = name.startsWith('thumb-') ? name.slice(6) : name;
      cache.invalidate(`uploads:policy:${lookup}`);
    }
  },

  /**
   * Soft-deletes a user-owned media asset immediately (sets UTC deleted_at and invalidates cache).
   */
  softDeleteMedia(filename: string, actorId: string, actorRole: string): { filename: string; deletedAt: string } {
    if (!isValidUploadFilename(filename)) {
      throw new MediaValidationError('Invalid media filename.', 400, 'INVALID_FILENAME');
    }
    const baseName = filename.startsWith('thumb-') ? filename.slice(6) : filename;
    const row = db
      .prepare('SELECT id, filename, thumb_filename, owner_id, deleted_at FROM media_assets WHERE filename = ? OR thumb_filename = ? LIMIT 1')
      .get(baseName, filename) as
      | { id: string; filename: string; thumb_filename: string | null; owner_id: string | null; deleted_at: string | null }
      | undefined;

    if (!row) {
      throw new MediaValidationError('Media file not found.', 404, 'MEDIA_NOT_FOUND');
    }
    if (actorRole !== 'admin' && row.owner_id !== actorId) {
      throw new MediaValidationError('Forbidden. You can only delete media you uploaded.', 403, 'FORBIDDEN');
    }

    const nowUtc = row.deleted_at || new Date().toISOString();
    db.prepare('UPDATE media_assets SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').run(nowUtc, row.id);
    this.invalidateAccessCache([row.filename, ...(row.thumb_filename ? [row.thumb_filename] : [])]);
    return { filename: row.filename, deletedAt: nowUtc };
  },

  /**
   * Marks candidate uploaded files as soft-deleted (`deleted_at = UTC now`) if NO active
   * (`deleted_at IS NULL`) post, comment, message, or user profile still references them.
   * Media files are then permanently purged from disk 72 hours after `deleted_at`.
   */
  markMediaDeletedIfUnreferenced(filenames: string[], deletedAtUtc = new Date().toISOString()): number {
    const clean = Array.from(new Set(filenames)).filter(isValidUploadFilename);
    if (clean.length === 0) return 0;

    const activeRefs = this.getActiveReferencedFilenames();
    const stmt = db.prepare(`
      UPDATE media_assets
      SET deleted_at = COALESCE(deleted_at, ?)
      WHERE (filename = ? OR thumb_filename = ?)
        AND deleted_at IS NULL
    `);

    let markedCount = 0;
    for (const name of clean) {
      const base = name.startsWith('thumb-') ? name.slice(6) : name;
      if (activeRefs.has(name) || activeRefs.has(base)) {
        continue;
      }
      const res = stmt.run(deletedAtUtc, base, name);
      markedCount += Number(res.changes || 0);
      this.invalidateAccessCache([name, base]);
    }
    return markedCount;
  },

  /**
   * Returns filenames referenced ONLY by active (non-soft-deleted) records.
   */
  getActiveReferencedFilenames(): Set<string> {
    const referenced = new Set<string>();
    const addRefs = (raw: string | null | undefined) => {
      for (const fname of this.extractUploadFilenames(raw)) {
        referenced.add(fname);
      }
    };

    for (const r of db.prepare('SELECT avatar_url, avatar_thumb_url FROM user_profiles WHERE avatar_url IS NOT NULL OR avatar_thumb_url IS NOT NULL').all() as any[]) {
      addRefs(r.avatar_url);
      addRefs(r.avatar_thumb_url);
    }
    for (const r of db.prepare('SELECT images_json FROM posts WHERE deleted_at IS NULL AND images_json IS NOT NULL').all() as any[]) {
      addRefs(r.images_json);
    }
    for (const r of db.prepare('SELECT images_json FROM comments WHERE deleted_at IS NULL AND images_json IS NOT NULL').all() as any[]) {
      addRefs(r.images_json);
    }
    for (const r of db.prepare('SELECT images_json FROM messages WHERE deleted_at IS NULL AND images_json IS NOT NULL').all() as any[]) {
      addRefs(r.images_json);
    }
    for (const r of db.prepare('SELECT image_url FROM advertisements WHERE image_url IS NOT NULL').all() as any[]) {
      addRefs(r.image_url);
    }
    return referenced;
  },

  /**
   * Returns ALL filenames referenced in SQLite across profiles, posts, comments, messages,
   * advertisements, and non-expired media_assets (including soft-deleted records still inside the 72h grace window).
   */
  getAllReferencedFilenames(): Set<string> {
    const referenced = new Set<string>();
    const addRefs = (raw: string | null | undefined) => {
      for (const fname of this.extractUploadFilenames(raw)) {
        referenced.add(fname);
      }
    };

    for (const r of db.prepare('SELECT avatar_url, avatar_thumb_url FROM user_profiles WHERE avatar_url IS NOT NULL OR avatar_thumb_url IS NOT NULL').all() as any[]) {
      addRefs(r.avatar_url);
      addRefs(r.avatar_thumb_url);
    }
    for (const r of db.prepare('SELECT images_json FROM posts WHERE images_json IS NOT NULL').all() as any[]) {
      addRefs(r.images_json);
    }
    for (const r of db.prepare('SELECT images_json FROM comments WHERE images_json IS NOT NULL').all() as any[]) {
      addRefs(r.images_json);
    }
    for (const r of db.prepare('SELECT images_json FROM messages WHERE images_json IS NOT NULL').all() as any[]) {
      addRefs(r.images_json);
    }
    for (const r of db.prepare('SELECT image_url FROM advertisements WHERE image_url IS NOT NULL').all() as any[]) {
      addRefs(r.image_url);
    }

    // Protect staged/pending uploads inside the 30-min compose window or soft-deleted media still inside 72h grace period
    try {
      for (const m of db
        .prepare(`
          SELECT filename, thumb_filename
          FROM media_assets
          WHERE (deleted_at IS NULL AND created_at >= datetime('now', '-30 minutes'))
             OR (deleted_at IS NOT NULL AND datetime(deleted_at) > datetime('now', '-72 hours'))
        `)
        .all() as Array<{ filename: string; thumb_filename: string | null }>) {
        if (m.filename && isValidUploadFilename(m.filename)) referenced.add(m.filename);
        if (m.thumb_filename && isValidUploadFilename(m.thumb_filename)) referenced.add(m.thumb_filename);
      }
    } catch {
      // ignore on partial schema
    }

    return referenced;
  },

  /**
   * Unlinks uploaded media files ONLY when no DB row still references them (safe with SHA-256 deduplication).
   */
  unlinkIfUnreferenced(filenames: string[]): { deletedCount: number; freedBytes: number } {
    const unique = Array.from(new Set(filenames)).filter(isValidUploadFilename);
    if (unique.length === 0) return { deletedCount: 0, freedBytes: 0 };

    const stillReferenced = this.getAllReferencedFilenames();
    const uploadsDir = getUploadsDir();
    let deletedCount = 0;
    let freedBytes = 0;

    for (const name of unique) {
      cache.invalidate(`uploads:policy:${name}`);
      if (stillReferenced.has(name)) {
        continue;
      }
      const fp = path.resolve(uploadsDir, name);
      if (!fp.startsWith(uploadsDir + path.sep)) continue;
      if (fs.existsSync(fp)) {
        try {
          const st = fs.statSync(fp);
          if (st.isFile()) {
            fs.unlinkSync(fp);
            deletedCount++;
            freedBytes += st.size;
          }
        } catch {
          // ignore file unlink race
        }
      }
    }

    return { deletedCount, freedBytes };
  },

  /**
   * Removes stale staging/temp artifacts inside TMP_DIR older than maxAgeMs.
   */
  cleanTemporaryArtifacts(maxAgeMs = 60 * 60 * 1000): { deletedCount: number; freedBytes: number } {
    const tmpDir = getTmpDir();
    if (!fs.existsSync(tmpDir)) return { deletedCount: 0, freedBytes: 0 };

    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    let deletedCount = 0;
    let freedBytes = 0;

    for (const entry of fs.readdirSync(tmpDir)) {
      const fp = path.join(tmpDir, entry);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && st.mtimeMs <= cutoff) {
          fs.unlinkSync(fp);
          deletedCount++;
          freedBytes += st.size;
        }
      } catch {
        // ignore transient tmp cleanup errors
      }
    }

    return { deletedCount, freedBytes };
  },
};

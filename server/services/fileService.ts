import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, DB_DIR, withReadConnection, CACHE_DIR, TMP_DIR } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { escapeLikePattern, sanitizeSafeUrl } from '../utils/security.js';

const EPHEMERAL_MEDIA_TTL_MS = 72 * 60 * 60 * 1000;
const SAFE_UPLOAD_FILENAME_REGEX = /^[a-zA-Z0-9_-]+\.(jpg|png|webp|avif)$/;

type SupportedImageExt = 'jpg' | 'png' | 'webp' | 'avif';

export function validateImageMagicBytes(buffer: Buffer, ext: SupportedImageExt): boolean {
  if (!buffer || buffer.length < 12) return false;

  switch (ext) {
    case 'jpg':
      // JPEG starts with FF D8 FF
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'png':
      // PNG 8-byte signature: 89 50 4E 47 0D 0A 1A 0A
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );
    case 'webp':
      // RIFF....WEBP
      return (
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    case 'avif': {
      // ISO BMFF: bytes 4..7 == 'ftyp', brand at 8..11 in {avif, avis, mif1, miaf}
      if (buffer.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
      const brand = buffer.subarray(8, 12).toString('ascii');
      return brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'miaf';
    }
    default:
      return false;
  }
}

function decodeAndValidateImageDataUrl(
  dataUrl: string,
  effectiveLimit: number = MAX_FILE_SIZE
): { ext: SupportedImageExt; buffer: Buffer } {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('Invalid image data format.');
  }

  const matches = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp|avif);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!matches || matches.length !== 3) {
    throw new Error('Unsupported or malformed image data. Allowed formats: JPEG, PNG, WebP.');
  }

  const rawFmt = matches[1].toLowerCase();
  const ext: SupportedImageExt = rawFmt === 'jpeg' ? 'jpg' : (rawFmt as SupportedImageExt);
  const cleanB64 = matches[2].replace(/[\r\n]/g, '');
  if (!cleanB64 || cleanB64.length % 4 === 1) {
    throw new Error('Malformed base64 image payload.');
  }

  // Pre-compute decoded byte length before allocating full Buffer to stop >20MB API bypasses immediately
  const padding = cleanB64.endsWith('==') ? 2 : cleanB64.endsWith('=') ? 1 : 0;
  const preEstimatedBytes = Math.floor((cleanB64.length * 3) / 4) - padding;
  if (preEstimatedBytes > effectiveLimit) {
    if (effectiveLimit < MAX_FILE_SIZE) {
      const err = new Error(
        `Storage Protection Mode active (95%+ quota): uploads above ${Math.round(effectiveLimit / 1024)}KB are temporarily restricted.`
      );
      (err as any).status = 507;
      (err as any).code = 'STORAGE_PROTECTION_ACTIVE';
      throw err;
    }
    const err = new Error(
      'Image exceeds the maximum upload size of 20MB. Please choose a JPEG, PNG, or WebP image up to 20MB.'
    );
    (err as any).status = 413;
    (err as any).code = 'IMAGE_TOO_LARGE';
    throw err;
  }

  const buffer = Buffer.from(cleanB64, 'base64');
  if (buffer.length > effectiveLimit) {
    if (effectiveLimit < MAX_FILE_SIZE) {
      const err = new Error(
        `Storage Protection Mode active (95%+ quota): uploads above ${Math.round(effectiveLimit / 1024)}KB are temporarily restricted.`
      );
      (err as any).status = 507;
      (err as any).code = 'STORAGE_PROTECTION_ACTIVE';
      throw err;
    }
    const err = new Error(
      'Image exceeds the maximum upload size of 20MB. Please choose a JPEG, PNG, or WebP image up to 20MB.'
    );
    (err as any).status = 413;
    (err as any).code = 'IMAGE_TOO_LARGE';
    throw err;
  }

  if (!validateImageMagicBytes(buffer, ext)) {
    throw new Error('Uploaded file signature does not match declared image format.');
  }

  return { ext, buffer };
}

function parseSqliteOrIsoMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
    ? `${s.replace(' ', 'T')}Z`
    : s;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export interface FileServePolicy {
  accessible: boolean;
  expiresAtMs: number | null;
  isAvatar: boolean;
  isPrivateChatMedia?: boolean;
  chatIds?: string[];
}

export function getUploadsDir(): string {
  const dir = process.env.SCHOOLBACKDOOR_UPLOADS_DIR
    ? path.resolve(process.env.SCHOOLBACKDOOR_UPLOADS_DIR)
    : path.join(DB_DIR, 'uploads');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Ensure base uploads folder exists at startup
getUploadsDir();

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB strict maximum upload size per image
export const PROTECTION_MODE_MAX_UPLOAD_BYTES = 256 * 1024; // 256KB strict cap during >= 95% storage protection

const PENDING_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000; // Unattached uploads remain valid for 30 minutes before orphan/session cleanup

export const fileService = {
  /**
   * Saves a validated base64 image (JPEG/PNG/WebP/AVIF) using content-addressed SHA-256 deduplication
   * and strict magic-byte signature verification.
   * Optionally stores a compact compressed thumbnail variant (`thumb-...`).
   */
  saveBase64Image(
    dataUrl: string,
    userId: string,
    options?: { thumbnailDataUrl?: string; maxBytesOverride?: number }
  ) {
    const effectiveLimit = options?.maxBytesOverride ?? MAX_FILE_SIZE;
    const { ext, buffer } = decodeAndValidateImageDataUrl(dataUrl, effectiveLimit);

    const uploadsDir = getUploadsDir();
    // Content-hash deduplication eliminates duplicate storage of identical images
    const shaHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 20);
    const cleanUser = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'user';
    const filename = `${cleanUser}-${shaHash}.${ext}`;
    const filePath = path.join(uploadsDir, filename);

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, buffer);
    }

    let thumbnailUrl: string | undefined;
    if (options?.thumbnailDataUrl) {
      try {
        const thumb = decodeAndValidateImageDataUrl(options.thumbnailDataUrl, effectiveLimit);
        if (thumb.buffer.length <= 512 * 1024) {
          const thumbFilename = `thumb-${cleanUser}-${shaHash}.${thumb.ext}`;
          const thumbPath = path.join(uploadsDir, thumbFilename);
          if (!fs.existsSync(thumbPath)) {
            fs.writeFileSync(thumbPath, thumb.buffer);
          }
          thumbnailUrl = `/api/uploads/${thumbFilename}`;
        }
      } catch {
        // Ignore invalid optional thumbnail instead of writing unverified bytes
      }
    }

    this.invalidateAccessCache([filename, thumbnailUrl ? path.basename(thumbnailUrl) : ''].filter(Boolean));

    return {
      filename,
      url: `/api/uploads/${filename}`,
      thumbnailUrl,
      sizeBytes: buffer.length,
      deduplicated: true,
    };
  },

  /**
   * Validates and stores a user's profile picture + thumbnail (accepts data URL or safe /api/uploads/ URL).
   */
  saveAvatarImages(
    avatarInput: string,
    userId: string,
    thumbnailInput?: string,
    options?: { maxBytesOverride?: number }
  ): { avatarUrl: string; avatarThumbUrl: string } {
    const trimmed = String(avatarInput || '').trim();
    if (!trimmed) {
      throw new Error('No profile picture provided.');
    }

    if (trimmed.startsWith('data:')) {
      const saved = this.saveBase64Image(trimmed, userId, {
        thumbnailDataUrl: thumbnailInput,
        maxBytesOverride: options?.maxBytesOverride,
      });
      return {
        avatarUrl: saved.url,
        avatarThumbUrl: saved.thumbnailUrl || saved.url,
      };
    }

    const safeMain = sanitizeSafeUrl(trimmed, { allowRelative: true });
    if (!safeMain || (!safeMain.startsWith('/api/uploads/') && !safeMain.startsWith('/assets/'))) {
      throw new Error('Invalid profile picture URL.');
    }

    let safeThumb = safeMain;
    if (thumbnailInput && typeof thumbnailInput === 'string') {
      const trimmedThumb = thumbnailInput.trim();
      if (trimmedThumb.startsWith('data:')) {
        const savedThumb = this.saveBase64Image(trimmedThumb, userId, {
          maxBytesOverride: options?.maxBytesOverride,
        });
        safeThumb = savedThumb.url;
      } else {
        const candidateThumb = sanitizeSafeUrl(trimmedThumb, { allowRelative: true });
        if (candidateThumb && (candidateThumb.startsWith('/api/uploads/') || candidateThumb.startsWith('/assets/'))) {
          safeThumb = candidateThumb;
        }
      }
    } else if (safeMain.startsWith('/api/uploads/')) {
      const base = path.basename(safeMain);
      const stem = base.replace(/\.[^.]+$/, '');
      for (const ext of ['webp', 'jpg', 'png', 'avif']) {
        const candidate = `thumb-${stem}.${ext}`;
        if (this.getUploadPath(candidate)) {
          safeThumb = `/api/uploads/${candidate}`;
          break;
        }
      }
    }

    return {
      avatarUrl: safeMain,
      avatarThumbUrl: safeThumb,
    };
  },

  /**
   * Externalizes inline `data:image/...` payloads inside posts/comments/messages into deduplicated upload files
   * and validates all remaining image URLs against safe http(s) or internal /api/uploads/ paths.
   */
  externalizeImages(
    images: string[] | undefined,
    userId: string,
    options?: { maxBytesOverride?: number }
  ): string[] | undefined {
    if (!images || !Array.isArray(images) || images.length === 0) {
      return images;
    }
    return images.map((item) => {
      if (typeof item !== 'string') {
        throw new Error('Invalid image attachment entry.');
      }
      const trimmed = item.trim();
      if (trimmed.startsWith('data:')) {
        const saved = this.saveBase64Image(trimmed, userId, options);
        return saved.url;
      }
      const safe = sanitizeSafeUrl(trimmed, { allowRelative: true });
      if (!safe) {
        throw new Error('Invalid image URL.');
      }
      if (safe.startsWith('/') && !safe.startsWith('/api/uploads/') && !safe.startsWith('/assets/')) {
        throw new Error('Relative image paths must point to /api/uploads/ or /assets/.');
      }
      return safe;
    });
  },

  /**
   * Resolves physical upload file path if present and prevents path traversal.
   */
  getUploadPath(filename: string): string | null {
    const safeFilename = path.basename(String(filename || ''));
    if (!SAFE_UPLOAD_FILENAME_REGEX.test(safeFilename)) {
      return null;
    }
    const uploadsDir = path.resolve(getUploadsDir());
    const filePath = path.resolve(uploadsDir, safeFilename);
    if (!filePath.startsWith(uploadsDir + path.sep)) {
      return null;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return filePath;
    }
    return null;
  },

  invalidateAccessCache(filenames?: string[]): void {
    if (!filenames || filenames.length === 0) {
      cache.invalidatePrefix('uploads:access:');
      return;
    }
    for (const f of filenames) {
      if (!f) continue;
      const base = path.basename(f);
      cache.invalidate(`uploads:access:${base}`);
      if (!base.startsWith('thumb-')) {
        const stem = base.replace(/\.[^.]+$/, '');
        for (const ext of ['webp', 'jpg', 'png', 'avif']) {
          cache.invalidate(`uploads:access:thumb-${stem}.${ext}`);
        }
      }
    }
  },

  /**
   * Resolves upload accessibility + exact 72-hour expiry metadata for Cache-Control & CDN headers.
   * Immediately denies any file whose referencing post/message is >72h expired or deleted.
   */
  getFileServePolicy(filename: string): FileServePolicy {
    const safeFilename = path.basename(String(filename || ''));
    if (!SAFE_UPLOAD_FILENAME_REGEX.test(safeFilename)) {
      return { accessible: false, expiresAtMs: null, isAvatar: false };
    }

    const cacheKey = `uploads:access:${safeFilename}`;
    const cached = cache.get<FileServePolicy>(cacheKey);
    if (cached) {
      if (!cached.accessible) return cached;
      if (cached.expiresAtMs !== null && Date.now() >= cached.expiresAtMs) {
        cache.invalidate(cacheKey);
        return { accessible: false, expiresAtMs: null, isAvatar: false };
      }
      return cached;
    }

    const filePath = this.getUploadPath(safeFilename);
    if (!filePath) {
      const denied: FileServePolicy = { accessible: false, expiresAtMs: null, isAvatar: false };
      cache.set(cacheKey, denied, 10000);
      return denied;
    }

    const lookupName = safeFilename.startsWith('thumb-')
      ? safeFilename.slice('thumb-'.length)
      : safeFilename;
    const likePattern = `%/api/uploads/${escapeLikePattern(lookupName)}%`;
    const thumbPattern = `%/api/uploads/${escapeLikePattern(safeFilename)}%`;

    const policy = withReadConnection<FileServePolicy & { isUnattachedCompose?: boolean }>((conn) => {
      // 1. Active user profile avatars remain accessible long-term
      const activeAvatar = conn.prepare(`
        SELECT 1 FROM user_profiles
        WHERE avatar_url LIKE ? ESCAPE '\\'
           OR avatar_url LIKE ? ESCAPE '\\'
           OR avatar_thumb_url LIKE ? ESCAPE '\\'
           OR avatar_thumb_url LIKE ? ESCAPE '\\'
        LIMIT 1
      `).get(likePattern, thumbPattern, likePattern, thumbPattern);
      if (activeAvatar) {
        return { accessible: true, expiresAtMs: null, isAvatar: true, isPrivateChatMedia: false };
      }

      // 2. Active (< 72h) visible public/community posts and comments — remains serveable to authorized viewers of the feed
      const activePostRef = conn.prepare(`
        SELECT MAX(created_at) as latest_created_at FROM (
          SELECT created_at FROM posts
          WHERE (images_json LIKE ? ESCAPE '\\' OR images_json LIKE ? ESCAPE '\\')
            AND COALESCE(is_hidden, 0) = 0
            AND created_at >= datetime('now', '-72 hours')
          UNION ALL
          SELECT p.created_at as created_at FROM comments c
          JOIN posts p ON p.id = c.post_id
          WHERE (c.images_json LIKE ? ESCAPE '\\' OR c.images_json LIKE ? ESCAPE '\\')
            AND COALESCE(p.is_hidden, 0) = 0
            AND p.created_at >= datetime('now', '-72 hours')
        )
      `).get(likePattern, thumbPattern, likePattern, thumbPattern) as { latest_created_at: string | null } | undefined;

      if (activePostRef?.latest_created_at) {
        const createdMs = parseSqliteOrIsoMs(activePostRef.latest_created_at);
        const expiresAtMs = createdMs > 0 ? createdMs + EPHEMERAL_MEDIA_TTL_MS : 0;
        if (expiresAtMs > Date.now()) {
          return { accessible: true, expiresAtMs, isAvatar: false, isPrivateChatMedia: false };
        }
        return { accessible: false, expiresAtMs: null, isAvatar: false };
      }

      // 3. Active (< 72h) private chat messages — strictly restricted to chat participants or Admin
      const activeMsgRefs = conn.prepare(`
        SELECT chat_id, created_at FROM messages
        WHERE (images_json LIKE ? ESCAPE '\\' OR images_json LIKE ? ESCAPE '\\')
          AND created_at >= datetime('now', '-72 hours')
        ORDER BY created_at DESC
        LIMIT 20
      `).all(likePattern, thumbPattern) as Array<{ chat_id: string; created_at: string }>;

      if (activeMsgRefs.length > 0) {
        let maxExpiresAtMs = 0;
        const chatIds = Array.from(new Set(activeMsgRefs.map((r) => r.chat_id).filter(Boolean)));
        for (const r of activeMsgRefs) {
          const ms = parseSqliteOrIsoMs(r.created_at);
          if (ms > 0) maxExpiresAtMs = Math.max(maxExpiresAtMs, ms + EPHEMERAL_MEDIA_TTL_MS);
        }
        if (maxExpiresAtMs > Date.now()) {
          return {
            accessible: true,
            expiresAtMs: maxExpiresAtMs,
            isAvatar: false,
            isPrivateChatMedia: true,
            chatIds,
          };
        }
        return { accessible: false, expiresAtMs: null, isAvatar: false };
      }

      // 4. Block expired-only references immediately
      const expiredOnlyRef = conn.prepare(`
        SELECT 1 FROM posts WHERE (images_json LIKE ? ESCAPE '\\' OR images_json LIKE ? ESCAPE '\\') AND created_at < datetime('now', '-72 hours')
        UNION ALL
        SELECT 1 FROM comments c JOIN posts p ON p.id = c.post_id WHERE (c.images_json LIKE ? ESCAPE '\\' OR c.images_json LIKE ? ESCAPE '\\') AND p.created_at < datetime('now', '-72 hours')
        UNION ALL
        SELECT 1 FROM messages WHERE (images_json LIKE ? ESCAPE '\\' OR images_json LIKE ? ESCAPE '\\') AND created_at < datetime('now', '-72 hours')
        LIMIT 1
      `).get(likePattern, thumbPattern, likePattern, thumbPattern, likePattern, thumbPattern);
      if (expiredOnlyRef) {
        return { accessible: false, expiresAtMs: null, isAvatar: false };
      }

      // 5. Unattached upload still within active 30-min compose session window
      try {
        const stat = fs.statSync(filePath);
        const composeExpiry = stat.mtimeMs + PENDING_UPLOAD_SESSION_TTL_MS;
        if (Date.now() <= composeExpiry) {
          return { accessible: true, expiresAtMs: composeExpiry, isAvatar: false, isPrivateChatMedia: false, isUnattachedCompose: true };
        }
      } catch {
        // fall through
      }

      return { accessible: false, expiresAtMs: null, isAvatar: false };
    });

    const cleanPolicy: FileServePolicy = {
      accessible: policy.accessible,
      expiresAtMs: policy.expiresAtMs,
      isAvatar: policy.isAvatar,
      isPrivateChatMedia: policy.isPrivateChatMedia,
      chatIds: policy.chatIds,
    };

    if (!policy.accessible) {
      cache.set(cacheKey, cleanPolicy, 10000);
    } else if (policy.isAvatar) {
      cache.set(cacheKey, cleanPolicy, 60000);
    } else if (!policy.isUnattachedCompose && policy.expiresAtMs !== null) {
      const remaining = Math.max(0, policy.expiresAtMs - Date.now());
      if (remaining > 0) {
        cache.set(cacheKey, cleanPolicy, Math.min(30000, remaining));
      }
    }

    return cleanPolicy;
  },

  canUserAccessFile(policy: FileServePolicy, userId?: string, role?: string): boolean {
    if (!policy.accessible) return false;
    if (!policy.isPrivateChatMedia) return true;
    if (!userId) return false;
    if (role === 'admin') return true;
    const chatIds = policy.chatIds || [];
    if (chatIds.length === 0) return false;
    const placeholders = chatIds.map(() => '?').join(',');
    const match = db.prepare(`
      SELECT 1 FROM chat_participants
      WHERE user_id = ? AND chat_id IN (${placeholders})
      LIMIT 1
    `).get(userId, ...chatIds);
    return Boolean(match);
  },

  /**
   * Checks whether an uploaded file is permitted to be served via /api/uploads/:filename.
   * Immediately blocks access if every referencing post/message is >72h expired or deleted,
   * even before background physical file cleanup completes.
   */
  isFileAccessible(filename: string): boolean {
    return this.getFileServePolicy(filename).accessible;
  },

  /**
   * Extracts `/api/uploads/<filename>` basenames + derived `thumb-<filename>` from any JSON or URL string.
   */
  extractUploadFilenames(raw: string | null | undefined): string[] {
    if (!raw) return [];
    const matches = String(raw).match(/\/api\/uploads\/([a-zA-Z0-9._-]+)/g);
    if (!matches) return [];
    const result = new Set<string>();
    for (const m of matches) {
      const base = path.basename(m);
      result.add(base);
      if (!base.startsWith('thumb-')) {
        const stem = base.replace(/\.[^.]+$/, '');
        for (const ext of ['webp', 'jpg', 'png', 'avif']) {
          result.add(`thumb-${stem}.${ext}`);
        }
      }
    }
    return Array.from(result);
  },

  /**
   * Collects all currently active/referenced filenames across posts, messages, and profiles.
   */
  getAllReferencedFilenames(): Set<string> {
    const referenced = new Set<string>();
    const addFrom = (val: string | null | undefined) => {
      for (const f of this.extractUploadFilenames(val)) {
        referenced.add(f);
      }
    };

    for (const r of db.prepare('SELECT images_json FROM posts WHERE images_json IS NOT NULL').all() as any[]) {
      addFrom(r.images_json);
    }
    for (const r of db.prepare('SELECT images_json FROM comments WHERE images_json IS NOT NULL').all() as any[]) {
      addFrom(r.images_json);
    }
    for (const r of db.prepare('SELECT images_json FROM messages WHERE images_json IS NOT NULL').all() as any[]) {
      addFrom(r.images_json);
    }
    for (const r of db.prepare('SELECT avatar_url, avatar_thumb_url FROM user_profiles WHERE avatar_url IS NOT NULL OR avatar_thumb_url IS NOT NULL').all() as any[]) {
      addFrom(r.avatar_url);
      addFrom(r.avatar_thumb_url);
    }
    return referenced;
  },

  /**
   * Safely unlinks candidate files on disk ONLY if no active DB record still references them.
   */
  unlinkIfUnreferenced(candidateFilenames: string[]): { deletedCount: number; freedBytes: number } {
    if (!candidateFilenames || candidateFilenames.length === 0) {
      return { deletedCount: 0, freedBytes: 0 };
    }
    const uploadsDir = getUploadsDir();
    const stillReferenced = this.getAllReferencedFilenames();
    let deletedCount = 0;
    let freedBytes = 0;

    for (const name of new Set(candidateFilenames)) {
      const safeName = path.basename(name);
      if (stillReferenced.has(safeName)) continue;
      const fp = path.join(uploadsDir, safeName);
      if (fs.existsSync(fp)) {
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile()) {
            fs.unlinkSync(fp);
            deletedCount++;
            freedBytes += stat.size;
          }
        } catch {
          // ignore transient unlink error
        }
      }
    }

    if (deletedCount > 0) {
      this.invalidateAccessCache(candidateFilenames);
    }

    return { deletedCount, freedBytes };
  },

  /**
   * Cleans expired temporary files, temp exports, and file cache artifacts older than `maxAgeMs`.
   */
  cleanTemporaryArtifacts(maxAgeMs = 60 * 60 * 1000): { deletedCount: number; freedBytes: number } {
    const now = Date.now();
    let deletedCount = 0;
    let freedBytes = 0;

    for (const dir of [TMP_DIR, CACHE_DIR, path.join(getUploadsDir(), 'tmp')]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        const fp = path.join(dir, entry);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && now - st.mtimeMs >= maxAgeMs) {
            fs.unlinkSync(fp);
            deletedCount++;
            freedBytes += st.size;
          }
        } catch {
          // ignore
        }
      }
    }

    return { deletedCount, freedBytes };
  },
};

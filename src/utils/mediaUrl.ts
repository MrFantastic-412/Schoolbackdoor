const CDN_BASE =
  typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_CDN_URL
    ? String((import.meta as any).env.VITE_CDN_URL).trim().replace(/\/+$/, '')
    : '';

const API_ORIGIN = (() => {
  if (typeof import.meta === 'undefined') return '';
  const raw = (import.meta as any).env?.VITE_API_URL;
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  return /^https?:\/\//i.test(cleaned) ? cleaned : '';
})();

const SAFE_DATA_IMAGE_REGEX = /^data:image\/(jpeg|jpg|png|webp|avif);base64,[A-Za-z0-9+/=]+$/i;

/**
 * Resolves a public or uploaded asset path against an optional configured CDN origin
 * (`VITE_CDN_URL`) or split backend API origin (`VITE_API_URL`), rejecting dangerous
 * URI schemes (`javascript:`, SVG/HTML `data:`, `//`).
 */
export function resolveMediaUrl(url?: string): string {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed || /[\x00-\x1F\x7F]/.test(trimmed)) return '';

  if (trimmed.startsWith('data:')) {
    return SAFE_DATA_IMAGE_REGEX.test(trimmed) ? trimmed : '';
  }
  if (trimmed.startsWith('blob:')) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return '';
  }
  if (CDN_BASE && (trimmed.startsWith('/api/uploads/') || trimmed.startsWith('/assets/'))) {
    return `${CDN_BASE}${trimmed}`;
  }
  if (API_ORIGIN && trimmed.startsWith('/api/uploads/')) {
    return `${API_ORIGIN}${trimmed}`;
  }
  return trimmed.startsWith('/') ? trimmed : '';
}

/**
 * Maps an `/api/uploads/<file>` URL to its compact 320px thumbnail sibling (`thumb-<file>`)
 * for lightweight feed/gallery rendering. Callers should pair with an `onError` fallback
 * to `resolveMediaUrl(url)` for legacy uploads that lack a generated thumbnail.
 */
export function getThumbnailUrl(url?: string): string {
  const safeUrl = resolveMediaUrl(url);
  if (!safeUrl) return '';
  if (safeUrl.startsWith('data:') || safeUrl.startsWith('blob:')) return safeUrl;

  const marker = '/api/uploads/';
  const idx = safeUrl.indexOf(marker);
  if (idx === -1) return safeUrl;

  const prefix = safeUrl.slice(0, idx + marker.length);
  const rest = safeUrl.slice(idx + marker.length);
  if (!rest || rest.startsWith('thumb-')) {
    return safeUrl;
  }

  return `${prefix}thumb-${rest}`;
}

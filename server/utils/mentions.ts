export interface ResolvedMention {
  userId: string;
  handle: string;
  name: string;
}

/**
 * Matches valid @username tokens strictly at word/punctuation boundaries.
 * Rejects email addresses (e.g. name@gmail.com or @gmail.com) and mid-word @ symbols.
 */
export const MENTION_TOKEN_REGEX =
  /(^|[\s(\[{<"':,;!?*])(@[a-zA-Z0-9_]{2,30})(?=$|[\s)\]}>"',:;!?*]|\.(?=$|[\s)\]}>"',:;!?]))/g;

export const MAX_MENTIONS_PER_CONTENT = 15;

export function extractMentionHandles(text: string | null | undefined): string[] {
  if (!text || typeof text !== 'string') return [];

  const seen = new Set<string>();
  const handles: string[] = [];
  const regex = new RegExp(MENTION_TOKEN_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const rawHandle = match[2];
    if (!rawHandle) continue;
    const normalized = rawHandle.toLowerCase();
    if (normalized === '@anonymous') continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      handles.push(normalized);
      if (handles.length >= MAX_MENTIONS_PER_CONTENT) break;
    }
  }

  return handles;
}

export function formatMentionSnippet(text: string | null | undefined, maxLength = 80): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

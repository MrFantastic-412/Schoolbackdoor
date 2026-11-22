import { ResolvedMention } from '../types';

/**
 * Matches valid @username tokens strictly at word or punctuation boundaries.
 * Rejects emails (e.g. student@gmail.com) and mid-word @ symbols.
 */
export const MENTION_TOKEN_REGEX =
  /(^|[\s(\[{<"':,;!?*])(@[a-zA-Z0-9_]{2,30})(?=$|[\s)\]}>"',:;!?*]|\.(?=$|[\s)\]}>"',:;!?]))/g;

export type MentionTextSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string; mention: ResolvedMention };

/**
 * Splits text into plain text segments and verified clickable mention tokens.
 * Unresolved, nonexistent, or blocked handles stay plain text to prevent broken links.
 */
export function tokenizeMentionText(
  text: string | null | undefined,
  mentions?: ResolvedMention[]
): MentionTextSegment[] {
  if (!text) return [];
  if (!mentions || mentions.length === 0) {
    return [{ type: 'text', value: text }];
  }

  const byHandle = new Map<string, ResolvedMention>();
  for (const m of mentions) {
    if (!m?.handle || !m?.userId) continue;
    const normalized = m.handle.startsWith('@') ? m.handle.toLowerCase() : `@${m.handle.toLowerCase()}`;
    byHandle.set(normalized, m);
  }

  if (byHandle.size === 0) {
    return [{ type: 'text', value: text }];
  }

  const segments: MentionTextSegment[] = [];
  const regex = new RegExp(MENTION_TOKEN_REGEX.source, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string) => {
    if (!chunk) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.type === 'text') {
      prev.value += chunk;
    } else {
      segments.push({ type: 'text', value: chunk });
    }
  };

  while ((match = regex.exec(text)) !== null) {
    const boundaryPrefix = match[1] || '';
    const rawHandle = match[2];
    if (!rawHandle) continue;

    const handleStart = match.index + boundaryPrefix.length;
    if (handleStart > cursor) {
      pushText(text.slice(cursor, handleStart));
    }

    const resolved = byHandle.get(rawHandle.toLowerCase());
    if (resolved) {
      segments.push({
        type: 'mention',
        value: rawHandle,
        mention: resolved,
      });
    } else {
      pushText(rawHandle);
    }

    cursor = handleStart + rawHandle.length;
  }

  if (cursor < text.length) {
    pushText(text.slice(cursor));
  }

  return segments;
}

export interface ActiveMentionQuery {
  startIndex: number;
  endIndex: number;
  query: string;
}

const VALID_PREFIX_BOUNDARY = /^[\s(\[{<"':,;!?*]$/;

/**
 * Inspects the substring ending at `cursorPos` to detect an active `@query` autocomplete trigger.
 * Emails such as `user@gmail` are ignored because the character preceding `@` is alphanumeric.
 */
export function findActiveMentionQuery(
  text: string,
  cursorPos: number | null | undefined
): ActiveMentionQuery | null {
  if (!text || cursorPos === null || cursorPos === undefined || cursorPos <= 0) {
    return null;
  }

  const clampedCursor = Math.min(cursorPos, text.length);
  let idx = clampedCursor - 1;

  while (idx >= 0) {
    const ch = text[idx];
    if (ch === '@') {
      const charBefore = idx > 0 ? text[idx - 1] : '';
      if (idx > 0 && !VALID_PREFIX_BOUNDARY.test(charBefore)) {
        return null;
      }
      const query = text.slice(idx + 1, clampedCursor);
      if (query.length > 30 || !/^[a-zA-Z0-9_]*$/.test(query)) {
        return null;
      }
      return {
        startIndex: idx,
        endIndex: clampedCursor,
        query,
      };
    }

    if (!/[a-zA-Z0-9_]/.test(ch)) {
      return null;
    }

    if (clampedCursor - idx > 31) {
      return null;
    }

    idx -= 1;
  }

  return null;
}

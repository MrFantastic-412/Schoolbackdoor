export type HapticPattern = 'tap' | 'like' | 'close' | 'success' | 'error';

const HAPTIC_PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 8,
  like: [10, 22, 14],
  close: 6,
  success: [12, 28, 16],
  error: [22, 36, 22],
};

/**
 * Triggers subtle mobile tactile feedback via the Vibration API while
 * respecting reduced-motion preferences and non-supporting environments.
 */
export function triggerHaptic(pattern: HapticPattern = 'tap'): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (typeof navigator.vibrate !== 'function') return;

  try {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    navigator.vibrate(HAPTIC_PATTERNS[pattern]);
  } catch {
    // Ignore environments where vibration is blocked or disallowed
  }
}

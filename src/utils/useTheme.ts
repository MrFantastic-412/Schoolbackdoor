import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'sb_theme';
const THEME_EVENT = 'sb-theme-change';

export function getStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const val = window.localStorage.getItem(STORAGE_KEY);
    if (val === 'light' || val === 'dark' || val === 'system') {
      return val;
    }
  } catch {
    // ignore storage errors
  }
  return 'system';
}

export function resolveDarkMode(pref: ThemePreference): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
}

export function applyThemePreference(pref: ThemePreference): boolean {
  const isDark = resolveDarkMode(pref);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.classList.toggle('dark', isDark);
    root.style.colorScheme = isDark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', isDark ? '#0F0E0C' : '#F5EFE3');
    }
  }
  return isDark;
}

export function setThemePreference(pref: ThemePreference): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // ignore storage errors
    }
    applyThemePreference(pref);
    window.dispatchEvent(new CustomEvent<ThemePreference>(THEME_EVENT, { detail: pref }));
  }
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    getStoredThemePreference()
  );
  const [isDark, setIsDark] = useState<boolean>(() =>
    resolveDarkMode(getStoredThemePreference())
  );

  useEffect(() => {
    const sync = (nextPref?: ThemePreference) => {
      const current = nextPref || getStoredThemePreference();
      setPreferenceState(current);
      setIsDark(applyThemePreference(current));
    };

    sync(preference);

    const onCustomTheme = (e: Event) => {
      const detail = (e as CustomEvent<ThemePreference>).detail;
      sync(detail || getStoredThemePreference());
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        sync();
      }
    };

    const mql =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const onMediaChange = () => {
      if (getStoredThemePreference() === 'system') {
        sync('system');
      }
    };

    window.addEventListener(THEME_EVENT, onCustomTheme);
    window.addEventListener('storage', onStorage);
    mql?.addEventListener('change', onMediaChange);

    return () => {
      window.removeEventListener(THEME_EVENT, onCustomTheme);
      window.removeEventListener('storage', onStorage);
      mql?.removeEventListener('change', onMediaChange);
    };
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    setThemePreference(next);
  }, []);

  const cycleTheme = useCallback(() => {
    const order: ThemePreference[] = ['system', 'light', 'dark'];
    const idx = order.indexOf(getStoredThemePreference());
    const next = order[(idx + 1) % order.length];
    setPreference(next);
  }, [setPreference]);

  return {
    preference,
    isDark,
    resolvedTheme: (isDark ? 'dark' : 'light') as 'dark' | 'light',
    setPreference,
    setTheme: setPreference,
    cycleTheme,
  };
}

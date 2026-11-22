import { useEffect, useState } from 'react';

/**
 * Delays updating the returned value until `delayMs` milliseconds have elapsed
 * since the last change to `value`. Prevents excessive filtering and API bursts while typing.
 */
export function useDebounce<T>(value: T, delayMs = 250): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}

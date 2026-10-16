import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether the pointer or focus rested on something long enough to mean it,
 * rather than passing over on the way elsewhere. Once meant, it stays meant.
 */
export function useIntent(delayMs = 100) {
  const [intended, setIntended] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const begin = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIntended(true), delayMs);
  }, [delayMs]);
  const end = useCallback(() => clearTimeout(timer.current), []);
  return { intended, begin, end };
}

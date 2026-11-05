import { useEffect, useState } from 'react';

/**
 * Background state (sync, reconnects) stays silent while it heals by itself.
 * Returns true only once `active` has lasted `delay` ms, so a reconnect blip
 * or a normal confirmation never moves anything on screen.
 */
export function useSustained(active: boolean, delay: number) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return active && shown;
}

/** Re-render once a second only while there is something to age. */
export function useClock(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

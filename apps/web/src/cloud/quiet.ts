import { useCloudSync } from './sync';
export { useSustained, useClock } from '../utils/useSustained';

/**
 * How long a pending item has waited while the connection was usable.
 * Offline or degraded time does not count: queued work is expected then.
 */
export function useHealthyAge() {
  const healthySince = useCloudSync(state => state.healthySince);
  return (createdAt: number, now: number) => healthySince ? now - Math.max(createdAt, healthySince) : 0;
}

import { readRendererPluginAsset } from '../client/plugin-renderer-assets';
import { accountLifecycle, accountLifetime, type AccountLifetime } from '../client/account-lifecycle';
import { cloud } from '../cloud/state';

/** One in-flight read per account session/resource, never cache mutations. */
const reads = new Map<string, { promise: Promise<unknown>; at: number; lifetime: AccountLifetime }>();
export function pluginRead<T>(path: string, ttl = 1000): Promise<T> {
  if (!cloud.enabled || !cloud.userId) return Promise.reject(new Error('client_unauthenticated'));
  const lifetime = accountLifetime(cloud.userId);
  const previous = reads.get(path);
  if (previous?.lifetime === lifetime && Date.now() - previous.at < ttl) return previous.promise as Promise<T>;
  const entry = { at: Date.now(), lifetime, promise: readRendererPluginAsset<T>(path).then(value => { lifetime.assertCurrent(); return value; }) };
  reads.set(path, entry);
  void entry.promise.catch(() => { if (reads.get(path) === entry) reads.delete(path); });
  return entry.promise;
}
export function clearPluginReads() { reads.clear(); }
// Account-keyed drafts are durable user intent, not a disposable read cache.
const stopDisposal = accountLifecycle.onDisposed(clearPluginReads);
import.meta.hot?.dispose(stopDisposal);

import { Context, type Fiber } from '@deepseek-ai/cordis';

export interface ScopeIdentity { server: string; account: string; project: string; instance: string; placement: string; revision: number | undefined }
type Level = 'account' | 'project' | 'instance' | 'placement';
type Node = { key: string; level: Level; ctx: Context; fiber: Fiber; refs: number; incarnation: number; active: boolean };
export interface PlacementLease {
  incarnation: number;
  current(): boolean;
  assertCurrent(): void;
  own(start: () => () => void): () => void;
  release(): void;
}

/** Index of Cordis fibers, not a second effect/DI container. */
export function createPluginScopes(root: Context) {
  const nodes = new Map<string, Node>();
  const leases = new Set<PlacementLease>();
  let sequence = 0, created = 0, released = 0, retains = 0, failures = 0, observations = 0, observationReleases = 0;
  const pending = new Set<Promise<unknown>>();
  const dispose = (node: Node) => {
    if (!node.active) return;
    node.active = false;
    nodes.delete(node.key);
    const work = Promise.resolve(node.fiber.dispose()).finally(() => { released++; pending.delete(work); });
    pending.add(work);
    void work.catch(() => { failures++; });
  };
  const acquire = (identity: ScopeIdentity): PlacementLease => {
    const chain: Node[] = [];
    let parent = root;
    const values = [identity.server, identity.account];
    for (const [level, value] of [['account', undefined], ['project', identity.project], ['instance', identity.instance], ['placement', identity.placement]] as const) {
      if (value !== undefined) values.push(value);
      if (level === 'instance') values.push(String(identity.revision));
      const key = JSON.stringify(values);
      let node = nodes.get(key);
      if (!node) {
        const token = `wangke.plugin.${level}`;
        const incarnation = ++sequence;
        const fiber = parent.isolate(token).plugin({ name: `plugin-${level}`, apply(ctx: Context) { ctx.provide(token, { incarnation }); } });
        node = { key, level, ctx: fiber.ctx, fiber, refs: 0, incarnation, active: true };
        nodes.set(key, node); created++;
      }
      node.refs++; chain.push(node); parent = node.ctx;
    }
    const placement = chain[3];
    let live = true;
    // One child per committed mount; duplicate mounts cannot release each other.
    const owner = placement.ctx.plugin({ name: 'plugin-occurrence', inject: ['wangke.plugin.account', 'wangke.plugin.project', 'wangke.plugin.instance', 'wangke.plugin.placement'], apply() {} });
    retains++;
    const current = () => live && chain.every(node => node.active) && owner.uid !== null;
    const lease: PlacementLease = {
      incarnation: ++sequence, current,
      assertCurrent() { if (!current()) throw new Error('plugin_scope_expired'); },
      own(start) {
        if (!current()) throw new Error('plugin_scope_expired');
        return owner.ctx.effect(() => {
          let stop: () => void;
          try { stop = start(); } catch (error) { failures++; throw error; }
          observations++;
          return () => { try { stop(); } finally { observations--; observationReleases++; } };
        }, 'plugin observation');
      },
      release() {
        if (!live) return;
        live = false; retains--; leases.delete(lease);
        void Promise.resolve(owner.dispose()).catch(() => { failures++; });
        for (const node of [...chain].reverse()) if (--node.refs === 0) dispose(node);
      },
    };
    leases.add(lease);
    return lease;
  };
  return {
    acquire,
    recordFailure() { failures++; },
    invalidate() {
      for (const lease of [...leases]) lease.release();
      for (const node of [...nodes.values()].reverse()) dispose(node);
    },
    async settled() { while (pending.size) await Promise.allSettled([...pending]); },
    diagnostics: () => ({ scopes: Object.fromEntries((['account', 'project', 'instance', 'placement'] as Level[]).map(level => [level, [...nodes.values()].filter(n => n.level === level).length])),
      refs: [...nodes.values()].reduce((sum, node) => sum + node.refs, 0), retains, created, released, failures, observations, observationReleases,
      // Deliberately omit IDs, URLs, drafts, arguments, errors and credentials.
      fibers: [...nodes.values()].map(node => ({ level: node.level, incarnation: node.incarnation, refs: node.refs, state: node.fiber.state })) }),
  };
}

import WebSocket from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { apply as installGateway } from '@deepseek-ai/dsh-api-gateway/client';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';

/** A real generated client/codec over HTTP and multiplexed WebSocket. */
export async function fixtureRemote(origin, headers) {
  const ctx = new Context();
  await ctx.plugin(TypertRegistry);
  installConnection(ctx, { interactions: 'answer', transport: {
    fetch: (url, init) => fetch(new URL(url, origin), { ...init, headers: { ...init?.headers, ...headers } }),
    streamBaseUrl: origin,
    createWebSocket: url => new WebSocket(url, { headers: { origin, ...headers } }),
  } });
  await ctx.plugin(installGateway);
  await ctx.remote.$mount(TYPERT_REMOTE);
  return { client: ctx.remote.clientRuntime, executor: ctx.remote.executorRuntime, close: () => ctx.fiber.dispose() };
}

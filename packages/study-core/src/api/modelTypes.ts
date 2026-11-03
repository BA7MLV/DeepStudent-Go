import type { ModelOverrides } from './modelMeta.ts';

export type ApiProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** Request-scoped connection; never persisted or logged by shared logic. */
export interface ModelTarget {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  catalogId: string;
  protocol: ApiProtocol;
  capabilities?: ModelOverrides;
  /** Transport policy, credentials and retries belong to the server Gateway. */
  gatewayManaged?: boolean;
  /** Audited wire-provider hint retained by a virtual Gateway target. Never a
   * metadata override or a credential-bearing endpoint. */
  reasoningProvider?: string;
  /** Opaque endpoint fingerprint for server-managed continuation. */
  stateScope?: string;
}

export interface ModelListConnection {
  baseUrl: string;
  apiKey: string;
  protocol?: ApiProtocol;
  credentials?: RequestCredentials;
  cacheScope?: string;
}

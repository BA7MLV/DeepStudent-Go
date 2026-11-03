/** Transport-neutral contract. Connections and credentials are deliberately absent. */
export type ModelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type ModelThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Endpoint-bound opaque state. Servers use a fingerprint, not a private URL. */
export interface ModelProviderState {
  providerId: string; baseUrl: string; model: string; protocol: ModelProtocol;
  items: Record<string, any>[];
}
export type ModelPurpose = 'chat' | 'bot' | 'vision' | 'asr' | 'decision' | 'memory';
export interface ModelRef { providerId: string; model: string }
/** Per-model wire deployment. No credentials; unspecified fields inherit the connection. */
export interface ModelDeployment {
  model: string; protocol: ModelProtocol; baseUrl?: string; dataPolicy?: string;
  /** Restricted/unknown policy models may be used explicitly, never silently as fallback. */
  allowFallback?: boolean;
}
export type ModelErrorClass = 'auth_failed' | 'quota_exhausted' | 'rate_limited' | 'timeout' | 'network' | 'server_error' | 'context_exceeded' | 'content_policy' | 'invalid_request' | 'model_not_found' | 'incomplete_response' | 'cancelled';
export interface ModelCandidate { ref: ModelRef; enabled?: boolean; weight?: number; tags?: string[] }
export interface ModelPreset {
  id: string; name: string; purposes: ModelPurpose[]; candidates: ModelCandidate[];
  policy?: { maxAttemptsPerCandidate?: number; fallbackOn?: ModelErrorClass[]; maxChainMs?: number; allowCrossProvider?: boolean };
}
export interface ModelRouteDefaults { byPurpose: Partial<Record<ModelPurpose, string>> }
export interface ModelTool { type: string; function: { name: string; description: string; parameters: object } }
export interface ModelCall { id: string; provider_id?: string; type: 'function'; function: { name: string; arguments: string } }
export interface ModelMessage {
  role: string; content: string | null; tool_call_id?: string; tool_calls?: ModelCall[];
  reasoning_content?: string; providerState?: ModelProviderState;
  response_items?: object[]; checkpoint_id?: string; runtime_notice?: boolean;
}
export interface ModelImage { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export interface ModelAudio { mime: string; data: string; filename: string }
export interface ModelGatewayInput {
  purpose: ModelPurpose; presetId?: string; modelRef?: ModelRef;
  messages?: ModelMessage[]; tools?: ModelTool[]; image?: ModelImage; audio?: ModelAudio;
  outputTokens?: number; cacheKey?: string; idempotencyKey?: string;
  thinkingLevel?: ModelThinkingLevel; temperature?: number; toolChoice?: 'auto' | 'none';
  /** Stable conversation identity; never an attempt/run-generated ID. */
  conversationId?: string;
  /** Origin of native continuation. Gateway removes native items on a model change. */
  continuationRef?: ModelRef;
  /** Never replay a tool round: this call only produces the next model response. */
  sideEffectsOccurred?: boolean;
}
/** owner/run/task are server-issued, never trusted from HTTP input. */
export interface ModelGatewayRequest extends ModelGatewayInput {
  owner: string; run?: string; step?: string; task?: string; signal: AbortSignal;
}
export interface ModelAttemptSummary {
  candidateIndex: number; attempt: number; providerId: string; model: string;
  durationMs: number; outcome: 'completed' | 'failed' | 'skipped'; errorClass?: ModelErrorClass;
}
export interface ModelGatewayResult {
  providerId: string; model: string; protocol: ModelProtocol; traceId: string;
  response: { text: string; calls: Array<{ id?: string; function: ModelCall['function'] }>; reasoning?: string; providerState?: ModelProviderState; continuation?: object[]; truncated?: boolean };
  usage?: { input: number; output: number; cache?: number; cacheCreation?: number; reasoning?: number };
  continuationReusable: boolean; attempts: ModelAttemptSummary[];
}

import type { DiscoveredModel } from './modelDiscoveryData';

/**
 * TypeSafe 的 /models 目录在部分账号或地区会返回 451，但 versioned IDs
 * 仍可直接发送到 /systemone。这里只提供已知候选，不把它们当成当前 Key
 * 已授权的证明；真正可用性仍由连接测试确认。
 */
const TYPE_SAFE_MODELS: readonly DiscoveredModel[] = [
  { id: 'jev-1.14.0', name: 'Jev 1.14.0', modelType: 'decision', contextWindow: 32_000, maxOutputTokens: 0, inputCapabilities: ['text'], toolCalling: false },
  { id: 'jev-1.13.0', name: 'Jev 1.13.0', modelType: 'decision', contextWindow: 32_000, maxOutputTokens: 0, inputCapabilities: ['text'], toolCalling: false },
  { id: 'jev', name: 'Jev', modelType: 'decision', contextWindow: 32_000, maxOutputTokens: 0, inputCapabilities: ['text'], toolCalling: false },
];

export function isTypeSafeConnection(connection: { catalogId?: string; baseUrl: string }): boolean {
  if (connection.catalogId === 'typesafe') return true;
  try { return new URL(connection.baseUrl).hostname === 'api.typesafe.ai'; }
  catch { return false; }
}

export function typeSafeFallbackModels(): DiscoveredModel[] {
  return TYPE_SAFE_MODELS.map((model) => ({ ...model, inputCapabilities: [...(model.inputCapabilities ?? [])] }));
}

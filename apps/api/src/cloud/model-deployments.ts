import type { ModelDeployment } from '@wangke/contracts/cloud';

/** Saved administration input only. No model request may supply a deployment URL. */
export function validateModelDeployments(value: ModelDeployment[] | undefined): ModelDeployment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500) throw new Error('invalid_model_deployments');
  const seen = new Set<string>();
  return value.map(d => {
    if (!d || typeof d.model !== 'string' || !d.model.trim() || d.model.length > 200 || /[\u0000-\u001f\u007f]/.test(d.model) || seen.has(d.model) || !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(d.protocol) || d.allowFallback !== undefined && typeof d.allowFallback !== 'boolean' || d.dataPolicy !== undefined && (typeof d.dataPolicy !== 'string' || !/^[\w.-]{1,100}$/.test(d.dataPolicy))) throw new Error('invalid_model_deployments');
    seen.add(d.model);
    let baseUrl: string | undefined;
    if (d.baseUrl !== undefined) {
      let url: URL; try { url = new URL(d.baseUrl); } catch { throw new Error('invalid_model_deployments'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_model_deployments');
      baseUrl = url.href.replace(/\/+$/, '');
    }
    return { model: d.model, protocol: d.protocol, ...(baseUrl ? { baseUrl } : {}), ...(d.dataPolicy !== undefined ? { dataPolicy: d.dataPolicy } : {}), ...(d.allowFallback !== undefined ? { allowFallback: d.allowFallback } : {}) };
  });
}

import { useState } from 'react';
import { Button } from '@heroui/react';
import { cloudRequest } from './state';

type Status = {
  disabledPurposes: string[];
  circuits: Array<{ providerId: string; model: string; state: string; retryInMs: number }>;
  recentRoutes: Array<{ action: string; createdAt: string; detail: { providerId?: string; model?: string; errorClass?: string; attempts?: Array<{ durationMs: number }> } }>;
  recentUsage: Array<{ requestId: string; provider: string; model: string; status: string; durationMs?: number; firstByteMs?: number | null; costSource: string; providerBilling?: { allowanceUsd?: number; chargedUsd?: number; listCostUsd?: number; source?: string; estimated?: boolean } }>;
};
/** Explicit refresh, no polling or duplicate upstream discovery/inference. */
export default function ModelGatewayStatus() {
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  async function refresh() {
    setBusy(true); setError(false);
    try { setStatus(await cloudRequest<Status>('/model-gateway/status')); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return <section className="flex min-w-0 flex-col gap-3" aria-label="Gateway 健康与用量">
    <div><h3 className="font-medium">Gateway 健康与用量</h3><Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void refresh()}>{busy ? '读取中' : '刷新路由与用量'}</Button></div>
    <p className="text-xs text-muted">仅显示本账号最近 50 条有界审计记录，不是账单或账户余额。首字节耗时不等于首个文本 Token（TTFT）。</p>
    {error && <p role="alert">Gateway 状态读取失败，请重试。</p>}
    {status && <>
      <p className="text-sm">已停用用途：{status.disabledPurposes.join('、') || '无'}；熔断记录：{status.circuits.length}</p>
      {status.circuits.map((c, i) => <p key={i} className="break-all text-xs">{c.providerId} / {c.model}：{c.state}，{c.retryInMs} ms 后可探测</p>)}
      <div className="max-h-64 overflow-auto"><ul className="flex flex-col gap-2 text-xs">{status.recentRoutes.map((r, i) => <li key={i} className="break-all">{r.action} · {r.detail.providerId ?? '—'}/{r.detail.model ?? '—'} · {r.detail.errorClass ?? '—'} · {r.detail.attempts?.reduce((n, a) => n + a.durationMs, 0) ?? '—'} ms</li>)}</ul></div>
      <div className="max-h-64 overflow-auto"><ul className="flex flex-col gap-2 text-xs">{status.recentUsage.map(r => <li key={r.requestId} className="break-all">{r.provider}/{r.model} · {r.status} · {r.durationMs ?? '—'} ms · 首字节 {r.firstByteMs ?? '未知'} ms · {r.costSource}
        {r.providerBilling && <div>本请求套餐占用 USD {r.providerBilling.allowanceUsd ?? '未知'}；上游报告扣费 USD {r.providerBilling.chargedUsd ?? '未知'}；标价 USD {r.providerBilling.listCostUsd ?? '未知'}；来源 {r.providerBilling.source ?? '未知'}{r.providerBilling.estimated ? '（估算）' : ''}</div>}
      </li>)}</ul></div>
    </>}
  </section>;
}

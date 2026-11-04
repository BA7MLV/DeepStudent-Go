import { useEffect, useState } from 'react';
import { cloud } from './state';
import { listLibraryFileMappings, mapLibraryFile } from './migrate';

export default function LibraryImportFiles() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listLibraryFileMappings>>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = cloud.userId;
  const refresh = async () => { const value = await listLibraryFileMappings(); if (owner === cloud.userId) setRows(value); };
  useEffect(() => { void refresh().catch(error => setError(String(error))); }, [owner]);
  return <section aria-label="旧库文件映射" className="flex flex-col gap-2">
    <button type="button" disabled={busy} onClick={() => void refresh().catch(error => setError(String(error)))}>核对导入文件</button>
    {rows.map(row => <label key={row.id} className="flex flex-col gap-1">
      <span>原资料 {row.id} → 新账户同 ID（仅新建）{row.mapped ? ` · ${row.mapped.size} bytes · SHA256 ${row.mapped.sha256}` : ' · 尚未选择字节'}</span>
      <pre className="max-h-24 overflow-auto">{JSON.stringify(row.reference)}</pre>
      <span>选择此引用对应的原始文件；确认后按 SHA256/大小 admission 上传，不使用原服务器路径或授权。</span>
      <input type="file" aria-label={`映射文件 ${row.id}`} disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0]; if (!file) return;
        setBusy(true); setError('');
        void mapLibraryFile(row.id, row.reference, file).then(refresh).catch(error => { if (owner === cloud.userId) setError(String(error)); }).finally(() => { if (owner === cloud.userId) setBusy(false); });
      }} />
    </label>)}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

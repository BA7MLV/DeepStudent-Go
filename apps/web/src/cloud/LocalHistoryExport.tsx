import { useEffect, useRef, useState } from 'react';
import { exportLocalHistoryDatabase, listLocalHistoryDatabases } from './local-history-export';

/** Lazy-mount from the account gate only after an explicit local-recovery click.
 * Never authenticates, selects a business DB or starts a server/static runtime. */
export default function LocalHistoryExport() {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lifetime = useRef(0);
  useEffect(() => {
    const generation = ++lifetime.current;
    void listLocalHistoryDatabases().then(value => {
      if (generation === lifetime.current) { setNames(value); setName(value[0] ?? ''); }
    }).catch(() => {
      if (generation === lifetime.current) setMessage('无法列出本机数据库，可输入原数据库名后完整导出。');
    });
    return () => { ++lifetime.current; };
  }, []);
  const save = async () => {
    const generation = lifetime.current;
    setBusy(true); setMessage('');
    try {
      const value = await exportLocalHistoryDatabase(name);
      if (generation !== lifetime.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${name}-history.json`; link.click(); URL.revokeObjectURL(url);
      setMessage('完整原稿已导出；本机和服务器数据均未改变。');
    } catch {
      if (generation === lifetime.current) setMessage('导出未完成；原库未改变。请核对数据库名和浏览器存储权限。');
    } finally { if (generation === lifetime.current) setBusy(false); }
  };
  return <section aria-label="本机历史原稿导出" data-testid="local-history-export">
    <p>只读导出此浏览器中的完整原库、命令日志和附件，不要求登录或服务器在线，不恢复旧协议或本地业务执行。请仅在自己的浏览器中操作，并妥善保管含私人资料的导出文件。</p>
    <label>本机数据库<input aria-label="本机数据库" data-testid="local-history-database" list="local-history-databases" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <datalist id="local-history-databases">{names.map(value => <option key={value} value={value} />)}</datalist>
    <button type="button" data-testid="local-history-export-download" disabled={busy || !name} onClick={() => void save()}>{busy ? '正在导出原稿…' : '完整导出本机原稿'}</button>
    {message ? <p role="status">{message}</p> : null}
  </section>;
}

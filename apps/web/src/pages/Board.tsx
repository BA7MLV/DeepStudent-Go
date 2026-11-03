import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { BoardPlugin } from '@wangke/contracts/board';
import { cloud } from '../cloud/state';
import { request } from '../api/serverClient';
import type { PluginCatalog } from '../plugins/catalog';
import { refreshPlugins } from '../plugins/catalog';
import { PageLoader, PageShell, Sym, toast } from '../ui';
import { PluginSlot } from '../plugins/PluginSlot';
import { BoardManager } from '../board/BoardManager';
import '../board/board.css';

export default function Board() {
  const { t } = useTranslation('common');
  const [plugins, setPlugins] = useState<BoardPlugin[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [managing, setManaging] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request<{ plugins: BoardPlugin[] }>('/board/plugins', { signal });
      if (signal?.aborted) return;
      setPlugins(previous => JSON.stringify(previous) === JSON.stringify(result.plugins) ? previous : result.plugins);
      setUnavailable(false);
    } catch { if (!signal?.aborted) setUnavailable(true); }
  }, []);
  useEffect(() => {
    if (!cloud.enabled) return;
    const controller = new AbortController();
    let pending = false;
    const update = async () => { if (pending || document.hidden) return; pending = true; try { await refresh(controller.signal); } finally { pending = false; } };
    void update();
    const timer = setInterval(() => void update(), 5000);
    window.addEventListener('system-files-changed', update);
    document.addEventListener('visibilitychange', update);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('system-files-changed', update); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);
  const toggle = async (plugin: BoardPlugin) => {
    if (busy || !plugin.manifest) return;
    setBusy(plugin.id);
    try {
      const { layout } = await request<PluginCatalog>('/plugins');
      await request(`/plugins/${encodeURIComponent(plugin.id)}/lifecycle`, { method: 'POST', body: JSON.stringify({ source: 'v1', status: plugin.manifest.enabled ? 'disabled' : 'enabled', expected: layout.content, revision: layout.revision }) });
      await refreshPlugins();
      await refresh();
    } catch { toast.error(t('board.saveFailed')); }
    finally { setBusy(undefined); }
  };
  const enabled = plugins?.filter(p => p.manifest?.enabled && !p.error) ?? [];
  return <PageShell title={t('board.title')} rootClassName="page-board" subtitle={plugins ? t('board.toolCount', { count: enabled.length }) : undefined} actions={
    <Button variant="ghost" className="board-customize" onPress={() => setManaging(true)} aria-label={t('board.manage')} aria-haspopup="dialog" aria-expanded={managing} data-testid="board-customize">
      <Sym name="tune" /><span>{t('board.customize')}</span>
    </Button>
  }>
    <div className="board" data-testid="board">
      {unavailable ? <p role="alert" className="text-sm text-danger">{t('board.unavailable')}</p> : null}
      {!cloud.enabled ? <PluginSlot name="board.main" /> : plugins === null ? unavailable ? <Button onPress={() => void refresh()}>{t('board.retry')}</Button> : <PageLoader label={t('board.loading')} /> : <>
        {plugins.some(p => p.error) ? <div className="board-notice" role="alert"><p>{t('board.invalidPlugins')}</p><Button size="sm" variant="ghost" onPress={() => setManaging(true)}>{t('board.view')}</Button></div> : null}
        <PluginSlot name="board.main" />
      </>}
    </div>
    <BoardManager open={managing} onOpenChange={setManaging} plugins={plugins} busy={busy} onToggle={toggle} />
  </PageShell>;
}

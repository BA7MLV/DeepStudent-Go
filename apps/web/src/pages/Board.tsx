import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { BoardPlugin } from '@wangke/contracts/board';
import { cloud } from '../cloud/state';
import { request } from '../api/serverClient';
import { readSystemDocument, saveSystemMarkdown, systemMaterialId } from '../materials/systemFiles';
import { PageLoader, PageShell, Sym, toast } from '../ui';
import { PluginFrame } from '../board/PluginFrame';
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
      const file = await readSystemDocument(`${plugin.path}/manifest.json`);
      const manifest = JSON.parse(file.content);
      await saveSystemMarkdown(systemMaterialId(file.path)!, JSON.stringify({ ...manifest, enabled: !plugin.manifest.enabled }, null, 2) + '\n', file.content, false, file.revision);
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
      {!cloud.enabled ? <p>{t('board.cloudOnly')}</p> : plugins === null ? unavailable ? <Button onPress={() => void refresh()}>{t('board.retry')}</Button> : <PageLoader label={t('board.loading')} /> : <>
        {plugins.some(p => p.error) ? <div className="board-notice" role="alert"><p>{t('board.invalidPlugins')}</p><Button size="sm" variant="ghost" onPress={() => setManaging(true)}>{t('board.view')}</Button></div> : null}
        {enabled.length ? <div className="board-grid">{enabled.map(plugin => <section key={plugin.id} className="board-widget ui-smooth" aria-labelledby={`board-title-${plugin.id}`} data-testid={`board-plugin-${plugin.id}`}>
          <h2 className="board-widget__title" id={`board-title-${plugin.id}`}>{plugin.manifest!.name}</h2>
          <PluginFrame key={`${plugin.id}:${plugin.revision}`} plugin={plugin} />
        </section>)}</div> : <div className="board-empty"><Sym name="grid_view" /><p>{t('board.empty')}</p><Button variant="secondary" onPress={() => setManaging(true)}>{t('board.manage')}</Button></div>}
      </>}
    </div>
    <BoardManager open={managing} onOpenChange={setManaging} plugins={plugins} busy={busy} onToggle={toggle} />
  </PageShell>;
}

import { Button, Drawer, Modal, Switch } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { BoardPlugin } from '@wangke/contracts/board';
import { Sym } from '../ui';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import { useIsMobile } from '../utils/useMobile';
import { useLibraryNavigation } from '../store/libraryNavigation';

interface Props {
  open: boolean;
  plugins: BoardPlugin[] | null;
  busy?: string;
  onOpenChange(open: boolean): void;
  onToggle(plugin: BoardPlugin): Promise<void>;
}

export function BoardManager({ open, plugins, busy, onOpenChange, onToggle }: Props) {
  const { t } = useTranslation('common');
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const close = () => onOpenChange(false);
  const content = <>
    <p className="board-manager__hint">{t('board.manageHint')}</p>
    {plugins === null ? <p role="status">{t('board.loading')}</p> : plugins.length ? <ul className="board-manager__plugins">
      {plugins.map(plugin => <li key={plugin.id} className="board-manager__plugin" data-testid={`board-manage-${plugin.id}`}>
        <div className="board-manager__copy">
          <div className="board-manager__name"><span>{plugin.manifest?.name ?? plugin.id}</span>
            <a className="board-manager__source" href={`#/library?file=${encodeURIComponent(`${plugin.path}/manifest.json`)}`} onClick={close} aria-label={t('board.openConfig', { name: plugin.manifest?.name ?? plugin.id })}><Sym name="code" /></a>
          </div>
          {plugin.error ? <p className="board-manager__error" role="alert">{plugin.error}</p> : plugin.manifest?.description ? <p>{plugin.manifest.description}</p> : null}
        </div>
        {plugin.manifest ? <Switch aria-label={plugin.manifest.name} isSelected={plugin.manifest.enabled} isDisabled={Boolean(busy)} onChange={() => void onToggle(plugin)} className="board-manager__switch">
          <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
        </Switch> : <Sym name="error" className="text-danger" />}
      </li>)}
    </ul> : <p className="board-manager__hint">{t('board.noPlugins')}</p>}
    <section className="board-manager__developer" aria-labelledby="board-developer-heading">
      <h3 id="board-developer-heading">{t('board.developer')}</h3>
      <div className="board-manager__resources">
        <a href="#/library" className="board-manager__resource" onClick={event => {
          event.preventDefault();
          useLibraryNavigation.getState().setFolderHistory(history => ({ entries: [...history.entries.slice(0, history.index + 1), 'system/board/template'], index: history.index + 1 }));
          close(); navigate('/library');
        }}><Sym name="extension" /><span><strong>{t('board.template')}</strong><small>{t('board.templateHint')}</small></span><Sym name="chevron_right" /></a>
        <a href="#/library?file=/system/board/README.md" className="board-manager__resource" onClick={close}><Sym name="description" /><span><strong>{t('board.docs')}</strong><small>{t('board.docsHint')}</small></span><Sym name="chevron_right" /></a>
      </div>
    </section>
  </>;
  if (mobile) return <Drawer.Root isOpen={open} onOpenChange={onOpenChange}>
    <Drawer.Backdrop className="board-manager__backdrop">
      <Drawer.Content placement="bottom" className="board-manager__sheet">
        <Drawer.Dialog className="board-manager board-manager--mobile ui-smooth" data-testid="board-manage">
          <Drawer.Handle />
          <Drawer.Header className="board-manager__header"><Drawer.Heading>{t('board.manage')}</Drawer.Heading><Drawer.CloseTrigger className="board-manager__close" aria-label={t('board.close')}><Sym name="close" /></Drawer.CloseTrigger></Drawer.Header>
          <Drawer.Body className="board-manager__body">{content}</Drawer.Body>
          <Drawer.Footer className="board-manager__footer"><Button variant="secondary" onPress={close}>{t('board.done')}</Button></Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  </Drawer.Root>;
  return <Modal.Root isOpen={open} onOpenChange={onOpenChange}>
    <Modal.Backdrop className="board-manager__backdrop"><Modal.Container placement="center" size="md" className={`${MODAL_CONTAINER_CLASS} transition-none`}>
      <Modal.Dialog className="board-manager ui-smooth" data-testid="board-manage">
        <Modal.Header className="board-manager__header"><Modal.Heading>{t('board.manage')}</Modal.Heading><Modal.CloseTrigger className="board-manager__close" aria-label={t('board.close')}><Sym name="close" /></Modal.CloseTrigger></Modal.Header>
        <Modal.Body className="board-manager__body">{content}</Modal.Body>
        <Modal.Footer className="board-manager__footer"><Button variant="secondary" onPress={close}>{t('board.done')}</Button></Modal.Footer>
      </Modal.Dialog>
    </Modal.Container></Modal.Backdrop>
  </Modal.Root>;
}

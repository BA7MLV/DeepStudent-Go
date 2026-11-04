import { useEffect, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ProjectDto } from '@wangke/contracts';
import { followResourceTrash, resourceCommand } from '../client/resources';
import { confirmDialog, MODAL_CONTAINER_CLASS, Sym } from '../ui';
import { projectError } from './errors';

export default function ResourceTrash({ onClose, onChange }: { onClose: () => void; onChange: () => void }) {
  const { t } = useTranslation('projects');
  const [items, setItems] = useState<(ProjectDto & { deletedAt: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    return followResourceTrash(result => { setItems(result.projects); setError(''); setLoading(false); }, error => { setError(projectError(error)); setLoading(false); });
  }, [revision]);
  const act = async (item: ProjectDto, action: 'restore' | 'delete') => {
    if (busy) return;
    if (action === 'delete' && !await confirmDialog({ headline: t('permanentDeleteConfirm', { name: item.name }), description: t('permanentDeleteHint'), confirmText: t('permanentDelete'), cancelText: t('cancel'), danger: true })) return;
    setBusy(true);
    try {
      await resourceCommand({ kind: action === 'delete' ? 'deleteTrash' : 'restore', projectId: item.id });
      setItems(old => old.filter(row => row.id !== item.id)); setError(''); onChange();
    } catch (error) { setError(projectError(error)); }
    finally { setBusy(false); }
  };
  return <Modal.Root isOpen onOpenChange={open => { if (!open && !busy) onClose(); }}><Modal.Backdrop><Modal.Container size="lg" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
    <Modal.Header><Modal.Heading>{t('trash')}</Modal.Heading></Modal.Header>
    <Modal.Body>
      <p className="text-sm text-muted">{t('trashHint')}</p>
      {error && <div role="alert" className="project-error">{error}<Button size="sm" onPress={() => setRevision(v => v + 1)}>{t('retry')}</Button></div>}
      {loading ? <p role="status">{t('working')}</p> : !items.length && !error ? <p className="project-empty">{t('trashEmpty')}</p> : items.map(item => <div key={item.id} className="flex items-center gap-3 border-b border-border py-3 last:border-b-0">
        <Sym name="folder" /><span className="min-w-0 flex-1 break-words">{item.name}<small className="block text-muted">{new Date(item.deletedAt).toLocaleDateString()}</small></span>
        <div className="flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void act(item, 'restore')}>{t('restore')}</Button>
          <Button size="sm" variant="danger-soft" isDisabled={busy} onPress={() => void act(item, 'delete')}>{t('permanentDelete')}</Button>
        </div>
      </div>)}
    </Modal.Body>
    <Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('closeTrash')}</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>;
}

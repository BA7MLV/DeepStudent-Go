import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Button, Drawer, Input, Label, Spinner, TextArea, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ProjectDto, ProjectFileDto } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { confirmDialog, promptDialog, Sym, toast } from '../ui';
import { formatSize } from '../utils/format';
import { useIsMobile } from '../utils/useMobile';
import { projectError } from './errors';
import { followResources } from '../client/resources';

export default function ProjectFiles({ project }: { project: ProjectDto }) {
  const { t } = useTranslation('projects');
  const [directory, setDirectory] = useState('');
  const [files, setFiles] = useState<ProjectFileDto[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ path: string; text: string; revision: string | null } | null>(null);
  const [editorBaseline, setEditorBaseline] = useState('');
  const [editorError, setEditorError] = useState('');
  const mobile = useIsMobile();
  const editorDirty = editor !== null && JSON.stringify({ path: editor.path, text: editor.text }) !== editorBaseline;
  const uploadInput = useRef<HTMLInputElement>(null);
  const join = (name: string) => directory ? `${directory}/${name}` : name;
  useEffect(() => {
    setLoading(true); setError(''); setFiles([]);
    return followResources(project.id, directory, result => { setFiles(result.entries); setLoading(false); setError(''); }, error => { setError(projectError(error)); setLoading(false); });
  }, [project.id, directory, refresh]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])]; event.target.value = '';
    if (!selected.length) return;
    setBusy(true);
    try { for (const file of selected) await serverClient.uploadProjectFile(project.id, join(file.name), file); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); setRefresh(v => v + 1); }
  };
  const mkdir = async () => {
    const name = await promptDialog({ headline: t('newFolder'), placeholder: t('filename'), confirmText: t('save'), cancelText: t('cancel') });
    if (!name) return;
    setBusy(true);
    try { await serverClient.projectDirectory(project.id, join(name)); setRefresh(v => v + 1); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const open = async (file: ProjectFileDto) => {
    if (file.kind === 'directory') { setDirectory(file.path); return; }
    setBusy(true); setEditorError('');
    try {
      const result = await serverClient.projectText(project.id, file.path);
      setEditor(result);
      setEditorBaseline(JSON.stringify({ path: result.path, text: result.text }));
    } catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const closeEditor = async () => {
    if (busy) return;
    if (editorDirty && !await confirmDialog({
      headline: '放弃未保存的修改？',
      description: '关闭后本次编辑不会写入文件。',
      confirmText: '放弃修改', danger: true,
    })) return;
    setEditor(null); setEditorError('');
  };
  const remove = async (file: ProjectFileDto) => {
    if (!await confirmDialog({ headline: t('deleteConfirm', { name: file.name }), confirmText: t('delete'), cancelText: t('cancel'), danger: true })) return;
    setBusy(true);
    try { await serverClient.deleteProjectFile(project.id, file.path, file.revision); setRefresh(v => v + 1); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!editor) return;
    setBusy(true); setEditorError('');
    try { await serverClient.writeProjectText(project.id, editor.revision === null ? join(editor.path) : editor.path, editor.text, editor.revision); setEditor(null); setRefresh(v => v + 1); }
    catch (error) { setEditorError(projectError(error)); }
    finally { setBusy(false); }
  };
  const breadcrumbs = directory ? directory.split('/') : [];
  return <section className="project-files" aria-label={t('files')}>
    <div className="project-controls">
      <Button size="sm" variant="secondary" isDisabled={busy || project.archived} onPress={() => uploadInput.current?.click()}><Sym name="upload" />{t('upload')}</Button>
      <Button size="sm" variant="tertiary" isDisabled={busy || project.archived} onPress={() => void mkdir()}><Sym name="create_new_folder" />{t('newFolder')}</Button>
      <Button size="sm" variant="tertiary" isDisabled={busy || project.archived} onPress={() => { setEditorError(''); setEditorBaseline(JSON.stringify({ path: '', text: '' })); setEditor({ path: '', text: '', revision: null }); }}><Sym name="edit" />{t('newFile')}</Button>
      <Button size="sm" variant="ghost" isDisabled={busy || loading} onPress={() => setRefresh(v => v + 1)}><Sym name="refresh" />{t('refresh')}</Button>
      {busy && <Spinner size="sm" />}
      <input ref={uploadInput} type="file" multiple hidden onChange={upload} />
    </div>
    <nav className="project-breadcrumbs" aria-label={t('workspace')}>
      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setDirectory('')}>{project.name}</Button>
      {breadcrumbs.map((part, i) => <span key={i}><Sym name="chevron_right" /><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setDirectory(breadcrumbs.slice(0, i + 1).join('/'))}>{part}</Button></span>)}
    </nav>
    {error ? <div className="project-error" role="alert">{error}<Button size="sm" onPress={() => setRefresh(v => v + 1)}>{t('retry')}</Button></div>
      : loading ? <div className="project-empty"><Spinner /></div>
      : files.length === 0 ? <p className="project-empty">{t('folderEmpty')}</p>
      : <ul className="project-file-list">{files.map(file => <li key={file.path}>
        <button className="project-file-open" disabled={busy} onClick={() => void open(file)} aria-label={file.kind === 'directory' ? file.name : `${t('edit')} · ${file.name}`}>
          <Sym name={file.kind === 'directory' ? 'folder' : 'description'} /><span>{file.name}<small>{file.kind === 'file' ? formatSize(file.size) : ''}</small></span>
        </button>
        {file.kind === 'file' && <a className="project-download" href={serverClient.projectDownloadUrl(project.id, file.path)} download aria-label={`${t('download')} · ${file.name}`}><Sym name="download" /></a>}
        <Button isIconOnly size="sm" variant="ghost" aria-label={`${t('delete')} · ${file.name}`} isDisabled={busy || project.archived} onPress={() => void remove(file)}><Sym name="delete" /></Button>
      </li>)}</ul>}
    {editor && <Drawer.Root isOpen onOpenChange={open => { if (!open) void closeEditor(); }}>
      <Drawer.Backdrop variant="opaque">
        <Drawer.Content placement={mobile ? 'bottom' : 'right'} className={mobile ? 'max-h-[88vh]' : 'w-[min(36rem,100vw)]'}>
          <Drawer.Dialog className="project-editor" data-testid="project-file-editor">
            <Drawer.Header><Drawer.Heading>{editor.revision === null ? t('newFile') : editor.path}</Drawer.Heading><Drawer.CloseTrigger aria-label={t('cancel')} /></Drawer.Header>
            <Drawer.Body><div className="project-form">
              {editor.revision === null && <TextField isRequired><Label>{t('filename')}</Label><Input value={editor.path} onChange={e => setEditor({ ...editor, path: e.target.value })} placeholder="notes.md" /></TextField>}
              <TextField><Label>{t('content')}</Label><TextArea className="project-text-editor" value={editor.text} readOnly={project.archived} rows={15} onChange={e => setEditor({ ...editor, text: e.target.value })} /></TextField>
              {editorError && <p className="project-error" role="alert">{editorError}</p>}
            </div></Drawer.Body>
            <Drawer.Footer><Button variant="tertiary" isDisabled={busy} onPress={() => { setEditor(null); setEditorError(''); }}>{t('cancel')}</Button><Button variant="primary" isDisabled={busy || project.archived || !editor.path.trim()} onPress={() => void save()}>{t('save')}</Button></Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>}
  </section>;
}

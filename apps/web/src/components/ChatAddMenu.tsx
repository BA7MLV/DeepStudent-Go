import { useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, Input, Label, Modal, Switch } from '@heroui/react';
import { useNavigate } from 'react-router-dom';
import { db } from '../store/db';
import { useCourseChat } from '../store/courseChat';
import { useChatAttachments } from '../store/chatAttachments';
import { CHAT_FILE_ACCEPT, CHAT_IMAGE_ACCEPT } from '../chat/attachments';
import { MAX_COURSE_CONTEXT } from '../harness/courseContext';
import { folderCourseScope } from '@wangke/study-core/folder-scope';
import { projectDisplayName } from '../projects/chatProjects';
import { MODAL_CONTAINER_CLASS, Sym } from '../ui';
import SkillPicker from './SkillPicker';
import TaskModelPicker from './TaskModelPicker';
import './chat-attachments.css';
import { useTranslation } from 'react-i18next';

export default function ChatAddMenu({ disabled, onSelectProject, onSkillInsert }: { disabled?: boolean; onSelectProject?: () => void; onSkillInsert?: () => void }) {
  const { t } = useTranslation('settings');
  const { t: tp } = useTranslation('projects');
  const { t: text } = useTranslation('interface');
  const navigate = useNavigate();
  const imageInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [coursesOpen, setCoursesOpen] = useState(false);
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const skillIds = useCourseChat((state) => state.skillIds);
  const setSkillIds = useCourseChat((state) => state.setSkillIds);
  const turnSkillIds = useCourseChat(state => state.turnSkillIds);
  const setTurnSkillIds = useCourseChat(state => state.setTurnSkillIds);
  const mcpServerIds = useCourseChat((state) => state.mcpServerIds);
  const setMcpServerIds = useCourseChat((state) => state.setMcpServerIds);
  const loading = useCourseChat((state) => state.loading);
  const sessionId = useCourseChat(state => state.activeId);
  const contextCourses = useCourseChat((state) => state.contextCourses);
  const courseReferenceEnabled = useCourseChat((state) => state.courseReferenceEnabled);
  const webSearchEnabled = useCourseChat((state) => state.webSearchEnabled);
  const setCourseReferenceEnabled = useCourseChat((state) => state.setCourseReferenceEnabled);
  const setWebSearchEnabled = useCourseChat((state) => state.setWebSearchEnabled);
  const project = useCourseChat((state) => state.project);
  const projectLabel = project ? `${tp('selectProject')} · ${projectDisplayName(project.name)}` : tp('selectProject');
  const contextLabel = contextCourses.length ? text('chatAdd.referenceCount', { count: contextCourses.length }) : text('chatAdd.references');
  const addFiles = useChatAttachments((state) => state.add);
  const openCourses = async () => {
    setError(''); setBusy(true); setQuery(''); setCoursesOpen(true);
    setSelected(useCourseChat.getState().contextCourses.map((course) => course.id));
    try {
      const { cloud } = await import('../cloud/state');
      const database = db, owner = cloud.userId;
      const { loadCollection } = await import('../client/collections');
      const [rows, folders] = cloud.enabled ? await Promise.all([loadCollection<import('../store/db').VideoRow>('videos', undefined), loadCollection<import('../store/db').FolderRow>('folders', undefined)])
        : await Promise.all([database.videos.orderBy('createdAt').reverse().toArray(), database.folders.toArray()]);
      if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
      const scope = folderCourseScope(folders, rows, project?.folderId);
      setCourses(rows.filter(row => !scope || scope.has(row.id)).map(({ id, name }) => ({ id, name })));
    }
    catch { setError(text('chatAdd.readFailed')); }
    finally { setBusy(false); }
  };
  const saveCourses = async () => {
    setBusy(true); setError('');
    try { await useCourseChat.getState().setCourseContext(selected); setCoursesOpen(false); }
    catch { setError(text('chatAdd.saveFailed')); }
    finally { setBusy(false); }
  };
  return <>
    <div className="chat-add-menu">
      <Dropdown isOpen={addOpen} onOpenChange={setAddOpen}>
        <Button ref={addButton} className="chat-add-menu__trigger" isIconOnly size="sm" variant="tertiary" aria-label={`${text('chatAdd.title')}${contextCourses.length ? ` · ${contextLabel}` : ''}`} data-testid="chat-add" isDisabled={disabled}>
          <Sym name="add" />
          {contextCourses.length > 0 && <span className="chat-add-menu__context-dot" data-testid="chat-context-dot" aria-hidden="true" />}
        </Button>
        <Dropdown.Popover placement="top start">
          <Dropdown.Menu aria-label={text('composer.add')} disabledKeys={loading ? ['project'] : []} onAction={(key) => {
            if (key === 'courses') void openCourses();
            else if (key === 'images') imageInput.current?.click();
            else if (key === 'files') fileInput.current?.click();
            else if (key === 'skills') setSkillsOpen(true);
            else if (key === 'project') { setAddOpen(false); onSelectProject?.(); }
          }}>
            {onSelectProject && <Dropdown.Item id="project" textValue={projectLabel} data-testid="chat-select-project"><Sym name="folder" /><Label>{projectLabel}</Label></Dropdown.Item>}
            <Dropdown.Item id="courses" textValue={contextLabel} data-testid="course-chat-context">
              <Sym name="school" />
              <Label>{contextLabel}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="images" textValue={text('composer.images')}><Sym name="image" />{text('composer.images')}</Dropdown.Item>
            <Dropdown.Item id="files" textValue={text('composer.files')}><Sym name="attach_file" />{text('composer.files')}</Dropdown.Item>
            <Dropdown.Item id="skills" textValue={t('skillPicker.title')}><Sym name="extension" />{t('skillPicker.title')}{skillIds !== undefined || mcpServerIds !== undefined ? ` · ${text('chatAdd.limited')}` : ''}</Dropdown.Item>
          </Dropdown.Menu>
          <div className="chat-add-menu__model px-2 py-1">
            <TaskModelPicker sessionId={sessionId} onClose={() => setAddOpen(false)} />
          </div>
          <div className="chat-add-menu__switches px-2 py-1">
            <Switch isSelected={courseReferenceEnabled} onChange={(enabled) => setCourseReferenceEnabled(Boolean(enabled))} data-testid="chat-course-reference-switch">
              <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><span>{text('chatAdd.courseReference')}</span></Switch.Content>
            </Switch>
            <Switch isSelected={webSearchEnabled} onChange={(enabled) => setWebSearchEnabled(Boolean(enabled))} data-testid="chat-web-search-switch">
              <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><span>{text('chatAdd.webSearch')}</span></Switch.Content>
            </Switch>
          </div>
        </Dropdown.Popover>
      </Dropdown>
      <input ref={imageInput} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden data-testid="chat-image-input" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <input ref={fileInput} type="file" accept={CHAT_FILE_ACCEPT} multiple hidden data-testid="chat-file-input" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    </div>
    <SkillPicker onInserted={onSkillInsert} anchorRef={addButton} value={skillIds} onChange={setSkillIds} turnValue={turnSkillIds} onTurnChange={setTurnSkillIds} disabled={loading} mcpValue={mcpServerIds} onMcpChange={setMcpServerIds} isOpen={skillsOpen} onOpenChange={setSkillsOpen} hideTrigger />
    <Modal.Root isOpen={coursesOpen} onOpenChange={setCoursesOpen}>
      <Modal.Backdrop><Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
        <Modal.Dialog data-testid="chat-course-picker">
          <Modal.Header><Modal.Heading>{text('chatAdd.references')}</Modal.Heading></Modal.Header>
          <Modal.Body>
            <Input aria-label={text('chatAdd.search')} placeholder={text('chatAdd.search')} value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="chat-course-picker__selection">
              <span aria-label={text('chatAdd.selected', { count: selected.length, max: MAX_COURSE_CONTEXT })}>{selected.length} / {MAX_COURSE_CONTEXT}</span>
              <Button size="sm" variant="tertiary" data-testid="chat-context-reset" isDisabled={busy || loading || selected.length === 0} onPress={() => setSelected([])}>{text(selected.length ? 'chatAdd.reset' : 'chatAdd.auto')}</Button>
            </div>
            {loading && <p className="text-sm text-muted">{text('chatAdd.wait')}</p>}
            <div className="chat-course-picker__list" aria-busy={busy}>
              {busy ? <p role="status">{text('chatAdd.loading')}</p> : courses.length === 0 ? <>
                <p>{text('chatAdd.empty')}</p><Button variant="secondary" onPress={() => { setCoursesOpen(false); navigate('/library'); }}>{text('chatAdd.import')}</Button>
              </> : courses.filter((course) => course.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((course) => (
                <Checkbox key={course.id} isSelected={selected.includes(course.id)} isDisabled={loading || (!selected.includes(course.id) && selected.length >= MAX_COURSE_CONTEXT)}
                  onChange={(checked) => setSelected((current) => checked ? [...current, course.id] : current.filter((id) => id !== course.id))}>
                  <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span>{course.name}</span></Checkbox.Content>
                </Checkbox>
              ))}
              {!busy && courses.length > 0 && !courses.some((course) => course.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p>{text('chatAdd.noMatches')}</p>}
            </div>
            {error && <p role="alert" className="chat-attachments__error">{error}</p>}
          </Modal.Body>
          <Modal.Footer>
            {courses.length > 0 && <Button variant="tertiary" onPress={() => { setCoursesOpen(false); navigate('/library'); }}>{text('chatAdd.importNew')}</Button>}
            <Button variant="tertiary" onPress={() => setCoursesOpen(false)}>{text('chatAdd.cancel')}</Button>
            <Button variant="primary" isDisabled={busy || loading} onPress={() => void saveCourses()}>{text('chatAdd.save')}</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container></Modal.Backdrop>
    </Modal.Root>
  </>;
}

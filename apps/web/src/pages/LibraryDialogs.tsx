/**
 * 资料库的四个小弹窗：重命名标题 / 新建或重命名文件夹 / 移动到文件夹 / 资料简介。
 *
 * 它们的共同点是「一个表单 + 确定/取消」，与列表状态无关；放在这里是为了让
 * 资料库主组件只保留「哪个弹窗开着」这一行状态，而不必把这些表单的输入框、
 * 单选组、回车提交再铺一遍。
 *
 * 草稿放在各弹窗自己的 state 里，并随「打开的是哪一条」重置：目标变化时直接退回初值
 * 渲染（不必等一次 effect 再闪回旧值），effect 只负责把 state 也同步过去 —— 否则
 * 「点确定」读到的还是上一条记录的名字。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, ListBox, Modal, Select, TextField } from '@heroui/react';
import { MODAL_CONTAINER_CLASS } from '../ui';
import type { FolderRow, VideoRow } from '../store/db';

/** 草稿：目标变化时重置为初值（渲染里直接判同，effect 负责同步 state） */
function useDraft(draftKey: string | null, initial: string): [string, (value: string) => void] {
  const [state, setState] = useState({ key: draftKey, value: initial });
  const set = (value: string) => setState({ key: draftKey, value });
  useEffect(() => { setState({ key: draftKey, value: initial }); }, [draftKey]);
  return [state.key === draftKey ? state.value : initial, set];
}

/** 重命名视频标题 */
export function RenameDialog({
  video,
  onClose,
  onConfirm,
}: {
  video: VideoRow | null;
  onClose: () => void;
  onConfirm: (name: string) => Promise<void> | void;
}) {
  const { t: tr } = useTranslation('projects');
  const [text, setText] = useDraft(video?.id ?? null, video?.name ?? '');
  return (
    <Modal.Root isOpen={!!video} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog data-testid="rename-dialog">
            <Modal.Header>
              <Modal.Heading>修改标题</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {/* data-testid 挂 TextField 包装层：e2e 用 `[data-testid="rename-input"] input` 定位控件 */}
              <TextField data-testid="rename-input" fullWidth>
                <Input
                  value={text}
                  maxLength={100}
                  placeholder={tr('library.aria.renameTitlePlaceholder')}
                  aria-label={tr('library.aria.videoTitle')}
                  autoFocus
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onConfirm(text);
                  }}
                />
              </TextField>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" data-testid="rename-cancel" onPress={onClose}>
                {tr('cancel')}
              </Button>
              <Button variant="primary" data-testid="rename-save" onPress={() => void onConfirm(text)}>
                {tr('save')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}

/** 新建文件夹 / 重命名文件夹 */
export function FolderDialog({
  mode,
  folder,
  onClose,
  onConfirm,
}: {
  mode: 'create' | 'rename' | null;
  folder: FolderRow | null;
  onClose: () => void;
  onConfirm: (name: string) => Promise<void> | void;
}) {
  const { t: tr } = useTranslation('projects');
  const [text, setText] = useDraft(mode ? `${mode}:${folder?.id ?? 'new'}` : null, mode === 'rename' ? folder?.name ?? '' : '');
  return (
    <Modal.Root isOpen={mode != null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog data-testid="folder-dialog">
            <Modal.Header>
              <Modal.Heading>
                {mode === 'rename' ? tr('library.chrome.folderModalRename') : tr('library.chrome.folderModalCreate')}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <TextField data-testid="folder-input" fullWidth>
                <Input
                  value={text}
                  maxLength={50}
                  placeholder={tr('library.aria.folderNamePlaceholder')}
                  aria-label={tr('library.aria.folderName')}
                  autoFocus
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onConfirm(text);
                  }}
                />
              </TextField>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" data-testid="folder-cancel" onPress={onClose}>
                {tr('cancel')}
              </Button>
              <Button variant="primary" data-testid="folder-save" onPress={() => void onConfirm(text)}>
                {tr('save')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}

/** 移动到文件夹：选目标（含「未分类」）或当场新建一个 */
export function MoveDialog({
  video,
  folders,
  onClose,
  onConfirm,
  onCreateFolder,
}: {
  video: VideoRow | null;
  folders: FolderRow[];
  onClose: () => void;
  onConfirm: (folderId: number | null) => Promise<void> | void;
  /** 新建文件夹后返回它的 id，弹窗会把它选中 */
  onCreateFolder: (name: string) => Promise<number>;
}) {
  const { t: tr } = useTranslation('projects');
  const [target, setTarget] = useDraft(video?.id ?? null, String(video?.folderId ?? -1));
  const [newName, setNewName] = useDraft(video?.id ?? null, '');
  const create = (name: string) => {
    if (!name.trim()) return;
    void onCreateFolder(name.trim()).then((id) => {
      setNewName('');
      setTarget(String(id));
    });
  };
  return (
    <Modal.Root isOpen={!!video} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog data-testid="move-dialog">
            <Modal.Header>
              <Modal.Heading>{video ? tr('library.chrome.moveTitle', { name: video.name }) : ''}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {/* 文件夹是用户自己建的、数量会增长 —— 用 Select 而不是铺开的单选组,长名单不会把弹窗顶破。(PR35 值型控件规则) */}
              <Select
                className="w-56 max-w-full"
                selectedKey={target}
                onSelectionChange={(key) => { if (key != null) setTarget(String(key)); }}
                data-testid="move-target-select"
                aria-label={tr('library.aria.moveTarget')}
              >
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="-1" textValue={tr('library.t.uncategorized')}>{tr('library.t.uncategorized')}<ListBox.ItemIndicator /></ListBox.Item>
                    {folders.map((f) => (
                      <ListBox.Item key={f.id} id={String(f.id)} textValue={f.name}>{f.name}<ListBox.ItemIndicator /></ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <div className="row row--nowrap" style={{ marginTop: 16 }}>
                <TextField data-testid="move-new-name" fullWidth>
                  <Input
                    value={newName}
                    maxLength={50}
                    placeholder={tr('library.aria.newFolderName')}
                    aria-label={tr('library.aria.newFolderName')}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') create(newName);
                    }}
                  />
                </TextField>
                <Button
                  data-testid="move-create-folder"
                  variant="secondary"
                  isDisabled={!newName.trim()}
                  onPress={() => create(newName)}
                >
                  {tr('library.chrome.moveCreateFolder')}
                </Button>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" data-testid="move-cancel" onPress={onClose}>
                {tr('cancel')}
              </Button>
              <Button
                variant="primary"
                data-testid="move-confirm"
                onPress={() => {
                  const id = Number(target);
                  void onConfirm(id < 0 ? null : id);
                }}
              >
                移动
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}

/** 资料简介：复用列表卡片本身，内容与列表一致 */
export function DetailsDialog({
  video,
  onClose,
  children,
}: {
  video: VideoRow | null;
  onClose: () => void;
  /** 单张卡片（由父组件用 VideoRow 渲染，回显最新数据） */
  children: React.ReactNode;
}) {
  return (
    <Modal.Root isOpen={!!video} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Backdrop><Modal.Container placement="center" size="sm" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
        <Modal.Header><Modal.Heading>资料简介</Modal.Heading><Modal.CloseTrigger /></Modal.Header>
        <Modal.Body>{video ? children : null}</Modal.Body>
      </Modal.Dialog></Modal.Container></Modal.Backdrop>
    </Modal.Root>
  );
}

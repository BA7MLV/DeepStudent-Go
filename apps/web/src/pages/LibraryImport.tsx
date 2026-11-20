/**
 * 导入资料弹窗 + 导入任务进度列表。
 *
 * 拆出来的原因：投放区里有格式说明、系统选择器细节与两条导入入口，
 * 加上任务行的进度/错误态，占了资料库页面近两百行，与列表逻辑无关。
 * 这里只做展示与收集用户选择，真正的写入由父组件通过 `onPick` / `onOpenBili` 接手。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Modal, ProgressBar } from '@heroui/react';
import { HelpTip, MODAL_CONTAINER_CLASS, Sym } from '../ui/index';

/** 导入任务行的状态；父组件按 key 更新 */
export interface ImportTask {
  key: string;
  name: string;
  status: 'queued' | 'probing' | 'writing' | 'done' | 'error';
  percent: number; // 0-100，仅 writing 阶段有意义
  error?: string;
}

type TaskStatusKey = 'library.task.queued' | 'library.task.probing' | 'library.task.writing' | 'library.task.done' | 'library.task.error';
const TASK_STATUS_TEXT: Record<ImportTask['status'], TaskStatusKey> = {
  queued: 'library.task.queued',
  probing: 'library.task.probing',
  writing: 'library.task.writing',
  done: 'library.task.done',
  error: 'library.task.error',
};

/**
 * 导入入口弹窗：拖放区 + 「导入文件」/「从 B 站导入」。
 * 文件选择本身用页面上的隐藏 input（iOS 要求在用户手势里同步 click），
 * 这里只负责把点击转给 `onPickFile`。
 */
export function ImportDialog({
  open,
  onOpenChange,
  dropActive,
  onDropActiveChange,
  onDropFiles,
  onPickFile,
  onOpenBili,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dropActive: boolean;
  onDropActiveChange: (active: boolean) => void;
  onDropFiles: (files: File[]) => void;
  onPickFile: () => void;
  onOpenBili: () => void;
}) {
  const { t: tr } = useTranslation('projects');
  return (
    <Modal.Root isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Backdrop><Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
        <Modal.Header><Modal.Heading>导入资料</Modal.Heading><Modal.CloseTrigger /></Modal.Header>
        <Modal.Body>
          <Card.Root
            className={`drop-zone relative mt-3 flex cursor-pointer flex-row items-center gap-4 border border-dashed border-border bg-surface-secondary p-4 text-left transition-colors hover:bg-surface-tertiary max-[640px]:flex-col max-[640px]:items-center max-[640px]:gap-3 max-[640px]:p-4 max-[640px]:text-center ${dropActive ? 'border-accent bg-accent-soft' : ''}`}
            data-testid="drop-zone"
            onClick={onPickFile}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dropActive) onDropActiveChange(true);
            }}
            onDragLeave={(e) => {
              // 在子元素之间移动也会触发 dragleave，只有真正离开整块区域才取消高亮
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDropActiveChange(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDropActiveChange(false);
              onDropFiles(Array.from(e.dataTransfer?.files ?? []));
            }}
          >
            <Sym name="cloud_upload" className="drop-zone__icon shrink-0 text-[28px] text-accent max-[640px]:text-[32px]" />
            <div className="drop-zone__copy min-w-0 flex-1 max-[640px]:w-full">
              <div className="drop-zone__title text-sm font-medium text-foreground">导入课程与资料</div>
              {/* 格式与存储位置留在正文；系统选择器和空间管理细节收进说明。 */}
              <div className="drop-zone__hint mt-0.5 flex items-center gap-1 text-xs leading-relaxed text-muted max-[640px]:justify-center">
                <span>拖入视频、PDF、Word、Markdown、HTML，保存到服务端真实文件夹</span>
                {/* HelpTip 内部已经 stopPropagation —— 这里整块是可点击的投放区，
                    不拦住会顺手弹出文件选择器。 */}
                <HelpTip headline={tr('library.chrome.importHelp')} label={tr('library.chrome.importHelp')} testId="import-help">
                  <p>
                    请从「文件」App 中选择视频。从「相册」选择时系统会先转码，大视频可能长时间没有进度；
                    存在 iCloud 里的文件，请先在「文件」App 中下载到本机。
                  </p>
                  <p>
                    文件上传到当前资源文件夹，界面与获授权的 Bot 使用同一份文件。
                  </p>
                </HelpTip>
              </div>
            </div>
            <div className="drop-zone__actions flex shrink-0 flex-wrap justify-center gap-2 max-[640px]:w-full [&>[data-slot=button]]:max-[640px]:flex-1">
              {/* onClick 保留：投放区整块可点，按钮要拦住冒泡才不会顺手弹出文件选择器
                  （RAC 的 usePress 会把 onClick 接到真实 click 上，stopPropagation 有效）。 */}
              <Button
                data-testid="btn-native-pick"
                variant="primary"
                onPress={onPickFile}
                onClick={(e) => e.stopPropagation()}
              >
                <Sym name="upload" />
                导入文件
              </Button>
              <Button
                data-testid="btn-bili-import"
                variant="secondary"
                onPress={onOpenBili}
                onClick={(e) => e.stopPropagation()}
              >
                <Sym name="link" />
                从 B 站导入
              </Button>
            </div>
          </Card.Root>
        </Modal.Body>
      </Modal.Dialog></Modal.Container></Modal.Backdrop>
    </Modal.Root>
  );
}

/** 导入任务进度：每个文件一行，算不出百分比时走不确定态 */
export function ImportTaskList({
  tasks,
  onDismiss,
}: {
  tasks: ImportTask[];
  onDismiss: (key: string) => void;
}) {
  const { t: tr } = useTranslation('projects');
  if (tasks.length === 0) return null;
  return (
    <Card.Root variant="secondary" className="import-tasks mt-3 flex flex-col gap-2 p-3" data-testid="import-tasks">
      {tasks.map((t) => (
        <div key={t.key} className="import-task flex min-w-0 flex-col gap-1" data-testid="import-task">
          <div className="import-task__head flex min-w-0 items-center gap-2">
            <span className="import-task-name min-w-0 flex-1 truncate text-[13px] text-foreground" title={t.name}>
              {t.name}
            </span>
            <span
              className={
                t.status === 'error'
                  ? 'import-task__status max-w-[42%] truncate text-xs text-danger'
                  : 'import-task__status max-w-[42%] truncate text-xs tabular-nums text-muted'
              }
              data-testid="import-task-status"
              title={t.status === 'error' ? t.error : undefined}
            >
              {t.status === 'error'
                ? (t.error ?? tr('library.t.taskFailed'))
                : t.status === 'writing'
                  ? `${t.percent}%`
                  : tr(TASK_STATUS_TEXT[t.status])}
            </span>
            {t.status === 'error' && (
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                data-testid="btn-dismiss-import-error"
                aria-label={tr('library.aria.dismissError')}
                onPress={() => onDismiss(t.key)}
              >
                <Sym name="close" />
              </Button>
            )}
          </div>
          {t.status !== 'done' && t.status !== 'error' && (
            // 不确定态用显式的 isIndeterminate 表达（value 有值时按百分比走，没有就转圈）。
            <ProgressBar
              data-testid="import-progress"
              maxValue={100}
              value={t.status === 'writing' ? t.percent : 0}
              isIndeterminate={t.status !== 'writing'}
              aria-label={tr('library.aria.importProgress')}
            />
          )}
        </div>
      ))}
    </Card.Root>
  );
}

/** 首屏骨架复用访达网格尺寸；工具栏与路径栏在加载期间保留。 */
export function LibrarySkeleton({ count }: { count: number }) {
  return (
    <div className="finder-items finder-items--icons" data-testid="library-skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <div className="finder-item" key={index}>
        <span className="finder-item__icon"><SkeletonBlock className="h-20 w-24" /></span>
        <SkeletonBlock className="h-4 w-20" />
        <SkeletonBlock className="mt-1 h-3 w-12" />
      </div>)}
    </div>
  );
}

/** 骨架里的灰块：与真内容同级元素等尺寸（能靠父级继承的绝不手写像素） */
function SkeletonBlock({ className }: { className: string }): ReactNode {
  return <span className={`skel-breathe block rounded-md bg-background-tertiary ${className}`} />;
}

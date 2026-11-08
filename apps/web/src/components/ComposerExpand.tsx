import { useLayoutEffect, useState, type ClipboardEventHandler, type RefObject, type ReactNode } from 'react';
import { Button, Drawer, Modal, TextArea } from '@heroui/react';
import { Sym } from '../ui';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import SheetChrome from '../ui/SheetChrome';
import { useMediaQuery } from '../utils/useMobile';
import './composer-expand.css';

/** Measure wrapping as well as edits: side panels and the software keyboard resize independently. */
export function useComposerSize(ref: RefObject<HTMLTextAreaElement | null>, value: string, active = true) {
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input || !active) return;
    const measure = () => {
      input.style.height = '0px';
      const style = getComputedStyle(input);
      const limit = parseFloat(style.maxHeight);
      // A wrapping placeholder must not grow an empty composer on narrow screens.
      const height = input.value ? input.scrollHeight : Math.ceil(parseFloat(style.minHeight));
      input.style.height = `${Math.min(height, limit)}px`;
      setOverflow(height > limit + 1);
    };
    measure();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      measure();
    });
    observer.observe(input);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [ref, value, active]);
  return overflow;
}

export default function ComposerExpand({ value, onChange, onPaste, visible, renderInput }: { value: string; onChange: (value: string) => void; onPaste?: ClipboardEventHandler<HTMLTextAreaElement>; visible: boolean; renderInput?: (className: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const mobile = useMediaQuery('(max-width: 760px)');
  const trigger = <Button className="composer-expand" hidden={!visible && !open} isIconOnly size="sm" variant="tertiary" aria-label="展开输入框" aria-haspopup="dialog" aria-expanded={open} data-testid="composer-expand">
      <Sym name="open_in_full" />
    </Button>;

  // This is another view of the live draft, not a separate save/cancel transaction.
  if (!mobile) return <Modal.Root isOpen={open} onOpenChange={setOpen}>
    {trigger}
    <Modal.Backdrop variant="opaque" className="composer-dialog__backdrop">
      <Modal.Container placement="center" className={MODAL_CONTAINER_CLASS}>
        <Modal.Dialog className="composer-dialog ui-smooth" data-testid="composer-sheet">
          <Modal.Header className="composer-dialog__header">
            <Modal.Heading>编辑完整消息</Modal.Heading>
            <Modal.CloseTrigger aria-label="收起输入框"><Sym name="close" /></Modal.CloseTrigger>
          </Modal.Header>
          <Modal.Body className="composer-dialog__body">
            {renderInput ? renderInput('composer-dialog__input') : <TextArea autoFocus aria-label="完整消息" value={value} onChange={(event) => onChange(event.target.value)} onPaste={onPaste}
              className="composer-dialog__input" />}
          </Modal.Body>
          <Modal.Footer className="composer-dialog__footer">
            <span className="composer-dialog__hint">更改会同步到输入框，不会发送消息</span>
            <Button slot="close" variant="primary">完成</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </Modal.Root>;

  return <Drawer.Root isOpen={open} onOpenChange={setOpen}>
    {trigger}
    <Drawer.Backdrop variant="opaque" className="composer-sheet__backdrop">
      <Drawer.Content placement="bottom" className="composer-sheet__content">
        <Drawer.Dialog className="composer-sheet" data-testid="composer-sheet">
          <SheetChrome>
            <Drawer.Handle />
            <Drawer.Header className="composer-sheet__header">
              <Drawer.Heading>编辑完整消息</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="收起输入框"><Sym name="fullscreen_exit" /></Drawer.CloseTrigger>
            </Drawer.Header>
          </SheetChrome>
          <Drawer.Body className="composer-sheet__body">
            {renderInput ? renderInput('composer-sheet__input') : <TextArea autoFocus aria-label="完整消息" value={value} onChange={(event) => onChange(event.target.value)} onPaste={onPaste}
              className="composer-sheet__input" />}
          </Drawer.Body>
          <Drawer.Footer className="composer-sheet__footer"><Button slot="close">完成</Button></Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  </Drawer.Root>;
}

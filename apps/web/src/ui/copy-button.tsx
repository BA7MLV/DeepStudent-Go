import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { copyFailed, copyWithFeedback } from '../utils/copyFeedback';
import { Sym } from './icons';
import './copy-button.css';

type CopyButtonProps = Omit<ComponentProps<typeof Button>, 'children' | 'onPress'> & {
  text: string | (() => string | Promise<string>);
  label: string;
};

/** 成功只在按钮原位反馈；预留两种文案的宽度，不推动相邻操作。 */
export function CopyButton({ text, label, isIconOnly = false, isDisabled, ...props }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  const copying = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);

  const copy = async () => {
    if (copying.current) return;
    copying.current = true;
    setPending(true);
    clearTimeout(timer.current);
    setCopied(false);
    try {
      // 同步文本不加 await，保留非安全上下文 execCommand 所需的用户手势。
      const value = typeof text === 'function' ? text() : text;
      const ok = await copyWithFeedback(typeof value === 'string' ? value : await value);
      if (mounted.current && ok) {
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      copyFailed();
    } finally {
      copying.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const copiedLabel = t('clipboard.copied');
  const currentLabel = copied ? copiedLabel : (props['aria-label'] ?? label);
  const button = <Button {...props} isIconOnly={isIconOnly} isDisabled={isDisabled || pending}
    aria-label={currentLabel} data-copied={copied || undefined} onPress={() => void copy()}>
    <Sym name={copied ? 'check' : 'content_copy'} />
    {!isIconOnly && <span className="copy-button__label">
      <span aria-hidden={copied} data-visible={!copied}>{label}</span>
      <span aria-hidden={!copied} data-visible={copied}>{copiedLabel}</span>
    </span>}
    <span className="sr-only" role="status">{copied ? copiedLabel : ''}</span>
  </Button>;

  return isIconOnly ? <Tooltip><Tooltip.Trigger>{button}</Tooltip.Trigger>
    <Tooltip.Content><p>{currentLabel}</p></Tooltip.Content></Tooltip> : button;
}

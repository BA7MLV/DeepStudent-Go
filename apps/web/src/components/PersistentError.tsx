import { Button } from '@heroui/react';
import { Banner, CopyButton, Sym } from '../ui';
import './subtitle-danmaku.css';

interface Props {
  title: string;
  text: string | null;
  onClose: () => void;
}

/** 失败详情常驻在面板里，关闭前不会像 toast 一样消失（替 antd Alert closable）。 */
export default function PersistentError({ title, text, onClose }: Props) {
  if (!text) return null;

  return (
    <Banner
      variant="error"
      icon={<Sym name="error" />}
      title={title}
      testId="persistent-error"
      description={<div className="persistent-error__desc">{text}</div>}
      action={
        <>
          <CopyButton
            isIconOnly
            variant="tertiary"
            size="sm"
            label="复制报错详情"
            text={text}
            data-testid="persistent-error-copy"
          />
          <Button
            isIconOnly
            variant="tertiary"
            size="sm"
            aria-label="关闭报错详情"
            data-testid="persistent-error-close"
            onPress={onClose}
          >
            <Sym name="close" />
          </Button>
        </>
      }
    />
  );
}

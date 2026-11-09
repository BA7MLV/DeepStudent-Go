import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Banner, CopyButton, Sym } from '../ui';
import { openSettings } from './settingsDialogStore';
import { isModelConfigError } from '../utils/chatError';
import './subtitle-danmaku.css';

interface Props {
  title: string;
  text: string | null;
  onClose: () => void;
}

/** 失败详情常驻在面板里，关闭前不会像 toast 一样消失（替 antd Alert closable）。 */
export default function PersistentError({ title, text, onClose }: Props) {
  const { t } = useTranslation('interface');
  if (!text) return null;
  const configProblem = isModelConfigError(text);

  return (
    <Banner
      variant="error"
      icon={<Sym name="error" />}
      title={title}
      testId="persistent-error"
      description={<div className="persistent-error__desc">{text}</div>}
      action={
        <>
          {configProblem && (
            <Button
              size="sm"
              variant="tertiary"
              data-testid="persistent-error-open-settings"
              onPress={() => openSettings('models')}
            >
              <Sym name="settings" />
              {t('errors.openModelSettings')}
            </Button>
          )}
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

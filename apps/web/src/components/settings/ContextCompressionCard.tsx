import { Checkbox } from '@heroui/react';
import { useSettings } from '../../store/settings';
import { cloud } from '../../cloud/state';
import { SectionCard } from '../../ui';

/** Only the automatic-trigger preference is browser-owned. Model selection,
 * conservative omission decisions and checkpoints belong to server chat tasks. */
export default function ContextCompressionCard() {
  const settings = useSettings();
  const model = settings.decisionModel;
  const ready = cloud.enabled && !!model.model && settings.providers.some(provider => provider.id === model.providerId);
  return (
    <SectionCard title="服务端上下文压缩" testId="card-context-compression">
      <p className="mb-4 text-sm text-muted">
        {ready ? `服务器决策模型：${model.model}。压缩由服务器执行，保留原始消息；浏览器不会连接模型供应商。`
          : '请先保存服务器决策模型配置。上下文压缩不会回退到浏览器执行。'}
      </p>
      <Checkbox aria-label="自动请求服务端上下文压缩" isDisabled={!ready} isSelected={settings.jev.contextCompression}
        onChange={contextCompression => settings.update({ jev: { ...settings.jev, contextCompression } })} data-testid="server-context-compression">
        <Checkbox.Content>
          <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
          接近上下文上限时自动请求服务端压缩
        </Checkbox.Content>
      </Checkbox>
    </SectionCard>
  );
}

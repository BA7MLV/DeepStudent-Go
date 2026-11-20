import { useTranslation } from 'react-i18next';
import { Slider, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { UNLIMITED_ROUNDS } from '../../../harness/loopGuard';
import type { ModelSlot, Settings } from '../../../store/settings';
import type { ModelSettingsIssue } from '@wangke/contracts/model-settings';
import { Field, SectionCard } from '../../../ui';
import { SlotModelSelect } from './SlotModelSelect';

const SLOT_ORDER: readonly ModelSlot[] = ['chat', 'vision', 'asr', 'decision'];

/** 槽位 → 对应设置字段。与 SlotModelSelect 的 `name` 一一对应，「智能选型」按这个字段找 issue */
const SLOT_FIELD = {
  chat: 'llmModel',
  vision: 'visionModel',
  asr: 'asrModel',
  decision: 'decisionModel',
} as const satisfies Record<ModelSlot, keyof Pick<Settings, 'llmModel' | 'visionModel' | 'asrModel' | 'decisionModel'>>;

/**
 * 总览页的两张卡片：各用途的默认模型 + 运行参数。
 *
 * 只在没有选中供应商、也没有新建草稿时出现（见 ModelsModule），
 * 这样「选模型」与「配连接」不会在同一屏抢注意力。
 */
export function ModelSlotSection({
  settings,
  modelOptions,
  issues,
  onUpdate,
}: {
  settings: Settings;
  modelOptions: Record<string, string[]>;
  issues: ModelSettingsIssue[];
  onUpdate: (patch: Partial<Settings>) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <>
      <SectionCard title={t('models.pickModel')} testId="card-models">
        <div className="flex flex-col gap-3">
          {SLOT_ORDER.map((slot) => {
            const name = SLOT_FIELD[slot];
            return (
              <SlotModelSelect
                key={slot}
                name={name}
                slot={slot}
                settings={settings}
                options={modelOptions}
                issue={issues.find((issue) => issue.path === name)}
              />
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title={t('models.runtimeParams')} testId="card-tuning">
        <Field
          label={t('models.retrievalRounds')}
          hint={t('models.retrievalRoundsHint')}
          testId="field-agent-rounds"
        >
          <ToggleButtonGroup
            data-testid="agent-rounds"
            aria-label={t('models.retrievalRounds')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[String(settings.agentRounds)]}
            onSelectionChange={(keys) => {
              // ⚠️ 不能写 `Number(next) || 12`：「不限」这一档的值是 0（UNLIMITED_ROUNDS 哨兵），
              // `0 || 12` 会把它悄悄改回 12 —— 那个选项就永远存不下来
              const n = Number([...keys][0]);
              onUpdate({ agentRounds: Number.isFinite(n) ? n : 12 });
            }}
          >
            {[3, 6, 12, 20].map((n) => (
              <ToggleButton key={n} id={String(n)}>
                {n}
              </ToggleButton>
            ))}
            {/*
              0 = 不限（agent.ts 的 UNLIMITED_ROUNDS 哨兵）。用哨兵而不是再加一个布尔字段：
              两个字段迟早会漂移，「轮数」和「有没有上限」必须是同一个量的两种取值
            */}
            <ToggleButton id={String(UNLIMITED_ROUNDS)}>不限</ToggleButton>
          </ToggleButtonGroup>
        </Field>
        <Field
          label={t('models.asrConcurrency', { count: settings.asrConcurrency })}          hint={t('models.asrConcurrencyHint')}
          layout="block"
          testId="field-asr-concurrency"
        >
          <Slider
            data-testid="asr-concurrency"
            aria-label={t('models.asrConcurrencyLabel')}
            minValue={1}
            maxValue={12}
            step={1}
            value={settings.asrConcurrency}
            onChange={(v) => onUpdate({ asrConcurrency: typeof v === 'number' ? v : v[0] })}
          >
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        </Field>
      </SectionCard>
    </>
  );
}

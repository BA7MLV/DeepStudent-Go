import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { THINKING_LEVELS } from '../api/modelCaps';
import type { ThinkingLevel } from '../api/siliconflow';
import ReasoningTexture from './ReasoningTexture';
import { textureProfile } from './reasoning-texture';
import './reasoning-effort-slider.css';

interface Props {
  value: ThinkingLevel;
  onChange: (next: ThinkingLevel) => void;
  disabled?: boolean;
  /** 在模型面板中铺满可用宽度。 */
  fluid?: boolean;
  /** Only levels actually accepted by the selected connection/model. */
  levels?: readonly { value: ThinkingLevel; label: string }[];
}

const MAX_INDEX = THINKING_LEVELS.length - 1;
const clampIndex = (index: number, max = MAX_INDEX) => Number.isFinite(index) ? Math.max(0, Math.min(max, index)) : 0;

// Native range thumb centers travel from half a thumb inside either edge.
const position = (index: number, max = MAX_INDEX) => {
  const progress = clampIndex(index, max) / max;
  return `calc(${progress * 100}% + ${0.5 - progress} * var(--reasoning-thumb-size))`;
};

/**
 * 思考深度：仅绘制当前模型支持的档位；不支持关闭时不显示「不思考」。
 *
 * 用原生 `<input type="range">` 做交互与无障碍（键盘左右键、屏幕阅读器），
 * 拖动时只更新组件内的连续预览，松手后才提交最近的档位，避免反复写设置。
 * 原生 thumb 负责命中几何；可视 thumb 与填充共用位置，松手时一起平滑吸附。
 *
 * 节点圆点用绝对定位叠在轨道正中，pointer-events:none 避免抢滑块的点击/拖拽。
 *
 */
export default function ReasoningEffortSlider({ value, onChange, disabled, fluid, levels = THINKING_LEVELS }: Props) {
  const inputId = useId();
  const index = levels.findIndex((s) => s.value === value);
  const max = Math.max(1, levels.length - 1);
  const [draft, setDraft] = useState<number | null>(null);
  const pointerId = useRef<number | null>(null);
  const visualIndex = clampIndex(draft ?? index, max);
  const nearestIndex = Math.round(visualIndex);
  const depth = visualIndex / max;
  const profile = textureProfile(depth);
  const remaining = depth === 0 ? '100%' : depth === 1 ? '0%' : position(max - visualIndex, max);
  const cancelDrag = useCallback(() => {
    pointerId.current = null;
    setDraft(null);
  }, []);
  // A model/value change or becoming disabled must not leave an old drag active.
  useEffect(cancelDrag, [value, disabled, levels, cancelDrag]);
  const commit = useCallback(
    (nextIndex: number) => {
      const next = levels[Math.round(clampIndex(nextIndex, max))]?.value;
      cancelDrag();
      if (next && next !== value) onChange(next);
    },
    [value, onChange, cancelDrag, levels, max],
  );
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = clampIndex(Number(event.currentTarget.value), max);
    if (pointerId.current !== null) setDraft(next);
    else commit(next); // Assistive technology and other non-pointer input.
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLInputElement>) => {
    if (disabled || event.button !== 0 || pointerId.current !== null) return;
    pointerId.current = event.pointerId;
    setDraft(clampIndex(Number(event.currentTarget.value), max));
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLInputElement>) => {
    if (pointerId.current !== event.pointerId) return;
    commit(Number(event.currentTarget.value));
  };
  const handlePointerCancel = (event: React.PointerEvent<HTMLInputElement>) => {
    if (pointerId.current === event.pointerId) cancelDrag();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const destinations: Partial<Record<string, number>> = {
      ArrowLeft: nearestIndex - 1, ArrowDown: nearestIndex - 1,
      ArrowRight: nearestIndex + 1, ArrowUp: nearestIndex + 1,
      PageDown: nearestIndex - 1, PageUp: nearestIndex + 1,
      Home: 0, End: max,
    };
    const next = destinations[event.key];
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <div className={fluid ? 'reasoning-slider reasoning-slider--fluid' : 'reasoning-slider'} data-testid="chat-effort-slider" data-disabled={disabled ? 'true' : undefined} data-dragging={draft !== null ? 'true' : undefined}>
      <div className="reasoning-slider__header">
        <label htmlFor={inputId}>思考深度</label>
        <span className="reasoning-slider__value" aria-hidden="true">{levels[nearestIndex]?.label ?? ''}</span>
      </div>
      <div className="reasoning-slider__control">
        <div className="reasoning-slider__track" aria-hidden="true">
          <div className="reasoning-slider__rail-clip">
            <div
              className="reasoning-slider__fill"
              style={{ width: depth === 0 ? '0%' : depth === 1 ? '100%' : position(visualIndex, max), backgroundColor: profile.fillColor }}
            />
            <div className="reasoning-slider__texture" style={{ clipPath: `inset(0 ${remaining} 0 0 round 999px)`, opacity: profile.opacity }}>
              <ReasoningTexture intensity={depth} active={!disabled} />
            </div>
            <div className="reasoning-slider__ticks">
              {levels.map((s, i) => (
                <span key={s.value} className="reasoning-slider__tick" style={{ left: position(i, max) }} data-filled={i <= nearestIndex ? '1' : undefined} />
              ))}
            </div>
          </div>
          <span className="reasoning-slider__thumb" style={{ left: position(visualIndex, max) }} />
        </div>
        <input
          id={inputId}
          className="reasoning-slider__input"
          type="range"
          min={0}
          max={max}
          step="any"
          value={visualIndex}
          disabled={disabled}
          aria-label="思考深度"
          aria-valuenow={nearestIndex}
          aria-valuetext={levels[nearestIndex]?.label ?? ''}
          onChange={handleChange}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
          onBlur={cancelDrag}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}

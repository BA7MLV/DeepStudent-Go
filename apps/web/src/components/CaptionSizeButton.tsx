import { Menu } from '@vidstack/react';
import { useSettings } from '../store/settings';

const SCALES = [
  { value: 0.8, label: '小' },
  { value: 1, label: '中' },
  { value: 1.35, label: '大' },
  { value: 1.7, label: '特大' },
] as const;

/** 明示所有档位，不再要求用户反复点击图标猜下一个字号。键盘导航沿用媒体菜单。 */
export default function CaptionSizeButton() {
  const captionScale = useSettings((s) => s.captionScale);
  const update = useSettings((s) => s.update);
  return (
    <div className="player-caption-setting">
      <span className="player-setting-label">字幕大小</span>
      <Menu.RadioGroup className="player-caption-sizes" value={String(captionScale)} aria-label="字幕大小">
        {SCALES.map(({ value, label }) => (
          <Menu.Radio key={value} className="vds-radio player-caption-size" value={String(value)}
            onSelect={() => update({ captionScale: value })}>
            {label}
          </Menu.Radio>
        ))}
      </Menu.RadioGroup>
    </div>
  );
}

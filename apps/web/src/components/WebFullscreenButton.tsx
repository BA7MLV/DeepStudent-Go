import { playerIcons } from '../ui/player-icons';
import { useSettings } from '../store/settings';
import { formatShortcut } from '../utils/shortcutSettings';

export default function WebFullscreenButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const keys = useSettings((s) => s.shortcuts.bindings.toggleWebFullscreen);
  const label = active ? '退出网页全屏' : '网页全屏';
  const Icon = active ? playerIcons.ExitWebFullscreen : playerIcons.EnterWebFullscreen;
  return (
    <button type="button" className="vds-button player-webfullscreen-button" aria-label={label} aria-pressed={active}
      title={`${label}${keys ? ` (${formatShortcut(keys)})` : ''}`} onClick={onToggle}>
      <Icon />
    </button>
  );
}

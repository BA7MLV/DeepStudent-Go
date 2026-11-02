import {
  IconAccessible,
  IconArrowLeft,
  IconArrowRight,
  IconBadgeCc,
  IconBadgeHd,
  IconCast,
  IconCheck,
  IconCircleFilled,
  IconCircleHalf2,
  IconDeviceTv,
  IconDownload,
  IconGauge,
  IconKeyboard,
  IconListDetails,
  IconMaximize,
  IconMinimize,
  IconMessage2,
  IconMessage2Off,
  IconMusic,
  IconPictureInPicture,
  IconPictureInPictureOff,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconRestore,
  IconSettings,
  IconTextDecrease,
  IconTextIncrease,
  IconVolume,
  IconVolume2,
  IconVolumeOff,
  IconViewportWide,
  IconViewportNarrow,
  IconWindowMaximize,
  IconWindowMinimize,
  type Icon,
} from '@tabler/icons-react';
import type { DefaultLayoutIcon, DefaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import { ICON_STROKE } from './icons';

/** 保留 Vidstack 传入的尺寸、类名和 SVG 属性，但字形与线宽统一为 Tabler。 */
function mediaIcon(Icon: Icon): DefaultLayoutIcon {
  return function PlayerIcon({ stroke, strokeWidth, className, ...props }) {
    return <Icon size="1em" color={stroke ?? 'currentColor'} stroke={strokeWidth ?? ICON_STROKE}
      {...props} className={`player-icon${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false" />;
  };
}

const play = mediaIcon(IconPlayerPlayFilled);
const pause = mediaIcon(IconPlayerPauseFilled);
const mute = mediaIcon(IconVolumeOff);
const volumeLow = mediaIcon(IconVolume2);
const volumeHigh = mediaIcon(IconVolume);
const captionsOn = mediaIcon(IconBadgeCc);
const captionsOff = mediaIcon(IconBadgeCc);
const enterPip = mediaIcon(IconPictureInPicture);
const exitPip = mediaIcon(IconPictureInPictureOff);
const enterFullscreen = mediaIcon(IconMaximize);
const exitFullscreen = mediaIcon(IconMinimize);
const seekBackward = mediaIcon(IconPlayerSkipBack);
const seekForward = mediaIcon(IconPlayerSkipForward);
const check = mediaIcon(IconCheck);

/** 自研控件与默认布局共用同一字形、线宽和尺寸契约。 */
export const playerIcons = {
  Play: play,
  Pause: pause,
  Replay: mediaIcon(IconRestore),
  Check: check,
  Keyboard: mediaIcon(IconKeyboard),
  DanmakuOn: mediaIcon(IconMessage2),
  DanmakuOff: mediaIcon(IconMessage2Off),
  EnterTheater: mediaIcon(IconViewportWide),
  ExitTheater: mediaIcon(IconViewportNarrow),
  EnterWebFullscreen: mediaIcon(IconWindowMaximize),
  ExitWebFullscreen: mediaIcon(IconWindowMinimize),
};

/** 全量覆盖默认布局，包括设置菜单和键盘操作提示，不混用播放器自带字形。 */
export const playerLayoutIcons: DefaultLayoutIcons = {
  AirPlayButton: { Default: mediaIcon(IconDeviceTv) },
  GoogleCastButton: { Default: mediaIcon(IconCast) },
  PlayButton: { Play: play, Pause: pause, Replay: playerIcons.Replay },
  MuteButton: { Mute: mute, VolumeLow: volumeLow, VolumeHigh: volumeHigh },
  CaptionButton: { On: captionsOn, Off: captionsOff },
  PIPButton: { Enter: enterPip, Exit: exitPip },
  FullscreenButton: { Enter: enterFullscreen, Exit: exitFullscreen },
  SeekButton: { Backward: seekBackward, Forward: seekForward },
  DownloadButton: { Default: mediaIcon(IconDownload) },
  Menu: {
    Accessibility: mediaIcon(IconAccessible),
    ArrowLeft: mediaIcon(IconArrowLeft),
    ArrowRight: mediaIcon(IconArrowRight),
    Audio: mediaIcon(IconMusic),
    AudioBoostUp: volumeHigh,
    AudioBoostDown: volumeLow,
    Chapters: mediaIcon(IconListDetails),
    Captions: captionsOff,
    Playback: play,
    Settings: mediaIcon(IconSettings),
    SpeedUp: mediaIcon(IconGauge),
    SpeedDown: mediaIcon(IconGauge),
    QualityUp: mediaIcon(IconBadgeHd),
    QualityDown: mediaIcon(IconBadgeHd),
    FontSizeUp: mediaIcon(IconTextIncrease),
    FontSizeDown: mediaIcon(IconTextDecrease),
    OpacityUp: mediaIcon(IconCircleFilled),
    OpacityDown: mediaIcon(IconCircleHalf2),
    RadioCheck: check,
  },
  KeyboardDisplay: {
    Play: play,
    Pause: pause,
    Mute: mute,
    VolumeUp: volumeHigh,
    VolumeDown: volumeLow,
    EnterFullscreen: enterFullscreen,
    ExitFullscreen: exitFullscreen,
    EnterPiP: enterPip,
    ExitPiP: exitPip,
    CaptionsOn: captionsOn,
    CaptionsOff: captionsOff,
    SeekForward: seekForward,
    SeekBackward: seekBackward,
  },
};

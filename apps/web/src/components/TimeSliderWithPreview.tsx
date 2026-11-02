import { useCallback, useEffect, useRef, useState } from 'react';
import { TimeSlider, useMediaState, useSliderState, type TimeSliderInstance } from '@vidstack/react';
import { useDefaultLayoutContext, useDefaultLayoutWord } from '@vidstack/react/player/layouts/default';
import { createPreviewSeeker } from '../utils/previewSeeker';

interface Props {
  /**
   * 与主视频相同的本地 Blob URL 或受保护的远程 URL。
   * 只有悬停/拖动时挂载预览，避免远程视频额外争抢首屏带宽。
   */
  previewSrc: string;
}

/** 预览卡片的目标尺寸：横屏按宽度封顶、竖屏按高度封顶 */
const PREVIEW_MAX = 160;

/**
 * 预览帧。
 *
 * 为什么不用官方的 `<TimeSlider.Video>`：那个组件自己维护「就绪 / 出错」状态，
 * 未就绪时给元素打 `data-hidden`，而默认样式对 `[data-hidden]` 是 `display: none; width: 0`
 * —— 实测在本地 blob 源上它一直停在 `data-hidden`（视频其实已经 readyState=4 解码好了），
 * 缩略图根本出不来。自己驱动还能合并和限频 seek（见 previewSeeker），
 * 官方实现是指针一动就写一次 `currentTime`。
 *
 * 它是 `<TimeSlider.Root>` 的后代，所以 `useSliderState` 拿得到指针位置。
 */
function PreviewFrame({ src }: { src: string }) {
  const pointing = useSliderState('pointing');
  const dragging = useSliderState('dragging');
  const active = pointing || dragging;
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!active) { setEnabled(false); return; }
    // 路过进度条时只显示时间，不为短暂悬停启动第二个视频解码器。
    const timer = setTimeout(() => setEnabled(true), 160);
    return () => clearTimeout(timer);
  }, [active]);
  return active && enabled ? <ActivePreviewFrame key={src} src={src} /> : null;
}

function ActivePreviewFrame({ src }: { src: string }) {
  /**
   * 指针位置用 `pointerRate`（0~1 的比例）而不是 `pointerValue`：
   * `pointerValue` 在这个滑块上给的是百分比量纲（实测鼠标在 25%/50%/75% 处分别得到 25/50/75），
   * 直接当秒用会取错帧。vidstack 自己的 `SliderThumbnail` 也是拿 `pointerRate × duration` 算预览时间。
   */
  const pointerRate = useSliderState('pointerRate');
  const duration = useMediaState('duration');
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekerRef = useRef<ReturnType<typeof createPreviewSeeker> | null>(null);
  // 素材宽高比要等元数据到；先按 16:9 占位，避免卡片在首帧之前高度为 0
  const [ratio, setRatio] = useState(16 / 9);
  const [ready, setReady] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // StrictMode 会重放 effect，此时 DOM 节点不会重建。
    if (video.getAttribute('src') !== src) video.src = src;
    const seeker = createPreviewSeeker(video, () => setReady(true));
    seekerRef.current = seeker;
    return () => {
      seeker.dispose();
      seekerRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  useEffect(() => {
    if (!metadataReady || !Number.isFinite(pointerRate) || !Number.isFinite(duration) || duration <= 0) return;
    // 别正好停在时长上：那一帧在多数编码里是空的（只有音频尾帧）
    const target = Math.max(0, Math.min(pointerRate * duration, duration - 0.05));
    seekerRef.current?.request(target);
  }, [pointerRate, duration, metadataReady]);

  // 横向封顶宽度、纵向封顶高度，竖屏素材（手机录的课）才不会被拉成一根长条
  const size = ratio >= 1 ? { width: PREVIEW_MAX, height: PREVIEW_MAX / ratio } : { width: PREVIEW_MAX * ratio, height: PREVIEW_MAX };

  if (failed) return null;
  return (
    <div className="player-preview-frame" style={size}>
      <video
        ref={videoRef}
        className="player-preview-video"
        src={src}
        crossOrigin={src.startsWith('blob:') ? undefined : 'use-credentials'}
        // 只拉元数据：预览是按需 seek 的，提前缓冲整段大文件没有意义
        preload="metadata"
        muted
        playsInline
        data-ready={ready ? '' : undefined}
        onLoadedMetadata={(e) => {
          const video = e.currentTarget;
          if (video.videoWidth && video.videoHeight) setRatio(video.videoWidth / video.videoHeight);
          setMetadataReady(true);
        }}
        // 第一帧解出来再淡入，否则会先闪一下纯黑
        onLoadedData={() => setReady(true)}
        onError={() => { seekerRef.current?.dispose(); setFailed(true); }}
      />
    </div>
  );
}

/**
 * 带悬停预览的时间滑块：官方默认布局的 `<DefaultTimeSlider>` 只渲染一个纯文字时间提示，
 * 这里换成「缩略图卡片 + 压在卡片底部的时间胶囊」。
 *
 * 为什么要整体替换 `timeSlider` 槽位而不是在默认布局上叠一层：预览卡片的位置由 vidstack
 * 的 `useSliderPreview` 按指针实时算出（内联 left/bottom），外部拿不到，只有自己组合
 * `<TimeSlider.Preview>` 才能把内容塞进那个跟随的盒子里。
 *
 * 其余行为（键盘、指针、ARIA、拖动吸附、章节分段）全部来自 `<TimeSlider.Root>`，
 * 与官方默认布局完全一致；类名也照抄，CSS 覆盖点才不会漂。
 */
export default function TimeSliderWithPreview({ previewSrc }: Props) {
  const label = useDefaultLayoutWord('Seek');
  const { sliderChaptersMinWidth = 325 } = useDefaultLayoutContext();
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const [chaptersEnabled, setChaptersEnabled] = useState(false);
  const onRootRef = useCallback((instance: TimeSliderInstance | null) => setRootEl(instance?.el ?? null), []);

  /**
   * 章节轨道在容器太窄时要关掉（官方默认布局同款判断）。
   * 这里量的是滑块根元素的宽度，不是视口宽度 —— 侧栏展开、面板切换都会改变它。
   */
  useEffect(() => {
    if (!rootEl) return;
    const onResize = () => setChaptersEnabled(rootEl.clientWidth >= sliderChaptersMinWidth);
    const observer = new ResizeObserver(onResize);
    observer.observe(rootEl);
    onResize();
    return () => observer.disconnect();
  }, [rootEl, sliderChaptersMinWidth]);

  return (
    <TimeSlider.Root
      className="vds-time-slider vds-slider"
      aria-label={label}
      ref={onRootRef}
    >
      <TimeSlider.Chapters className="vds-slider-chapters" disabled={!chaptersEnabled}>
        {(cues, forwardRef) =>
          cues.map((cue) => (
            <div className="vds-slider-chapter" key={cue.startTime} ref={forwardRef}>
              <TimeSlider.Track className="vds-slider-track" />
              <TimeSlider.TrackFill className="vds-slider-track-fill vds-slider-track" />
              <TimeSlider.Progress className="vds-slider-progress vds-slider-track" />
            </div>
          ))
        }
      </TimeSlider.Chapters>

      <TimeSlider.Thumb className="vds-slider-thumb" />

      <TimeSlider.Preview className="vds-slider-preview">
        <PreviewFrame src={previewSrc} />
        <TimeSlider.Value className="vds-slider-value" />
      </TimeSlider.Preview>
    </TimeSlider.Root>
  );
}

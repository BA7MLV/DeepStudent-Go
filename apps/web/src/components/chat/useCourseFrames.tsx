import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { cloud } from '../../cloud/state';
import { db, type FrameRow } from '../../store/db';
import { loadCollection } from '../../client/collections';
import { MaterialImage, SourceImage } from '../MaterialImage';
import { parseMaterialImageHref } from '../../materials/imageRefs';
import type { MaterialReaderHandle } from '../../materials/types';
import type { ComponentImage } from './ChatMessageThread';
import { FrameThumb, type FrameMeta } from './FrameThumb';

/** 材料里点了文档引用要滚到的定位单元（页码 / 段号），与阅读器句柄同源 */
type UnitTarget = Parameters<MaterialReaderHandle['scrollToUnit']>[0];

/**
 * 讲义抽帧元数据 + 正文里的两种自定义 img/link 渲染器。
 *
 * 为什么归在一起：`#frame-` 与 `#source-image/` 两套自定义节点都依赖「帧元数据」
 * 与「阅读器句柄」，拆成两处各自 useCallback 会把同一份依赖抄两遍；
 * 放在一个 hook 里，帧元数据一变，渲染器同时换代 —— 与原先内联在面板里时一致。
 */
export function useCourseFrames({
  videoId,
  readerRef,
  onSeek,
}: {
  videoId: string;
  readerRef: React.RefObject<MaterialReaderHandle | null> | undefined;
  /** 时间戳跳转（面板持有播放器实例，这里只负责渲染与转发） */
  onSeek: (seconds: number) => void;
}) {
  // 讲义抽帧元数据：决定 list_frames 工具/提示词注入，也供 AI 气泡里的画面引用渲染
  const [framesMeta, setFramesMeta] = useState<FrameMeta[]>([]);

  /** 读取讲义抽帧元数据（幻灯片帧，blob 不进状态） */
  const loadFramesMeta = useCallback(async () => {
    const database = db, owner = cloud.userId;
    const rows = cloud.enabled ? (await loadCollection<FrameRow>('frames', videoId)).filter(row => row.kind === 'slide').sort((a, b) => a.ts - b.ts) : await db.frames
      .where('videoId')
      .equals(videoId)
      .filter((r) => r.kind === 'slide')
      .sortBy('ts');
    // 取数期间换了账号：这一批行属于上一个 owner，写进状态只会串台
    if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
    const meta = rows.map((r) => ({ id: r.id!, ts: r.ts }));
    setFramesMeta(meta);
    return meta;
  }, [videoId]);

  // 进入面板时预载帧元数据（历史消息里的画面引用回放需要）
  useEffect(() => {
    void loadFramesMeta();
  }, [loadFramesMeta]);

  /**
   * 文档引用只在「就是当前这门课」时才挂跳转：别的课程的引用点了不该滚到本课阅读器。
   * 链接（`#source-image/` 小签）与图片（正文里的原图）两处判断完全相同，共用一份。
   */
  const sourceOf = useCallback((href: string): ((unit?: UnitTarget) => void) | undefined => {
    if (!readerRef || parseMaterialImageHref(href)?.courseId !== videoId) return undefined;
    return (unit) => { if (unit) readerRef.current?.scrollToUnit(unit); };
  }, [readerRef, videoId]);

  /** 自定义图片渲染：#frame-秒 渲染课程画面缩略图（点击跳转），其余按原样 */
  const FrameImage: ComponentImage = useCallback(
    ({ src, alt }) => {
      if (src?.startsWith('#frame-')) {
        return <FrameThumb secs={Number(src.slice(7))} alt={alt} frames={framesMeta} onSeek={onSeek} />;
      }
      if (src?.startsWith('#source-image/')) return <MaterialImage href={src} label={alt} onSource={sourceOf(src)} />;
      return <SourceImage src={src} alt={alt} />;
    },
    [framesMeta, onSeek, sourceOf],
  );

  /**
   * 自定义链接里的文档小签（linkOnly：只渲染一枚可点的引用标签，不展开原图）。
   * 注意类型不能是 ComponentLink：那是渲染器的函数签名（靠 domNode/streamStatus 调用），
   * 而这个组件只在 SeekLink 里以 JSX 使用，签名就是 href + children。
   */
  const SourceImageLink = useCallback(
    ({ href, children }: { href?: string; children?: ReactNode }) =>
      <MaterialImage href={href ?? ''} label={children} linkOnly onSource={sourceOf(href ?? '')} />,
    [sourceOf],
  );

  return { framesMeta, FrameImage, SourceImageLink };
}

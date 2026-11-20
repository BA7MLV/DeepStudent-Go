/**
 * 视频卡片的展示片段：缩略图、进度文字。
 *
 * 单独成文件是为了让「读封面」这件事只有一个入口：带缩略图的卡片与访达列表项的
 * 小图标都走同一个 hook，缓存上限（store/covers）才不会被两处各自 retain 绕开。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { cloudBlobUrl } from '../store/cloudBlob';
import { db, type VideoRow } from '../store/db';
import { cachedCoverUrl, createCachedCoverUrl, releaseCoverUrl, retainCoverUrl, useCoverRevision } from '../store/covers';
import { progressRatio } from '../utils/videoProgress';
import { Sym } from '../ui/icons';

/**
 * 卡片缩略图：读 `covers` 表里那份**派生封面**（生成逻辑见 `pipelines/cover.ts`）。
 *
 * 与上一版的差别：那版直接取 `db.frames` 的第一帧，于是「只有跑过讲义的视频才有封面」
 * 成了默认行为，讲义重生成时封面还会短暂消失。现在封面是入库即生成的独立资源，
 * 帧池归讲义用、封面归列表用，各管各的。
 *
 * 四处刻意的做法：
 *   1. `covers.get(videoId)` 是**主键查询、只读一条**。封面之所以不挂在 `videos` 行上，
 *      就是为了让列表页那句 `videos.toArray()` 不会把几十上百张图的 blob 一并拉进内存。
 *   2. 订阅 `useCoverRevision`：封面是异步补上的，靠它把新生成的图换上，
 *      而不用为一张缩略图去调整个列表的 reload。
 *   3. 用 `createdAt` 判断「是不是同一版封面」——IndexedDB 每次读都会重新反序列化，
 *      Blob 的对象身份稳定不了，比不了引用只能比这个。
 *   4. object URL 由 `store/covers` 做有界缓存：离开文件夹时不回收，回来可复用；
 *      只有资源删除或缓存淘汰时才回收。
 */
export function useThumb(videoId: string): string | null {
  const revision = useCoverRevision();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retained = false;
    db.covers
      .get(videoId)
      .then((row) => {
        if (cancelled) return;
        if (!row?.blob) { setUrl(null); return; }
        const remote = cloudBlobUrl(row.blob);
        if (remote) { setUrl(remote); return; }
        const next = cachedCoverUrl(videoId, row.createdAt) ?? createCachedCoverUrl(videoId, row.createdAt, row.blob as Blob);
        retainCoverUrl(videoId);
        retained = true;
        setUrl(next);
      })
      .catch(() => {
        /* 读封面失败只是「这次没图」，静默走占位，不影响列表 */
      });
    return () => { cancelled = true; if (retained) releaseCoverUrl(videoId); };
  }, [videoId, revision]);

  return url;
}

/** 观看进度文案：看完显示「已看完」，否则「已看 42%」；没开始看返回 null */
export function finderProgressText(video: VideoRow): string | null {
  const ratio = progressRatio(video);
  if (ratio == null) return null;
  return video.finished === 1 ? i18n.t('library.t.watched', { ns: 'projects' }) : i18n.t('library.t.watchedPercent', { ns: 'projects', percent: Math.round(ratio * 100) });
}

/**
 * 访达图标视图里的文件图标：缩略图 / 占位、扩展名角标、进度条、置顶角标。
 * 尺寸全部由 library.css 的 `.finder-item__icon` 决定，这里只给结构。
 */
export function FinderFileIcon({ video }: { video: VideoRow }) {
  const { t: tr } = useTranslation('projects');
  const cover = useThumb(video.id);
  const isMaterial = video.kind === 'material';
  const ratio = progressRatio(video);
  const extension = isMaterial ? (video.materialFormat ?? 'doc').toUpperCase() : 'VIDEO';
  return (
    <span className={isMaterial ? 'finder-document' : 'finder-video'}>
      {cover
        ? <img src={cover} alt="" loading="lazy" decoding="async" />
        : <span className="finder-file-placeholder" aria-hidden="true">
          {isMaterial ? <><i /><i /><i /><i /><i /><i /></> : <Sym name="play_circle" className="text-[32px]" />}
        </span>}
      <span className="finder-file-extension">{extension}</span>
      {ratio != null && <span
        className="finder-video-progress"
        role="progressbar"
        aria-label={tr('library.t.watchProgressAria', { name: video.name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={finderProgressText(video) ?? undefined}
      ><span style={{ width: `${ratio * 100}%` }} /></span>}
      {video.pinned === 1 && <span className="finder-file-pin" aria-label={tr('library.aria.pinned')}><Sym name="pin" /></span>}
    </span>
  );
}

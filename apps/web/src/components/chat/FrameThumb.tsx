import { useEffect, useMemo, useState } from 'react';
import { cloudBlobUrl } from '../../store/cloudBlob';
import { db, type FrameRow } from '../../store/db';
import { readRecordKeys } from '../../cloud/sync';
import { cloud } from '../../cloud/state';
import { fmtTime } from '../../utils/vtt';

/** 幻灯片帧元数据（blob 按需经 id 单取，不进 React 状态） */
export interface FrameMeta {
  id: number;
  ts: number;
}

/**
 * AI 回答里的课程画面引用（[图@mm:ss] → #frame-秒 → 本组件）。
 * 就近匹配（±2s，时间戳经 fmtTime/parse 往返有秒级误差）后从 db.frames 取 blob 渲染缩略图，
 * 点击跳转播放器；匹配不到画面时降级为可点击的时间戳链接。
 */
export function FrameThumb({
  secs,
  alt,
  frames,
  onSeek,
}: {
  secs: number;
  alt?: string;
  frames: FrameMeta[];
  onSeek: (t: number) => void;
}) {
  const frame = useMemo(() => {
    let best: FrameMeta | null = null;
    for (const f of frames) {
      const d = Math.abs(f.ts - secs);
      if (d <= 2 && (!best || d < Math.abs(best.ts - secs))) best = f;
    }
    return best;
  }, [secs, frames]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!frame) return;
    let cancelled = false;
    let objUrl: string | null = null;
    void (cloud.enabled ? readRecordKeys<FrameRow>('frames', [frame.id]).then(rows => rows[0]) : db.frames.get(frame.id)).then((row) => {
      if (cancelled || !row) return;
      const remote = cloudBlobUrl(row.blob);
      if (!remote) objUrl = URL.createObjectURL(row.blob as Blob);
      setUrl(remote ?? objUrl);
    }).catch(() => { /* An unavailable image must not hide the conversation. */ });
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
      setUrl(null);
    };
  }, [frame]);

  if (!frame) {
    return (
      <a
        onClick={(e) => {
          e.preventDefault();
          onSeek(secs);
        }}
        className="chat-ts"
      >
        {alt || `[图@${fmtTime(secs)}]`}
      </a>
    );
  }
  return (
    <span className="chat-frame-wrap">
      {url ? (
        <img
          src={url}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          onClick={() => onSeek(frame.ts)}
          className="chat-frame-img"
        />
      ) : (
        <span className="chat-frame-img chat-frame-img--pending" />
      )}
      <span className="chat-ts-chip">
        {fmtTime(frame.ts)}
      </span>
    </span>
  );
}

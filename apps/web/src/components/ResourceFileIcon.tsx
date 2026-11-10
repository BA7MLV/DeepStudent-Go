import { useEffect, useRef, useState } from 'react';
import type { ResourceEntry } from '@wangke/contracts/resources';
import { serverClient } from '../api/serverClient';
import { cloud } from '../cloud/state';
import { cloudBlobUrl } from '../store/cloudBlob';
import { useCoverRevision } from '../store/covers';
import { Sym } from '../ui';
import { useCourseMetadata } from './useCourseMetadata';

/** Keep the original Finder document/cover appearance in the filesystem library. */
export function ResourceFileIcon({ entry }: { entry: ResourceEntry }) {
  const { projectId, path, name, courseId, revision, missing } = entry;
  const coverRevision = useCoverRevision();
  const element = useRef<HTMLSpanElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [cover, setCover] = useState<{ key: string; url: string } | null>(null);
  const [media, setMedia] = useState<{ key: string; video: boolean } | null>(null);
  const markdown = /\.(md|markdown)$/i.test(name);
  const image = /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
  const metadata = useCourseMetadata(courseId ? [courseId] : [], true, nearViewport && !(image && !missing));
  const lifetime = metadata.lifetime;
  const selected = metadata.items[0], currentMetadata = metadata.current;
  const key = JSON.stringify([cloud.userId, projectId, path, courseId, revision, missing]);
  const video = /\.(mp4|mov|m4v|webm|mkv|avi|flv|ts|m2ts|mpeg|mpg|wmv|3gp|rmvb|rm)$/i.test(name)
    || (media?.key === key && media.video);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setNearViewport(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNearViewport(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport) return;
    if (image && !missing) return;
    if (!metadata.ready) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    const current = () => !cancelled && currentMetadata();
    const unown = lifetime?.own(() => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); setCover(null); setMedia(null); });
    void (async () => {
      const stored = selected?.cover, course = selected?.course;
      if (!current()) return;
      // Imported/renamed videos may have display names without an extension.
      // The confirmed course kind, not just the filename, owns their media icon.
      setMedia({ key, video: !!course && course.kind !== 'material' });
      let blob = stored?.blob;
      // Markdown is live filesystem content. Repaint on its file revision, rather
      // than showing an old derived cover after a reader/Bot edit. User covers win.
      if (markdown && !missing && stored?.source !== 'user') {
        const [file, { mdCoverText }, { paintTextCover }] = await Promise.all([
          serverClient.projectText(projectId, path),
          import('../materials/md'),
          import('../media/textCover'),
        ]);
        if (!current()) return;
        const { title, preview } = mdCoverText(file.text);
        blob = (await paintTextCover({ title: title ?? name.replace(/\.(md|markdown)$/i, ''), preview })).blob;
      }
      if (!current()) return;
      if (blob) {
        const remote = cloudBlobUrl(blob);
        if (!remote) objectUrl = URL.createObjectURL(blob as Blob);
        setCover({ key, url: remote ?? objectUrl! });
      } else setCover(null);
    })().catch(() => {
      // A missing/unreadable file must still have a usable document icon.
      if (current()) setCover(null);
    });
    return () => {
      cancelled = true;
      unown?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, path, name, courseId, revision, missing, key, markdown, image, coverRevision, nearViewport, metadata.ready, selected, currentMetadata, lifetime]);

  const src = image && !missing ? serverClient.projectDownloadUrl(projectId, path) : cover?.key === key ? cover.url : null;
  const extension = video ? 'VIDEO' : markdown ? 'MD' : name.includes('.') ? name.split('.').pop()!.toUpperCase() : 'FILE';
  return <span ref={element} className="resource-file-icon" aria-hidden="true">
    <span className={video ? 'finder-video' : 'finder-document'}>
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <span className="finder-file-placeholder">{video ? <Sym name="play_circle" /> : <><i /><i /><i /><i /><i /><i /></>}</span>}
      <span className="finder-file-extension">{extension}</span>
    </span>
  </span>;
}

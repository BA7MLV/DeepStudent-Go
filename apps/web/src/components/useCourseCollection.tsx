import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { ProjectionTable } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { observeCollection } from '../client/collections';
import { formatCaughtError } from '../utils/errorText';
import { useTranslation } from 'react-i18next';
import { accountLifetime } from '../client/account-lifecycle';

export function CourseCollectionError({ error, retry }: { error: string | null; retry: () => void }) {
  const { t } = useTranslation('interface');
  return error ? <p role="alert">{error} <button type="button" onClick={retry}>{t('handoutRead.retry')}</button></p> : null;
}

export function useCourseCollection<T extends { time: number }>(table: ProjectionTable, videoId: string) {
  const database = db, owner = cloud.userId, server = cloud.enabled;
  const terminal = useRef({ database, ended: false });
  if (terminal.current.database !== database) terminal.current = { database, ended: false };
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState({ table, videoId, database, owner, rows: [] as T[], ready: false, error: null as string | null });
  const reload = useCallback(async () => { setAttempt(value => value + 1); }, []);
  const setRows = useCallback((update: T[] | ((rows: T[]) => T[])) => setValue(previous => ({ ...previous, rows: typeof update === 'function' ? update(previous.rows) : update })), []);
  useEffect(() => {
    let active = true;
    const empty = { table, videoId, database, owner, rows: [] as T[], ready: false, error: null as string | null };
    if (terminal.current.ended) { setValue(empty); return; }
    const lifetime = server ? accountLifetime(owner) : undefined;
    const unown = lifetime?.own(() => { active = false; terminal.current.ended = true; setValue(empty); });
    setValue(previous => previous.table === table && previous.videoId === videoId && previous.database === database ? { ...previous, ready: false } : empty);
    const observer = {
      next(rows: T[]) { if (active && database === db && owner === cloud.userId) setValue({ ...empty, rows: [...rows].sort((a, b) => a.time - b.time), ready: true }); },
      error(error: unknown) { if (active && database === db && owner === cloud.userId) setValue(previous => ({ ...previous, ready: false, error: formatCaughtError(error) })); },
    };
    const subscription = server ? observeCollection<T>(table, videoId, observer)
      : liveQuery(() => database.table<T>(table).where('videoId').equals(videoId).sortBy('time')).subscribe(observer);
    return () => { active = false; subscription.unsubscribe(); unown?.(); };
  }, [table, videoId, database, owner, server, attempt]);
  const scoped = value.table === table && value.videoId === videoId && value.database === database && value.owner === owner;
  return { rows: scoped ? value.rows : [] as T[], ready: scoped && value.ready, error: scoped ? value.error : null, reload, setRows };
}

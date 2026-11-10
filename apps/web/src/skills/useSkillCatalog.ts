import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { observeSkillCatalog, retrySkillCatalog, type SkillCatalogSnapshot } from './demand';

export function useSkillCatalog() {
  const owner = cloud.userId;
  const [state, setState] = useState<SkillCatalogSnapshot & { owner: string }>({ owner, ready: false });
  useEffect(() => {
    setState({ owner, ready: false });
    if (cloud.enabled) return observeSkillCatalog(snapshot => setState({ owner, ...snapshot }));
    const subscription = liveQuery(async () => {
      const [skills, refs] = await Promise.all([db.skills.orderBy('id').toArray(), db.skillRefs.toArray()]);
      const counts = new Map<number, number>();
      for (const ref of refs) counts.set(ref.skillId, (counts.get(ref.skillId) ?? 0) + 1);
      return skills.flatMap(({ body: _body, id, ...row }) => id == null ? [] : [{ ...row, id, refCount: counts.get(id) ?? 0 }]);
    }).subscribe({ next: rows => setState({ owner, ready: true, rows }), error: error => setState({ owner, ready: false, error: String(error) }) });
    return () => subscription.unsubscribe();
  }, [owner, db]);
  return { ...(state.owner === owner ? state : { ready: false, rows: undefined, error: undefined }), retry: retrySkillCatalog };
}

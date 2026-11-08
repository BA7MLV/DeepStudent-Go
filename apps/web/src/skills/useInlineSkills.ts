import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import { useTranslation } from 'react-i18next';
import { db, type SkillRow } from '../store/db';
import { BUILTIN_PRESENTATION } from './presentation';
import type { InlineSkill } from './inline';
import { isLegacyHandoutSkill } from './catalog';

export function useInlineSkills() {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<SkillRow[]>();
  useEffect(() => {
    setRows(undefined);
    const subscription = liveQuery(() => db.skills.toArray()).subscribe({ next: setRows, error: () => setRows([]) });
    return () => subscription.unsubscribe();
  }, [db]);
  const skills = useMemo<InlineSkill[]>(() => (rows ?? []).flatMap(row => {
    if (row.id == null) return [];
    const builtin = row.builtin ? BUILTIN_PRESENTATION.find(item => item.name === row.name) : undefined;
    const label = builtin ? t(`skillPicker.builtins.${builtin.key}.title`) : row.name;
    return [{ id: row.id, name: row.name, label, aliases: row.legacyIds ?? [], names: [...new Set([row.name, label, ...(row.legacyNames ?? [])])],
      enabled: !!row.enabled && !isLegacyHandoutSkill(row), summary: builtin ? t(`skillPicker.builtins.${builtin.key}.brief`) : row.description }];
  }), [rows, t]);
  return { skills, ready: rows !== undefined };
}

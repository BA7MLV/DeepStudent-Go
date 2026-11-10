import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BUILTIN_PRESENTATION } from './presentation';
import type { InlineSkill } from './inline';
import { isLegacyHandoutSkill } from './catalog';
import { useSkillCatalog } from './useSkillCatalog';

export function useInlineSkills() {
  const { t } = useTranslation('settings');
  const { rows, ready, error, retry } = useSkillCatalog();
  const skills = useMemo<InlineSkill[]>(() => (rows ?? []).flatMap(row => {
    if (row.id == null) return [];
    const builtin = row.builtin ? BUILTIN_PRESENTATION.find(item => item.name === row.name) : undefined;
    const label = builtin ? t(`skillPicker.builtins.${builtin.key}.title`) : row.name;
    return [{ id: row.id, name: row.name, label, aliases: row.legacyIds ?? [], names: [...new Set([row.name, label, ...(row.legacyNames ?? [])])],
      enabled: !!row.enabled && !isLegacyHandoutSkill(row), summary: builtin ? t(`skillPicker.builtins.${builtin.key}.brief`) : row.description }];
  }), [rows, t]);
  return { skills, ready, error, retry };
}

import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { db, type SkillRow } from '../store/db';
import { BUILTIN_PRESENTATION } from '../skills/presentation';
import { Sym } from '../ui';
import './skill-chips.css';

interface Props {
  ids?: number[];
  onRemove?: (ids: number[]) => void;
  disabled?: boolean;
}

export default function SkillChips(props: Props) {
  return props.ids?.length ? <SelectedSkillChips {...props} ids={props.ids} /> : null;
}

function SelectedSkillChips({ ids, onRemove, disabled }: Props & { ids: number[] }) {
  const { t } = useTranslation('settings');
  const [skills, setSkills] = useState<SkillRow[]>([]);
  useEffect(() => {
    const subscription = liveQuery(() => db.skills.toArray()).subscribe({
      next: setSkills,
      error: () => setSkills([]),
    });
    return () => subscription.unsubscribe();
  }, [db]);
  const selected = new Map<number, { skill?: SkillRow; ids: number[] }>();
  for (const id of new Set(ids)) {
    const skill = skills.find(row => row.id === id) ?? skills.find(row => row.legacyIds?.includes(id));
    const key = skill?.id ?? id;
    const group = selected.get(key) ?? { skill, ids: [] };
    group.ids.push(id);
    selected.set(key, group);
  }

  return <span className="skill-chips" data-testid={onRemove ? 'composer-skill-chips' : 'message-skill-chips'}>
    {[...selected].map(([id, { skill, ids: originalIds }]) => {
      const builtin = skill?.builtin ? BUILTIN_PRESENTATION.find(item => item.name === skill.name) : undefined;
      const name = builtin ? t(`skillPicker.builtins.${builtin.key}.title`) : skill?.name ?? t('skillPicker.unknownSkill', { id });
      return <span key={id} className="skill-chip" data-testid="skill-chip" data-skill-id={id}>
        <Sym name={builtin?.icon ?? 'extension'} />
        <span className="skill-chip__name">{name}</span>
        {onRemove && <Button isIconOnly size="sm" variant="tertiary" className="skill-chip__remove"
          isDisabled={disabled} aria-label={t('skillPicker.removeSkill', { name })} onPress={() => onRemove(originalIds)}>
          <Sym name="close" />
        </Button>}
      </span>;
    })}
  </span>;
}

import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { skillMentions, type InlineSkill } from './inline';

/** Uses the live catalog and scope, including when either changes mid-draft. */
export function skillCompletion(get: () => { skills: InlineSkill[]; availableSkillIds?: number[] }) {
  return autocompletion({
    aboveCursor: true, icons: false, activateOnTypingDelay: 50, interactionDelay: 0,
    tooltipClass: () => 'skill-completions',
    override: [(context: CompletionContext) => {
      const match = context.matchBefore(/@[^@\s，。！？、；：,!?;:]*/u);
      if (!match || (match.from > 0 && /[\w.+-]/.test(context.state.sliceDoc(match.from - 1, match.from)))) return null;
      const { skills, availableSkillIds } = get();
      const used = new Set(skillMentions(context.state.doc.toString(), skills).map(mention => mention.skill.id));
      const query = match.text.slice(1).toLocaleLowerCase();
      const choices = skills.filter(skill => skill.enabled && !used.has(skill.id)
        && (availableSkillIds === undefined || availableSkillIds.some(id => id === skill.id || skill.aliases.includes(id)))
        && [...skill.names, skill.summary ?? ''].some(text => text.toLocaleLowerCase().includes(query)));
      return { from: match.from, filter: false, options: choices.map(skill => ({
        label: skill.label, detail: skill.summary,
        apply: `@${skill.name}`,
      })) };
    }],
  });
}

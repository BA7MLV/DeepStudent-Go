/** Mentions are ordinary copyable text; explicit IDs remain the invocation authority. */
export interface InlineSkill {
  id: number;
  name: string;
  label: string;
  aliases: number[];
  names: string[];
  enabled?: boolean;
  summary?: string;
}

export interface SkillMention { from: number; to: number; skill: InlineSkill }

export function skillMentions(text: string, skills: readonly InlineSkill[]): SkillMention[] {
  const tokens = skills.flatMap(skill => skill.names.map(name => ({ token: `@${name}`, skill })))
    .sort((a, b) => b.token.length - a.token.length);
  const mentions: SkillMention[] = [];
  for (let from = text.indexOf('@'); from >= 0;) {
    const found = tokens.find(({ token }) => text.startsWith(token, from));
    if (found) mentions.push({ from, to: from + found.token.length, skill: found.skill });
    from = text.indexOf('@', from + (found?.token.length ?? 1));
  }
  return mentions;
}

export function selectedInlineSkills(skills: readonly InlineSkill[], ids: readonly number[]) {
  return skills.filter(skill => ids.some(id => id === skill.id || skill.aliases.includes(id)));
}

import { Fragment, type ReactNode } from 'react';
import { selectedInlineSkills, skillMentions } from '../skills/inline';
import { useInlineSkills } from '../skills/useInlineSkills';
import './inline-skill-input.css';

/** The persisted text contains @names, so selection/copy/export keeps the same order. */
interface Props {
  content: string; ids?: number[]; renderText?: (text: string) => ReactNode;
}
export default function SkillMessageContent(props: Props) {
  if (!props.ids?.length) return props.renderText ? props.renderText(props.content) : props.content;
  return <MentionedContent {...props} />;
}

function MentionedContent({ content, ids = [], renderText = text => text }: Props) {
  const { skills } = useInlineSkills();
  const selected = selectedInlineSkills(skills, ids);
  const ranges = skillMentions(content, selected);
  const missing = selected.filter(skill => !ranges.some(range => range.skill.id === skill.id));
  let offset = 0;
  const pieces = ranges.map(({ from, to, skill }) => {
    const text = content.slice(offset, from); offset = to;
    return <Fragment key={from}>{renderText(text)}<span className="inline-skill-chip" data-testid="skill-chip" data-skill-id={skill.id}>{content.slice(from, to)}</span></Fragment>;
  });
  return <span className="inline-skill-message" data-testid={ids.length ? 'message-skill-chips' : undefined}>
    {missing.map(skill => <Fragment key={skill.id}><span className="inline-skill-chip" data-testid="skill-chip" data-skill-id={skill.id}>@{skill.name}</span>{' '}</Fragment>)}
    {pieces}{renderText(content.slice(offset))}
  </span>;
}

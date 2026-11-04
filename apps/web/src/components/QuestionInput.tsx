import { useState } from 'react';
import { questionType, optionLetter, validQuizAnswer, type QuizAnswer, type QuizQuestion } from '../harness/quiz';
import { useResolvedDark } from '../ui/theme';
import { useSettings } from '../store/settings';
import { Markdown } from './markdown/Markdown';
import { MaterialImage, SourceImage } from './MaterialImage';
import WidgetBlock from './WidgetBlock';
import type { WidgetAnswerFeedback } from '../harness/widgetProtocol';

const components = { img: SourceImage };

export function emptyQuizAnswer(q: QuizQuestion): QuizAnswer {
  switch (questionType(q)) {
    case 'single': return -1;
    case 'boolean': return '';
    case 'multiple': return [];
    case 'fill': return Array.from({ length: q.blanks ?? (Array.isArray(q.answer) ? q.answer.length : q.acceptedAnswers?.length ?? 1) }, () => '');
    case 'ordering': return q.options.map((_, i) => i);
    case 'matching': return q.options.map(() => -1);
    case 'composite': return q.parts!.map(emptyQuizAnswer);
    default: return '';
  }
}

/** Input only: neither generated HTML nor these controls get to grade or persist an attempt. */
export default function QuestionInput({ question: q, value, onChange, onSubmit, answerFeedback, disabled = false, label = '作答' }: {
  question: QuizQuestion; value: QuizAnswer; onChange: (answer: QuizAnswer) => void; disabled?: boolean; label?: string;
  onSubmit?: (answer: QuizAnswer) => Promise<void>; answerFeedback?: WidgetAnswerFeedback | null;
}) {
  const dark = useResolvedDark(useSettings((s) => s.theme));
  const [standard, setStandard] = useState(false);
  const type = questionType(q);
  if (q.presentation && !standard) return <div className="quiz-input">
    <WidgetBlock payload={q.presentation} dark={dark} readingKey={JSON.stringify([q.stem, q.type, q.options, q.source])} disabled={disabled} answerFeedback={answerFeedback}
      answerInput={{ answer: value, submitted: disabled, onDraft: (raw) => {
        if (!validQuizAnswer(q, raw)) throw new Error('草稿格式与题型不符，请按题库约定返回答案');
        onChange(raw);
      }, onSubmit: onSubmit ? async raw => {
        if (!validQuizAnswer(q, raw)) throw new Error('答案格式与题型不符');
        if (!window.confirm(`确认提交此题答案？\n${q.stem}\n作答：${JSON.stringify(raw)}`)) throw new Error('已取消提交');
        await onSubmit(raw);
      } : undefined }} />
    <p className="quiz-source">交互提交需宿主确认；也可核对草稿后点击题卡的“提交答案”。判定以宿主反馈为准。</p>
    <pre className="quiz-draft" aria-label="交互作答草稿">{JSON.stringify(value, null, 2)}</pre>
    <button type="button" className="quiz-ts" onClick={() => setStandard(true)}>使用标准作答界面</button>
  </div>;
  if (type === 'single' || type === 'multiple' || type === 'boolean') {
    const items = type === 'boolean' ? ['正确', '错误'] : q.options;
    return <div className="quiz-options" role="group" aria-label={label}>{items.map((opt, oi) => {
      const selected = type === 'multiple' ? (value as number[]).includes(oi) : value === (type === 'boolean' ? oi === 0 : oi);
      return <button key={oi} type="button" disabled={disabled} aria-pressed={selected}
        className={`quiz-option${selected ? ' quiz-option--selected' : ''}`} onClick={() => {
          if (type === 'multiple') onChange(selected ? (value as number[]).filter((a) => a !== oi) : [...value as number[], oi]);
          else onChange(type === 'boolean' ? oi === 0 : oi);
        }}><b>{type === 'multiple' ? selected ? '☑' : '☐' : optionLetter(oi) + '.'}</b><Markdown content={opt} components={components} /></button>;
    })}</div>;
  }
  if (type === 'fill') return <div className="quiz-input">{(value as string[]).map((a, i) => <label key={i}>
    {label} · 第 {i + 1} 空<input className="quiz-text" value={a} disabled={disabled} maxLength={16000} onChange={(event) => {
      const next = [...value as string[]]; next[i] = event.target.value; onChange(next);
    }} /></label>)}<p className="quiz-source">填空按已登记答案精确核对；公式等价、单位换算等请使用主观题核对。</p></div>;
  if (type === 'matching') return <div className="quiz-input">{q.options.map((opt, i) => <label key={i}>
    <Markdown content={`${optionLetter(i)}. ${opt}`} components={components} />
    <select className="quiz-text" disabled={disabled} aria-label={`${label} · 配对 ${optionLetter(i)}`} value={(value as number[])[i]} onChange={(event) => {
      const next = [...value as number[]]; next[i] = Number(event.target.value); onChange(next);
    }}><option value={-1}>请选择对应项</option>{q.matches!.map((m, mi) => <option key={mi} value={mi}>{m}</option>)}</select>
  </label>)}</div>;
  if (type === 'ordering') return <ol className="quiz-input">{(value as number[]).map((oi, position) => <li key={oi} className="quiz-order-item">
    <span><b>{optionLetter(oi)}.</b> {q.options[oi]}</span>
    {[-1, 1].map((direction) => <button key={direction} type="button" disabled={disabled || position + direction < 0 || position + direction >= q.options.length}
      aria-label={`${direction < 0 ? '上移' : '下移'} ${optionLetter(oi)}`} onClick={() => {
        const next = [...value as number[]]; [next[position], next[position + direction]] = [next[position + direction], next[position]]; onChange(next);
      }}>{direction < 0 ? '↑' : '↓'}</button>)}
  </li>)}</ol>;
  if (type === 'composite') return <div className="quiz-input">{q.parts!.map((part, i) => <section key={i} className="quiz-part">
    <Markdown content={part.stem} components={components} />
    {part.images?.map((href) => <MaterialImage key={href} href={href} label="小题原图" />)}
    <QuestionInput question={part} value={(value as QuizAnswer[])[i]} label={`${label} · 小题 ${i + 1}`} disabled={disabled} onChange={(answer) => {
      const next = [...value as QuizAnswer[]]; next[i] = answer; onChange(next);
    }} />
  </section>)}</div>;
  return <label className="quiz-input">{label}（可填写推导、证明、代码或 Markdown）
    <textarea className="quiz-text" aria-label={label} rows={5} maxLength={32000} value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  </label>;
}

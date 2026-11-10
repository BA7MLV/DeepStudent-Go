import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import { Compartment, EditorState, Facet, Prec, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { acceptCompletion, completionStatus } from '@codemirror/autocomplete';
import { skillCompletion } from '../skills/completion';
import { useTranslation } from 'react-i18next';
import { selectedInlineSkills, skillMentions, type InlineSkill } from '../skills/inline';
import { useInlineSkills } from '../skills/useInlineSkills';
import './inline-skill-input.css';

export interface InlineSkillInputHandle { focus: () => void }
export interface ComposerPaste { clipboardData: DataTransfer; preventDefault: () => void }
interface Props {
  value: string;
  skillIds: number[];
  availableSkillIds?: number[];
  onChange: (text: string) => void;
  onSkillsChange: (ids: number[]) => void;
  onSubmit?: () => void;
  onPaste?: (event: ComposerPaste) => void;
  onFocus?: () => void;
  onOverflowChange?: (overflow: boolean) => void;
  label: string;
  description?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  expanded?: boolean;
  documentKey?: string | number | null;
  className?: string;
}

const catalog = Facet.define<readonly InlineSkill[], readonly InlineSkill[]>({ combine: values => values[0] ?? [] });
const removeLabel = Facet.define<(name: string) => string>({});

class SkillWidget extends WidgetType {
  constructor(readonly skill: InlineSkill, readonly from: number, readonly to: number, readonly token: string, readonly label: string, readonly disabled: boolean) { super(); }
  eq(other: SkillWidget) { return this.from === other.from && this.to === other.to && this.token === other.token && this.skill.label === other.skill.label && this.label === other.label && this.disabled === other.disabled; }
  toDOM(view: EditorView) {
    const chip = document.createElement('span');
    chip.className = 'inline-skill-chip';
    chip.dataset.testid = 'skill-chip';
    chip.dataset.skillId = String(this.skill.id);
    chip.contentEditable = 'false';
    const name = document.createElement('span');
    name.textContent = this.skill.label;
    chip.append(name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'inline-skill-chip__remove';
    remove.setAttribute('aria-label', this.label);
    remove.tabIndex = -1;
    remove.disabled = this.disabled;
    remove.addEventListener('mousedown', event => event.preventDefault());
    remove.addEventListener('click', event => {
      event.preventDefault();
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.from, to: this.to }, selection: { anchor: this.from }, userEvent: 'delete' });
      view.focus();
    });
    chip.append(remove);
    return chip;
  }
  ignoreEvent() { return true; }
}

function decorations(state: EditorState) {
  const text = state.doc.toString(), label = state.facet(removeLabel)[0];
  return Decoration.set(skillMentions(text, state.facet(catalog)).map(({ from, to, skill }) =>
    Decoration.replace({ widget: new SkillWidget(skill, from, to, text.slice(from, to), label(skill.label), state.readOnly) }).range(from, to)));
}
const mentions = StateField.define<DecorationSet>({
  create: decorations,
  update: (value, transaction) => transaction.docChanged || transaction.reconfigured ? decorations(transaction.state) : value,
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
});

/** One document owns text, mentions, cursor, clipboard and undo. No hidden textarea
 * or separate chip row: the replacement widgets decorate copyable @skill text. */
const InlineSkillInput = forwardRef<InlineSkillInputHandle, Props>(function InlineSkillInput(props, ref) {
  const { t } = useTranslation('settings');
  const { skills, ready, error, retry } = useInlineSkills();
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null);
  const latest = useRef({ props, skills, ready });
  latest.current = { props, skills, ready };
  const slots = useMemo(() => ({ options: new Compartment(), catalog: new Compartment(), history: new Compartment() }), []);
  const external = useRef(false);
  const previousIds = useRef<number[]>([]);
  const insertionPosition = useRef(props.value.length);
  const composing = useRef(false);
  const composingUntil = useRef(-Infinity);
  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), []);

  useLayoutEffect(() => {
    const view = new EditorView({ parent: host.current!, root: document,
      state: EditorState.create({ doc: latest.current.props.value, selection: { anchor: latest.current.props.value.length }, extensions: [
        slots.options.of([]), slots.catalog.of(catalog.of([])), mentions,
        removeLabel.of(name => t('skillPicker.removeSkill', { name })),
        slots.history.of(history()), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
        skillCompletion(() => ({ skills: latest.current.skills, availableSkillIds: latest.current.props.availableSkillIds })),
        Prec.highest(EditorView.domEventHandlers({
          keydown: (event, view) => {
            const completion = completionStatus(view.state);
            const head = view.state.selection.main.head;
            const pendingMention = completion === 'pending'
              && /(^|[^\w.+-])@[^@\s，。！？、；：,!?;:]*$/u.test(view.state.sliceDoc(view.state.doc.lineAt(head).from, head));
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey && (completion === 'active' || pendingMention)) {
              acceptCompletion(view);
              return true;
            }
            if (event.key === 'Tab' && !event.shiftKey && completion === 'active') return acceptCompletion(view);
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || !latest.current.props.onSubmit) return false;
            if (!view.state.readOnly) latest.current.props.onSubmit?.();
            return true;
          },
          compositionstart: () => { composing.current = true; },
          compositionend: () => { composing.current = false; composingUntil.current = performance.now() + 40; },
          paste: event => {
            if (event.clipboardData) latest.current.props.onPaste?.({ clipboardData: event.clipboardData, preventDefault: () => event.preventDefault() });
            return event.defaultPrevented;
          },
          focus: () => { latest.current.props.onFocus?.(); },
        })),
        EditorView.updateListener.of(update => {
          // Overlay focus restoration can move the browser selection while the
          // editor is blurred. Keep the last editing cursor, mapping text edits.
          if (update.docChanged) insertionPosition.current = update.changes.mapPos(insertionPosition.current, 1);
          if (update.view.hasFocus && (update.selectionSet || update.docChanged)) insertionPosition.current = update.state.selection.main.head;
          if (!update.docChanged || external.current) return;
          const text = update.state.doc.toString();
          const { props, skills, ready } = latest.current;
          if (ready) {
            const ids = [...new Set(skillMentions(text, skills).map(mention => mention.skill.id))];
            previousIds.current = ids;
            const selected = selectedInlineSkills(skills, props.skillIds).map(skill => skill.id);
            if (selected.length !== ids.length || ids.some(id => !selected.includes(id))) props.onSkillsChange(ids);
          }
          props.onChange(text);
        }),
      ] }),
    });
    editor.current = view;
    // Leave candidate confirmation to the IME, without falling through to
    // CodeMirror's Enter keymap (which would insert a newline).
    const guardComposition = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (composing.current || view.composing || event.isComposing || event.keyCode === 229 || performance.now() < composingUntil.current)) {
        event.stopImmediatePropagation();
      }
    };
    view.contentDOM.addEventListener('keydown', guardComposition, true);
    const measure = () => {
      const scroller = view.scrollDOM;
      latest.current.props.onOverflowChange?.(scroller.scrollHeight > scroller.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(view.contentDOM); observer.observe(view.scrollDOM);
    if (latest.current.props.autoFocus) view.focus();
    return () => { observer.disconnect(); view.contentDOM.removeEventListener('keydown', guardComposition, true); view.destroy(); editor.current = null; };
  }, [slots]);

  useLayoutEffect(() => {
    const view = editor.current!;
    insertionPosition.current = Math.min(props.value.length, view.state.doc.length);
    view.dispatch({ effects: slots.history.reconfigure([]) });
    view.dispatch({ effects: slots.history.reconfigure(history()) });
  }, [slots, props.documentKey]);

  useLayoutEffect(() => {
    const view = editor.current!;
    view.dispatch({ effects: slots.options.reconfigure([
      EditorState.readOnly.of(!!props.disabled), EditorView.editable.of(!props.disabled),
      EditorView.contentAttributes.of({ role: 'textbox', 'aria-label': props.label, 'aria-multiline': 'true',
        'aria-disabled': String(!!props.disabled), ...(props.description ? { 'aria-description': props.description } : {}),
        enterkeyhint: props.onSubmit ? 'send' : 'enter' }),
      placeholder(props.placeholder ?? ''),
    ]) });
  }, [slots, props.disabled, props.label, props.description, props.placeholder, !!props.onSubmit]);

  useLayoutEffect(() => {
    const view = editor.current!;
    external.current = true;
    try {
      if (view.state.doc.toString() !== props.value) {
        const head = view.state.selection.main.head;
        const anchor = head === view.state.doc.length ? props.value.length : Math.min(head, props.value.length);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value },
          selection: { anchor }, annotations: Transaction.addToHistory.of(false) });
        if (!props.value) {
          view.dispatch({ effects: slots.history.reconfigure([]) });
          view.dispatch({ effects: slots.history.reconfigure(history()) });
        }
      }
      if (view.state.facet(catalog) !== skills) view.dispatch({ effects: slots.catalog.reconfigure(catalog.of(skills)) });
      if (!ready) return;
      const selected = selectedInlineSkills(skills, props.skillIds);
      const previous = selectedInlineSkills(skills, previousIds.current);
      const removed = new Set(previous.filter(skill => !selected.some(item => item.id === skill.id)).map(skill => skill.id));
      const ranges = skillMentions(view.state.doc.toString(), skills);
      const additions = selected.filter(skill => !previous.some(item => item.id === skill.id) && !ranges.some(range => range.skill.id === skill.id));
      previousIds.current = props.skillIds;
      const changes = ranges.filter(range => removed.has(range.skill.id)).map(({ from, to }) => ({ from, to, insert: '' }));
      if (changes.length) view.dispatch({ changes, userEvent: 'delete' });
      if (additions.length) {
        // Selection survives the modal; insert at that position, not at the top.
        const insert = additions.map(skill => `@${skill.name}`).join(' ');
        const from = Math.min(insertionPosition.current, view.state.doc.length);
        view.dispatch({ changes: { from, insert }, selection: { anchor: from + insert.length }, userEvent: 'input' });
      }
      const text = view.state.doc.toString();
      if (text !== props.value) props.onChange(text);
    } finally { external.current = false; }
  }, [props.value, props.skillIds, skills, ready, slots]);

  return <>
    <div ref={host} className={`inline-skill-input ${props.className ?? ''}`} data-expanded={props.expanded || undefined}
      data-testid="composer-skill-chips" />
    {error && <div role="status" className="text-sm text-muted" data-testid="composer-skills-error">
      {t('skillPicker.loadError')}{' '}<button type="button" onClick={() => void retry().catch(() => {})}>{t('skillPicker.retry')}</button>
    </div>}
  </>;
});

export default InlineSkillInput;

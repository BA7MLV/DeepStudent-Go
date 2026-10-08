import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  buildResourcePrompt,
  deleteLearningResource,
  filterLearningResources,
  listLearningResources,
  putLearningResource,
  resourceFromFile,
  type LearningResource,
} from "./learning-resources";
import "./learning-resources.css";

export type ResourceQuestion = {
  resource: LearningResource;
  excerpt: string;
  prompt: string;
};

export type ResourceLibraryProps = {
  /** Host sends this text to its existing Go `/sessions/:id/messages` adapter. */
  onAsk?: (question: ResourceQuestion) => void;
  className?: string;
};

function selectedText(node: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!node || !selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
  const range = selection.getRangeAt(0);
  if (!node.contains(range.commonAncestorContainer)) return "";
  return selection.toString().trim().slice(0, 2_000);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ResourceLibrary({ onAsk, className = "" }: ResourceLibraryProps) {
  const [resources, setResources] = useState<LearningResource[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [question, setQuestion] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const previewRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    try {
      const rows = await listLearningResources();
      setResources(rows);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取本地资料");
    }
  };

  useEffect(() => { void reload(); }, []);

  const visible = useMemo(() => filterLearningResources(resources, query), [resources, query]);
  const selected = resources.find((resource) => resource.id === selectedId) ?? visible[0];

  const importFiles = async (files: FileList | File[]) => {
    const entries = Array.from(files);
    if (entries.length === 0) return;
    setBusy(true);
    setNotice("");
    try {
      for (const file of entries) await putLearningResource(await resourceFromFile(file));
      await reload();
      setNotice(`已导入 ${entries.length} 份资料`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void importFiles(event.target.files);
    event.target.value = "";
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void importFiles(event.dataTransfer.files);
  };

  const ask = () => {
    if (!selected || !onAsk) return;
    onAsk({ resource: selected, excerpt, prompt: buildResourcePrompt(selected, question, excerpt) });
    setQuestion("");
  };

  return (
    <section className={`ds-learning-resources ${className}`} aria-label="资料">
      <input ref={inputRef} hidden type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={onInput} />
      <header className="ds-learning-resources__header">
        <div><span className="ds-learning-resources__eyebrow">本地优先</span><h2>资料</h2><p>导入 Markdown / TXT，保存到本机后即可带上下文提问。</p></div>
        <button className="ds-learning-resources__primary" type="button" onClick={() => inputRef.current?.click()} disabled={busy}>{busy ? "导入中…" : "＋ 添加资料"}</button>
      </header>
      {notice && <p className="ds-learning-resources__notice" role="status">{notice}</p>}
      <div className="ds-learning-resources__layout">
        <aside className="ds-learning-resources__list">
          <label className="ds-learning-resources__search">⌕ <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料…" /></label>
          <div className="ds-learning-resources__drop" data-dragging={dragging} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
            <b>拖入 Markdown / TXT</b><span>内容只保存在浏览器本机</span>
          </div>
          {visible.length === 0 ? <p className="ds-learning-resources__empty">还没有匹配的资料</p> : visible.map((resource) => (
            <button key={resource.id} type="button" className="ds-learning-resources__row" data-active={resource.id === selected?.id} onClick={() => { setSelectedId(resource.id); setExcerpt(""); }}>
              <span className="ds-learning-resources__icon">{resource.name.toLowerCase().endsWith(".md") || resource.name.toLowerCase().endsWith(".markdown") ? "MD" : "TXT"}</span>
              <span><b>{resource.name}</b><small>{formatBytes(resource.size)} · {new Date(resource.updatedAt).toLocaleDateString()}</small></span>
            </button>
          ))}
        </aside>
        <div className="ds-learning-resources__detail">
          {!selected ? <div className="ds-learning-resources__empty ds-learning-resources__empty--detail"><b>选择一份资料开始</b><span>导入后可在这里预览，并把全文或选区交给 DeepStudent。</span></div> : <>
            <div className="ds-learning-resources__detail-head"><div><b>{selected.name}</b><small>{formatBytes(selected.size)} · {selected.text.length.toLocaleString()} 字符</small></div><button type="button" className="ds-learning-resources__delete" onClick={async () => { await deleteLearningResource(selected.id); await reload(); }}>删除</button></div>
            <pre ref={previewRef} className="ds-learning-resources__preview" onMouseUp={() => setExcerpt(selectedText(previewRef.current))}>{selected.text || "（这份资料没有可预览的文字）"}</pre>
            {excerpt && <div className="ds-learning-resources__excerpt" title="发送时会作为上下文附带">已选中 {excerpt.length} 字：{excerpt}</div>}
            <div className="ds-learning-resources__ask"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="问问这份资料…" rows={2} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") ask(); }} /><button type="button" onClick={ask} disabled={!onAsk || !question.trim()}>提问</button></div>
          </>}
        </div>
      </div>
    </section>
  );
}

export default ResourceLibrary;


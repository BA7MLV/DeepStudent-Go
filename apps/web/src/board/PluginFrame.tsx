import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { BoardPlugin } from '@wangke/contracts/board';
import type { PluginHostContext } from '@wangke/contracts/plugins';
import { request } from '../api/serverClient';
import { PageLoader } from '../ui';
import { pluginRead } from '../plugins/shared';
import { SANDBOX_THEME_SCRIPT, sandboxJSON } from '../sandbox/protocol';

export interface PluginFrameAdapter {
  identity: string;
  htmlPath: string;
  context: PluginHostContext;
  call(method: string, args: Record<string, unknown>): Promise<unknown>;
  subscribe?(listener: (data: unknown) => void): () => void;
}

const escapeScript = sandboxJSON;
function readTheme() {
  const css = getComputedStyle(window.document.documentElement);
  const values: Record<string, string> = {};
  for (const [to, from] of [['--background', '--surface'], ['--foreground', '--foreground'], ['--muted', '--muted'], ['--accent', '--accent'], ['--border', '--border'], ['--radius', '--radius-control'], ['--danger', '--danger']]) values[to] = css.getPropertyValue(from).trim();
  return { values, colorScheme: css.colorScheme === 'dark' ? 'dark' : 'light' };
}
function source(html: string, channel: string, locale: string, labels: unknown, initialTheme: ReturnType<typeof readTheme>) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>
  :root{color-scheme:light;background:var(--background)}*{box-sizing:border-box}body{margin:0;padding:0 2px 4px;font:14px/1.5 system-ui,sans-serif;color:var(--foreground);background:transparent;overflow-wrap:anywhere}button,input,select,textarea{font:inherit;border:1px solid var(--border);border-radius:var(--radius,8px);padding:8px 10px;color:var(--foreground);background:var(--background)}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}button[aria-pressed=true]{border-color:transparent;background:color-mix(in oklab,var(--accent) 8%,var(--background));color:var(--accent)}input{min-width:0;flex:1}input[type=checkbox]{accent-color:var(--accent)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.stack{display:grid;gap:10px}.muted{color:var(--muted)}.error{color:var(--danger,#c43b4a)}.error:empty{display:none}p{margin:10px 0}
  body{display:flow-root}input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}
  @media(max-width:600px){button,select,input:not([type=checkbox]),textarea{min-height:44px}input:not([type=checkbox]),select,textarea{font-size:16px}label:has(input[type=checkbox]){min-height:44px}}
  @media(max-width:360px){.row>label:has(select,input){flex-basis:100%}}
  </style><script>
  (()=>{const channel=${escapeScript(channel)},pending=new Map(),listeners=new Map();let sequence=0,context=null;document.documentElement.lang=${escapeScript(locale)};
  ${SANDBOX_THEME_SCRIPT}
  const applyTheme=(values,scheme)=>__applyHostTheme(values,scheme,'data-theme');
  applyTheme(${escapeScript(initialTheme.values)},${escapeScript(initialTheme.colorScheme)});
  const emit=(name,data)=>{for(const fn of listeners.get(name)||[])try{fn(data);}catch(e){console.error(e);}};
  addEventListener('message',event=>{if(event.source!==parent||event.data?.channel!==channel)return;const m=event.data;if(m.theme){applyTheme(m.theme,m.colorScheme);return;}if(m.context){context=m.context;emit('contextChanged',context);return;}if(m.lifecycle){emit(m.lifecycle,m.data);return;}const entry=pending.get(m.id);if(!entry)return;clearTimeout(entry.timer);pending.delete(m.id);m.error?entry.reject(new Error(m.error)):entry.resolve(m.result);});
  const call=(method,args={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('board_request_timeout'));},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({channel,id,method,args},'*');});
  const snapshot=d=>({data:JSON.parse(d.content),revision:d.revision,content:d.content});
  const terminal=status=>['completed','failed','cancelled','interrupted'].includes(status);
  const watch=(id,onChange,options={})=>{
    let stopped=false,timer,last;
    const stop=()=>{stopped=true;clearTimeout(timer);options.signal?.removeEventListener('abort',stop);removeEventListener('pagehide',stop);};
    const poll=async()=>{
      try{const task=await call('tasks.get',{id});if(stopped)return;const next=JSON.stringify(task);if(next!==last){last=next;await onChange(task);}if(terminal(task.status))stop();}
      catch(error){if(!stopped){if(options.onError)options.onError(error);else console.error(error);}}
      if(!stopped)timer=setTimeout(poll,1500);
    };
    if(options.signal?.aborted)return stop;
    options.signal?.addEventListener('abort',stop,{once:true});addEventListener('pagehide',stop,{once:true});void poll();return stop;
  };
  const wait=(id,options={})=>new Promise((resolve,reject)=>{
    let stop=()=>{};
    const done=(error,task)=>{stop();options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(task);};
    const abort=()=>done(new DOMException('Task wait aborted','AbortError'));
    if(options.signal?.aborted){abort();return;}
    options.signal?.addEventListener('abort',abort,{once:true});
    stop=watch(id,task=>{if(terminal(task.status))done(null,task);},{onError:error=>done(error)});
  });
  const tasks=Object.freeze({start:args=>call('tasks.start',args),get:id=>call('tasks.get',{id}),cancel:id=>call('tasks.cancel',{id}),open:id=>call('tasks.open',{id}),watch,wait});
  window.board=Object.freeze({locale:${escapeScript(locale)},labels:${escapeScript(labels)},t:(zh,en)=>${escapeScript(locale)}.startsWith('zh')?zh:en,call,tasks,read:async(kind='state')=>snapshot(await call(kind+'.read')),write:async(data,before,kind='state')=>snapshot(await call(kind+'.write',{data,expected:before.content,revision:before.revision}))});
  window.plugin=Object.freeze({...window.board,context:{get:()=>call('context.get')},state:{read:window.board.read,write:window.board.write},draft:{read:()=>call('draft.read'),write:data=>call('draft.write',{data})},events:{subscribe:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name)?.delete(fn);}}});
  addEventListener('error',event=>parent.postMessage({channel,pluginError:event.message||'board_script_failed'},'*'));
  addEventListener('unhandledrejection',event=>parent.postMessage({channel,pluginError:String(event.reason?.message||event.reason||'board_script_failed')},'*'));
  addEventListener('DOMContentLoaded',()=>{const resize=()=>parent.postMessage({channel,height:Math.ceil(document.body.getBoundingClientRect().height)},'*');new ResizeObserver(resize).observe(document.body);resize();});
  parent.postMessage({channel,ready:true},'*');})();
  </script></head><body>${html}</body></html>`;
}

export function PluginFrame({ plugin, adapter }: { plugin: BoardPlugin; adapter?: PluginFrameAdapter }) {
  const { t, i18n } = useTranslation('common');
  const navigate = useNavigate();
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(56);
  const [channel] = useState(() => crypto.randomUUID());
  const currentAdapter = useRef(adapter);
  currentAdapter.current = adapter;
  const htmlPath = adapter?.htmlPath ?? `/board/plugins/${encodeURIComponent(plugin.id)}`;
  const identity = adapter?.identity ?? plugin.id;
  useEffect(() => {
    setError(''); setHtml(undefined);
    const controller = new AbortController();
    void pluginRead<BoardPlugin & { html: string }>(htmlPath).then(result => {
      if (controller.signal.aborted) return;
      if (result.revision !== plugin.revision) throw new Error('board_plugin_changed');
      setHtml(result.html);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [htmlPath, plugin.revision, attempt]);
  const labels = useMemo(() => t('backgroundTasks', { returnObjects: true }), [t, i18n.language]);
  // Seed before the first paint. Subsequent theme changes use messages, preserving drafts and timers.
  const document = useMemo(() => html === undefined ? undefined : source(html, channel, i18n.language, labels, readTheme()), [html, channel, i18n.language, labels]);
  useEffect(() => {
    let active = true, inFlight = 0;
    const controller = new AbortController();
    const context = () => currentAdapter.current ? { ...currentAdapter.current.context, width: Math.round(frame.current?.getBoundingClientRect().width ?? currentAdapter.current.context.width), theme: readTheme().colorScheme, locale: i18n.language } : undefined;
    const theme = () => {
      const { values, colorScheme } = readTheme();
      frame.current?.contentWindow?.postMessage({ channel, theme: values, colorScheme }, '*');
      if (currentAdapter.current) frame.current?.contentWindow?.postMessage({ channel, context: context() }, '*');
    };
    const onMessage = async (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.data?.channel !== channel) return;
      if (event.data.ready === true) { theme(); if (currentAdapter.current) target.postMessage({ channel, lifecycle: 'mount', data: context() }, '*'); return; }
      if (typeof event.data.pluginError === 'string') { setError(event.data.pluginError.slice(0, 300)); return; }
      if (Number.isFinite(event.data.height)) { setHeight(Math.max(56, Math.min(plugin.manifest?.height ?? 320, event.data.height))); return; }
      const { id, method, args } = event.data;
      if (!Number.isSafeInteger(id) || typeof method !== 'string' || JSON.stringify(args ?? {}).length > 200000 || inFlight >= 8) return;
      inFlight++;
      try {
        const runtime = currentAdapter.current;
        let result: any;
        const draftKey = `plugin-draft:${identity}:${plugin.revision}`;
        if (runtime && method === 'context.get') result = context();
        else if (runtime && method === 'draft.read') result = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
        else if (runtime && method === 'draft.write') { const value = JSON.stringify(args?.data ?? null); if (value.length > 20000) throw new Error('plugin_draft_too_large'); sessionStorage.setItem(draftKey, value); result = { saved: true }; }
        else result = runtime ? await runtime.call(method, args ?? {}) : await request(`/board/plugins/${encodeURIComponent(plugin.id)}/rpc`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ revision: plugin.revision, method, args }) });
        if (active) target.postMessage({ channel, id, result }, '*');
        if (active && method === 'tasks.open' && typeof result.threadId === 'string') navigate(`/bot?thread=${encodeURIComponent(result.threadId)}`);
      } catch (e) { if (active) target.postMessage({ channel, id, error: e instanceof Error ? e.message : 'board_request_failed' }, '*'); }
      finally { inFlight--; }
    };
    window.addEventListener('message', onMessage);
    const observer = new MutationObserver(theme);
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const resize = new ResizeObserver(theme);
    if (frame.current) resize.observe(frame.current);
    const unsubscribe = currentAdapter.current?.subscribe?.(data => frame.current?.contentWindow?.postMessage({ channel, lifecycle: 'state.changed', data }, '*'));
    const visibility = () => frame.current?.contentWindow?.postMessage({ channel, lifecycle: 'visibilityChanged', data: !window.document.hidden }, '*');
    window.document.addEventListener('visibilitychange', visibility);
    return () => { frame.current?.contentWindow?.postMessage({ channel, lifecycle: 'dispose' }, '*'); unsubscribe?.(); active = false; controller.abort(); observer.disconnect(); resize.disconnect(); window.removeEventListener('message', onMessage); window.document.removeEventListener('visibilitychange', visibility); };
  }, [channel, identity, plugin.id, plugin.revision, plugin.manifest?.height, attempt, i18n.language, navigate, document]);
  useEffect(() => { if (adapter) frame.current?.contentWindow?.postMessage({ channel, context: adapter.context }, '*'); }, [adapter?.context, channel]);
  if (error) return <div><p role="alert" className="text-sm text-danger">{t('board.pluginError')} · {error}</p><button type="button" className="mt-2 text-sm text-accent underline" onClick={() => setAttempt(value => value + 1)}>{t('board.retry')}</button></div>;
  if (document === undefined) return <PageLoader contained label={t('board.loading')} />;
  return <iframe ref={frame} title={plugin.manifest?.name ?? plugin.id} srcDoc={document} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="block w-full border-0" style={{ height }} />;
}

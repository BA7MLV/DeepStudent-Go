import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  subscribe?(listener: (data: unknown) => void, failed?: (error: Error) => void): () => void;
  watchTask?(id: string, listener: (task: unknown) => void, failed: (error: Error) => void): () => void;
  observeQuery?(method: string, args: Record<string, unknown>, listener: (value: unknown) => void, failed: (error: Error) => void): () => void;
}

const escapeScript = sandboxJSON;
function readTheme() {
  const css = getComputedStyle(window.document.documentElement);
  const values: Record<string, string> = {};
  for (const [to, from] of [['--background', '--surface'], ['--foreground', '--foreground'], ['--muted', '--muted'], ['--accent', '--accent'], ['--border', '--border'], ['--radius', '--radius-control'], ['--danger', '--danger']]) values[to] = css.getPropertyValue(from).trim();
  return { values, colorScheme: css.colorScheme === 'dark' ? 'dark' : 'light' };
}
function source(html: string, channel: string, locale: string, labels: unknown, initialTheme: ReturnType<typeof readTheme>, compact: boolean, formLabel: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>
  :root{color-scheme:light;background:var(--background)}*{box-sizing:border-box}body{margin:0;padding:0 2px 4px;font:14px/1.5 system-ui,sans-serif;color:var(--foreground);background:transparent;overflow-wrap:anywhere}button,input,select,textarea{font:inherit;border:1px solid var(--border);border-radius:var(--radius,8px);padding:8px 10px;color:var(--foreground);background:var(--background)}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}button[aria-pressed=true]{border-color:transparent;background:color-mix(in oklab,var(--accent) 8%,var(--background));color:var(--accent)}input{min-width:0;flex:1}input[type=checkbox]{accent-color:var(--accent)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.stack{display:grid;gap:10px}.muted{color:var(--muted)}.error{color:var(--danger,#c43b4a)}.error:empty{display:none}p{margin:10px 0}
  body{display:flow-root}input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}
  select,input[type=date],input[type=time],input[type=datetime-local]{min-height:40px;box-shadow:0 1px 2px rgb(0 0 0/.04);background:color-mix(in oklab,var(--foreground) 4%,var(--background));border-color:transparent}
  select{appearance:none;padding-right:32px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23888' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
  .host-compact-form{margin-bottom:12px}.host-compact-form>summary{cursor:pointer;min-height:40px;padding:8px 0;color:var(--foreground)}.host-compact-form[open]>form{margin-block:8px}
  @media(max-width:600px){button,select,input:not([type=checkbox]),textarea{min-height:44px}input:not([type=checkbox]),select,textarea{font-size:16px}label:has(input[type=checkbox]){min-height:44px}}
  @media(max-width:360px){.row>label:has(select,input){flex-basis:100%}}
  </style><script>
  (()=>{const channel=${escapeScript(channel)},pending=new Map(),listeners=new Map(),taskObservers=new Map();let sequence=0,context=null,disposed=false;document.documentElement.lang=${escapeScript(locale)};
  ${SANDBOX_THEME_SCRIPT}
  const applyTheme=(values,scheme)=>__applyHostTheme(values,scheme,'data-theme');
  applyTheme(${escapeScript(initialTheme.values)},${escapeScript(initialTheme.colorScheme)});
  const emit=(name,data)=>{for(const fn of listeners.get(name)||[])try{fn(data);}catch(e){console.error(e);}};
  addEventListener('message',event=>{if(event.source!==parent||event.data?.channel!==channel||disposed)return;const m=event.data;if(m.theme){applyTheme(m.theme,m.colorScheme);return;}if(m.context){context=m.context;emit('contextChanged',context);return;}if(m.taskWatch){taskObservers.get(m.taskWatch)?.(m);return;}if(m.lifecycle){if(m.lifecycle==='dispose')disposed=true;emit(m.lifecycle,m.data);if(disposed){for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('plugin_scope_expired'));}pending.clear();taskObservers.clear();listeners.clear();}return;}const entry=pending.get(m.id);if(!entry)return;clearTimeout(entry.timer);pending.delete(m.id);m.error?entry.reject(new Error(m.error)):entry.resolve(m.result);});
  const call=(method,args={})=>new Promise((resolve,reject)=>{if(disposed){reject(new Error('plugin_scope_expired'));return;}const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('board_request_timeout'));},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({channel,id,method,args},'*');});
  const snapshot=d=>({data:JSON.parse(d.content),revision:d.revision,content:d.content});
  const terminal=status=>['completed','failed','cancelled','interrupted'].includes(status);
  const watch=(id,onChange,options={})=>{
    const watchId='task:'+ ++sequence;
    let stopped=false,busy=false,latest,final,offDispose=()=>{};
    const stop=()=>{if(stopped)return;stopped=true;taskObservers.delete(watchId);offDispose();options.signal?.removeEventListener('abort',stop);removeEventListener('pagehide',stop);void call('tasks.unwatch',{watchId}).catch(()=>{});};
    const fail=error=>{if(stopped)return;stop();if(options.onError)options.onError(error);else console.error(error);};
    const pump=async()=>{
      if(busy||stopped)return;busy=true;
      try{while(!stopped&&(latest||final)){const task=latest||final;if(latest)latest=undefined;else final=undefined;await onChange(task);if(terminal(task.status)){stop();break;}}}
      catch(error){fail(error);}finally{busy=false;}
    };
    if(options.signal?.aborted)return stop;
    taskObservers.set(watchId,m=>{if(m.error){fail(new Error(m.error));return;}if(terminal(m.task.status))final=m.task;else latest=m.task;void pump();});
    const onDispose=()=>fail(new Error('plugin_scope_expired'));if(!listeners.has('dispose'))listeners.set('dispose',new Set());listeners.get('dispose').add(onDispose);offDispose=()=>listeners.get('dispose')?.delete(onDispose);
    options.signal?.addEventListener('abort',stop,{once:true});addEventListener('pagehide',stop,{once:true});void call('tasks.watch',{id,watchId}).catch(fail);return stop;
  };
  const wait=(id,options={})=>new Promise((resolve,reject)=>{
    let stop=()=>{};
    const done=(error,task)=>{stop();options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(task);};
    const abort=()=>done(new DOMException('Task wait aborted','AbortError'));
    if(options.signal?.aborted){abort();return;}
    options.signal?.addEventListener('abort',abort,{once:true});
    stop=watch(id,task=>{if(terminal(task.status))done(null,task);},{onError:error=>done(error)});
  });
  const observe=(method,args,onChange,options={})=>{
    const watchId='query:'+ ++sequence;let stopped=false;const stop=()=>{if(stopped)return;stopped=true;taskObservers.delete(watchId);listeners.get('dispose')?.delete(onDispose);options.signal?.removeEventListener('abort',stop);void call('queries.unwatch',{watchId}).catch(()=>{});};
    const fail=error=>{stop();if(options.onError)options.onError(error);else console.error(error);};
    if(options.signal?.aborted)return stop;
    taskObservers.set(watchId,m=>{if(stopped)return;if(m.error){fail(new Error(m.error));return;}try{onChange(m.task);}catch(error){fail(error);}});
    const onDispose=()=>fail(new Error('plugin_scope_expired'));if(!listeners.has('dispose'))listeners.set('dispose',new Set());listeners.get('dispose').add(onDispose);options.signal?.addEventListener('abort',stop,{once:true});void call('queries.watch',{watchId,method,args}).catch(fail);return stop;
  };
  const tasks=Object.freeze({start:args=>call('tasks.start',args),get:id=>call('tasks.get',{id}),cancel:id=>call('tasks.cancel',{id}),open:id=>call('tasks.open',{id}),watch,wait,observeList:(onChange,options)=>observe('tasks.list',{},onChange,options)});
  window.board=Object.freeze({locale:${escapeScript(locale)},labels:${escapeScript(labels)},t:(zh,en)=>${escapeScript(locale)}.startsWith('zh')?zh:en,call,tasks,read:async(kind='state')=>snapshot(await call(kind+'.read')),write:async(data,before,kind='state')=>snapshot(await call(kind+'.write',{data,expected:before.content,revision:before.revision}))});
  window.plugin=Object.freeze({...window.board,context:{get:()=>call('context.get')},state:{read:window.board.read,write:window.board.write},queries:Object.freeze({observe}),draft:{read:()=>call('draft.read'),write:data=>call('draft.write',{data})},events:{subscribe:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name)?.delete(fn);}}});
  addEventListener('error',event=>parent.postMessage({channel,pluginError:event.message||'board_script_failed'},'*'));
  addEventListener('unhandledrejection',event=>parent.postMessage({channel,pluginError:String(event.reason?.message||event.reason||'board_script_failed')},'*'));
  addEventListener('DOMContentLoaded',()=>{
    // Compact cards keep long editors available behind a disclosure. Moving the
    // existing form preserves plugin listeners, field values and validation.
    if(${compact})for(const form of document.querySelectorAll('form')){
      if(form.closest('details')||form.querySelectorAll('input:not([type=hidden]):not([type=submit]),select,textarea').length<4)continue;
      const details=document.createElement('details'),summary=document.createElement('summary');details.className='host-compact-form';summary.textContent=${escapeScript(formLabel)};form.before(details);details.append(summary,form);
      form.addEventListener('invalid',()=>{details.open=true;},true);
    }
    const resize=()=>parent.postMessage({channel,height:Math.ceil(document.body.getBoundingClientRect().height)},'*');new ResizeObserver(resize).observe(document.body);resize();});
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
  // A document incarnation owns its channel. An old cleanup/reply must never
  // target the replacement sandbox, even if its logical placement is the same.
  const channel = useMemo(() => crypto.randomUUID(), [identity, plugin.revision, attempt, i18n.language, html, labels]);
  // Seed before the first paint. Subsequent theme changes use messages, preserving drafts and timers.
  const compact = adapter?.context.mode === 'compact';
  const formLabel = t('board.editForm');
  const document = useMemo(() => html === undefined ? undefined : source(html, channel, i18n.language, labels, readTheme(), compact, formLabel), [html, channel, i18n.language, labels, compact, formLabel]);
  useLayoutEffect(() => {
    if (document === undefined) return;
    const ownedFrame = frame.current;
    const ownedWindow = ownedFrame?.contentWindow;
    if (!ownedFrame || !ownedWindow) return;
    let active = true, inFlight = 0;
    let unsubscribe: (() => void) | undefined;
    let subscribed = false;
    const taskWatches = new Map<string, () => void>();
    const controller = new AbortController();
    const context = () => currentAdapter.current ? { ...currentAdapter.current.context, width: Math.round(ownedFrame.getBoundingClientRect().width), theme: readTheme().colorScheme, locale: i18n.language } : undefined;
    const theme = () => {
      const { values, colorScheme } = readTheme();
      ownedWindow.postMessage({ channel, theme: values, colorScheme }, '*');
      if (currentAdapter.current) ownedWindow.postMessage({ channel, context: context() }, '*');
    };
    const onMessage = async (event: MessageEvent) => {
      const target = ownedWindow;
      if (!active || event.source !== target || event.data?.channel !== channel) return;
      if (event.data.ready === true) {
        theme();
        if (currentAdapter.current) target.postMessage({ channel, lifecycle: 'mount', data: context() }, '*');
        // The sandbox must have installed its message listener before a retained
        // model can replay a cached baseline. Never lose that first projection.
        if (!subscribed) {
          subscribed = true;
          unsubscribe = currentAdapter.current?.subscribe?.(data => { if (active) ownedWindow.postMessage({ channel, lifecycle: 'state.changed', data }, '*'); }, error => { if (active) setError(error.message); });
        }
        return;
      }
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
        else if (method === 'tasks.watch') {
          if (!runtime?.watchTask) throw new Error('plugin_task_watch_unavailable');
          if (typeof args?.watchId !== 'string' || args.watchId.length > 100 || typeof args?.id !== 'string' || !args.id || args.id.length > 200) throw new Error('invalid_task_watch');
          if (!taskWatches.has(args.watchId) && taskWatches.size >= 16) throw new Error('plugin_task_watch_limit');
          const watchId = args.watchId;
          taskWatches.get(watchId)?.();
          taskWatches.set(watchId, runtime.watchTask(args.id,
            task => { if (active) target.postMessage({ channel, taskWatch: watchId, task }, '*'); },
            error => { if (active) target.postMessage({ channel, taskWatch: watchId, error: error.message }, '*'); }));
          result = { watching: true };
        }
        else if (method === 'tasks.unwatch') { const watchId = args?.watchId; taskWatches.get(watchId)?.(); taskWatches.delete(watchId); result = { watching: false }; }
        else if (method === 'queries.watch') {
          if (!runtime?.observeQuery) throw new Error('plugin_query_watch_unavailable');
          if (typeof args?.watchId !== 'string' || !args.watchId.startsWith('query:') || args.watchId.length > 100 || typeof args.method !== 'string' || args.method.length > 100 || !args.args || typeof args.args !== 'object' || Array.isArray(args.args)) throw new Error('invalid_query_watch');
          if (!taskWatches.has(args.watchId) && taskWatches.size >= 16) throw new Error('plugin_query_watch_limit');
          const watchId = args.watchId;
          taskWatches.get(watchId)?.();
          taskWatches.set(watchId, runtime.observeQuery(args.method, args.args,
            value => { if (active) target.postMessage({ channel, taskWatch: watchId, task: value }, '*'); },
            error => { if (active) target.postMessage({ channel, taskWatch: watchId, error: error.message }, '*'); }));
          result = { watching: true };
        }
        else if (method === 'queries.unwatch') { const watchId = args?.watchId; if (typeof watchId === 'string' && watchId.startsWith('query:')) { taskWatches.get(watchId)?.(); taskWatches.delete(watchId); } result = { watching: false }; }
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
    resize.observe(ownedFrame);
    const visibility = () => ownedWindow.postMessage({ channel, lifecycle: 'visibilityChanged', data: !window.document.hidden }, '*');
    window.document.addEventListener('visibilitychange', visibility);
    return () => { active = false; ownedWindow.postMessage({ channel, lifecycle: 'dispose' }, '*'); unsubscribe?.(); for (const stop of taskWatches.values()) stop(); taskWatches.clear(); controller.abort(); observer.disconnect(); resize.disconnect(); window.removeEventListener('message', onMessage); window.document.removeEventListener('visibilitychange', visibility); };
  }, [channel, identity, plugin.id, plugin.revision, plugin.manifest?.height, attempt, i18n.language, navigate, document]);
  useEffect(() => { if (adapter) frame.current?.contentWindow?.postMessage({ channel, context: adapter.context }, '*'); }, [adapter?.context, channel]);
  if (error) return <div><p role="alert" className="text-sm text-danger">{t('board.pluginError')} · {error}</p><button type="button" className="mt-2 text-sm text-accent underline" onClick={() => setAttempt(value => value + 1)}>{t('board.retry')}</button></div>;
  if (document === undefined) return <PageLoader contained label={t('board.loading')} />;
  return <iframe key={channel} ref={frame} title={plugin.manifest?.name ?? plugin.id} srcDoc={document} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="block w-full border-0" style={{ height }} />;
}

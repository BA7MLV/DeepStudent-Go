import { useEffect, useRef } from 'react';

/**
 * 当前要执行的焦点动作。`nonce` 让「同一个目标」再点一次也能重新跑一遍
 * （例如选区提问连续两次 compose，光标都回到同一个输入框）。
 */
export interface FocusRequest {
  kind: 'composer';
  nonce: number;
}

/**
 * 把焦点请求转成 effect 执行。
 *
 * 为什么不让调用方直接调 `input.focus()`：选区提问的投递来自一个从头到尾都存在的
 * effect 通道（要能被挂在 `[pendingAsk]` 上消费，否则订阅会在组件身份变化时重建），
 * 而输入框句柄在子组件手里、只存在于一次渲染的快照里。调用方只写「请求」，
 * 由真正拿得到句柄的这一帧去聚焦 —— 时序与直接调用一致（同一次提交之后）。
 */
export function FocusEffect({ request, onFocus }: { request: FocusRequest | null; onFocus: (request: FocusRequest) => void }) {
  const latest = useRef({ request, onFocus });
  latest.current = { request, onFocus };
  useEffect(() => {
    if (!request) return;
    latest.current.onFocus(request);
  }, [request]);
  return null;
}

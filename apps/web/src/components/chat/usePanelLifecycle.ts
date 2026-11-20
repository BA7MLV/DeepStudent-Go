import { useEffect, useMemo, useRef } from 'react';
import { accountLifecycle } from '../../client/account-lifecycle';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 面板生命周期里的两个小件。
 *
 * 放在独立文件是因为它们与业务状态机无关：一个是「账号注销/切号时清空」的订阅，
 * 一个是「哪条被中断的回答该挂继续按钮」的派生值 —— 混进面板正文只会让人误以为
 * 它们参与发送流程。
 */

/** 账号注销 / 切号时清空面板。清理函数读的都是 ref 与稳定的 setter，所以只在挂载时订阅一次。 */
export function useAccountReset(clear: () => void, abortInflight: () => void) {
  // 用 ref 转一层：调用方每次渲染都传新闭包，但订阅只建一次（与原先 [] 依赖等价）
  const latest = useRef({ clear, abortInflight });
  latest.current = { clear, abortInflight };
  useEffect(() => {
    const off = accountLifecycle.onDisposed(() => latest.current.clear());
    return () => { off(); latest.current.abortInflight(); };
  }, []);
}

/**
 * 「继续」按钮只挂在最后一条被中断的回答上：更早的那些后面已经有消息，
 * 再给按钮会让人在历史中间触发一次重复重试。
 */
export function useLatestInterruptedKey(msgs: ChatMsg[]) {
  return useMemo(
    () => [...msgs].reverse().find((message) => message.role === 'ai' && message.interrupted && !message.streaming)?.key,
    [msgs],
  );
}

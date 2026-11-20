import { ChatPanelBody, type ChatPanelProps } from './chat/ChatPanelBody';

export type { ChatPanelProps };

/**
 * 课程问答面板。
 *
 * 组件身份留在这一层：`Player.tsx` 按会话/材料维度挂载它，内部状态（消息、滚动、草稿）
 * 全部归 `ChatPanelBody`；这里只做入口与 props 透传，避免页面层为了拆分而改 import 形状。
 */
export default function ChatPanel(props: ChatPanelProps) {
  return <ChatPanelBody {...props} />;
}

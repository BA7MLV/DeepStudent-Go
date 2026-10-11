export type ViewId =
  | "chat-v2"
  | "learning-hub"
  | "todo"
  | "skills-management"
  | "flashcards"
  | "settings";

export type Theme = "light" | "dark";
export type IconName = "sparkle" | "book" | "check" | "sparkle-two" | "cards" | "stack" | "settings" | "plus" | "search" | "sidebar" | "menu" | "chevron-down" | "sun" | "home" | "folder" | "send" | "arrow-up" | "microphone" | "x" | "paperclip" | "wand" | "brain";

export const viewIds: ViewId[] = ["chat-v2", "learning-hub", "todo", "skills-management", "flashcards", "settings"];
export const navItems: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "chat-v2", label: "对话", icon: "sparkle" },
  { id: "learning-hub", label: "资料库", icon: "book" },
  { id: "todo", label: "待办", icon: "check" },
  { id: "skills-management", label: "工具", icon: "sparkle-two" },
  { id: "flashcards", label: "闪卡", icon: "stack" },
];
export const viewTitles: Record<ViewId, string> = {
  "chat-v2": "",
  "learning-hub": "资料库",
  todo: "待办",
  "skills-management": "工具",
  flashcards: "闪卡",
  settings: "设置",
};
export const quickPrompts: Array<{ label: string; icon: IconName }> = [
  { label: "复习课程", icon: "book" },
  { label: "整理笔记", icon: "book" },
  { label: "解释概念", icon: "brain" },
  { label: "生成闪卡", icon: "cards" },
  { label: "制定计划", icon: "check" },
  { label: "总结资料", icon: "stack" },
  { label: "新建对话", icon: "sparkle" },
];

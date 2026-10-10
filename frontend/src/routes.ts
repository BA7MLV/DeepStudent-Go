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
  { id: "learning-hub", label: "资料", icon: "book" },
  { id: "todo", label: "任务", icon: "check" },
  { id: "skills-management", label: "技能", icon: "sparkle-two" },
  { id: "flashcards", label: "卡片", icon: "stack" },
];
export const viewTitles: Record<ViewId, string> = {
  "chat-v2": "",
  "learning-hub": "资料",
  todo: "任务",
  "skills-management": "技能",
  flashcards: "卡片",
  settings: "设置",
};
export const quickPrompts: Array<{ label: string; icon: IconName }> = [
  { label: "复习今天的课程", icon: "book" },
  { label: "整理一份学习笔记", icon: "book" },
  { label: "解释一个概念", icon: "brain" },
  { label: "生成知识点卡片", icon: "cards" },
  { label: "制定复习计划", icon: "check" },
  { label: "总结这段资料", icon: "stack" },
  { label: "创建学习线程", icon: "sparkle" },
];

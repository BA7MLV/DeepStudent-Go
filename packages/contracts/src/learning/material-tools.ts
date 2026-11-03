import { learningAction as action, learningPackage } from './package.js';
export const MATERIAL_TASK_ACTIONS = [
  { id: 'handout', title: '生成讲义/摘要', note: '视频讲义需要浏览器；文档使用原文字讲义执行器。' },
  { id: 'comments', title: '生成评论', note: '重新生成会替换原评论。' },
  { id: 'danmaku', title: '生成弹幕', note: '重新生成会替换原弹幕。' },
  { id: 'transcribe', title: '处理字幕', note: '需要浏览器媒体处理；沿用原字幕优先及断点逻辑。' },
  { id: 'material', title: '重新解析资料', note: 'PDF 需要浏览器；Markdown/Word 使用原服务端解析器。' },
  { id: 'cover', title: '重新生成封面', note: '需要浏览器画布/媒体能力，会替换原派生封面。' },
] as const;
export const MATERIAL_TOOLS_PLUGIN = learningPackage('material-tools', '资料处理', ['context', 'learning', 'tasks'], Object.fromEntries(MATERIAL_TASK_ACTIONS.map(a => [a.id, action(a.title, `material.${a.id}`)])));

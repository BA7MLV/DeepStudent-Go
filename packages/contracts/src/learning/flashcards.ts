import { learningAction as action, learningPackage } from './package.js';
export const FLASHCARDS_PLUGIN = learningPackage('flashcards', '学习卡片', ['state', 'context', 'learning', 'tasks'], {
  list: action('查看卡片', 'cards.list'), generate: action('生成卡片', 'cards.generate'), update: action('审核卡片', 'cards.update'),
});

import { learningAction as action, learningPackage } from './package.js';
export const REVIEW_PLUGIN = learningPackage('review', '复习清单', ['state', 'context', 'learning'], {
  list: action('查看复习', 'review.list'), present: action('开始复习', 'review.present'), get: action('读取复习快照', 'practice.get'), submit: action('提交复习答案', 'practice.submit'),
}, { practice: 2 }, '集中查看错题、到期复习和学习进度');

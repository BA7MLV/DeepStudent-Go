import { learningAction as action, learningPackage } from './package.js';
export const PRACTICE_PLUGIN = learningPackage('practice', '练习', ['state', 'context', 'learning', 'tasks'], {
  list: action('查看练习记录', 'practice.list'), get: action('读取练习快照', 'practice.get'), generate: action('生成练习', 'practice.generate'),
  present: action('打开原题', 'practice.present'), submit: action('提交答案', 'practice.submit'), extract: action('提取原题为题库（需要浏览器工作器）', 'practice.extract'),
}, undefined, '从资料生成练习，或打开原题并保留作答记录');

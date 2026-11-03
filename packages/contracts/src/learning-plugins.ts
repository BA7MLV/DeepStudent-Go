import { FLASHCARDS_PLUGIN } from './learning/flashcards.js';
import { PRACTICE_PLUGIN } from './learning/practice.js';
import { REVIEW_PLUGIN } from './learning/review.js';
import { MATERIAL_TOOLS_PLUGIN } from './learning/material-tools.js';
export { FLASHCARDS_PLUGIN, PRACTICE_PLUGIN, REVIEW_PLUGIN, MATERIAL_TOOLS_PLUGIN };
export { MATERIAL_TASK_ACTIONS } from './learning/material-tools.js';

/** Compile-time descriptors, shared by native action and lazy-view providers. */
export const INSTALLED_LEARNING_PLUGINS = [FLASHCARDS_PLUGIN, PRACTICE_PLUGIN, REVIEW_PLUGIN, MATERIAL_TOOLS_PLUGIN];
export const LEARNING_PLUGINS = INSTALLED_LEARNING_PLUGINS;
/** Legacy executor admission belongs to the package, not to a page or RPC branch. */
export const LEARNING_TASK_PROVIDERS: Record<string, string> = {
  cards: FLASHCARDS_PLUGIN.id,
  ...Object.fromEntries(['handout', 'handoutEdit', 'comments', 'danmaku', 'transcribe', 'material', 'cover'].map(kind => [kind, MATERIAL_TOOLS_PLUGIN.id])),
};
export function learningTaskProvider(kind: string, input: Record<string, unknown> = {}) {
  return LEARNING_TASK_PROVIDERS[kind] ?? (input.pluginPractice === true || input.pluginExtraction === true ? PRACTICE_PLUGIN.id : undefined);
}

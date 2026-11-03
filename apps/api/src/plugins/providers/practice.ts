import { PRACTICE_PLUGIN } from '@wangke/contracts/learning-plugins';
import { materialResolver } from '../learning.js';
import { registerPracticeActions } from '../practice.js';
import { registerPracticeExtraction } from '../practice-extraction.js';
import type { PluginService } from '../service.js';

export const practiceProvider = {
  package: PRACTICE_PLUGIN,
  setup(service: PluginService) {
    const resolveMaterial = materialResolver(service);
    registerPracticeActions(service, resolveMaterial);
    registerPracticeExtraction(service, resolveMaterial);
  },
};

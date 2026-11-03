import { MATERIAL_TOOLS_PLUGIN } from '@wangke/contracts/learning-plugins';
import { materialResolver } from '../learning.js';
import { registerMaterialActions } from '../material-actions.js';
import type { PluginService } from '../service.js';

export const materialToolsProvider = {
  package: MATERIAL_TOOLS_PLUGIN,
  setup(service: PluginService) { registerMaterialActions(service, materialResolver(service)); },
};

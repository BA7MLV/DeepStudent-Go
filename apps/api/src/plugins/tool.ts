import { PLUGINS_TOOL } from '@wangke/contracts/plugins';
import type { StudyToolPlugin } from '../agent/study.js';
import type { PluginService } from './service.js';

/** Mutating calls retain ordinary learning-policy approval, unlike system file edits. */
export function pluginTool(service: PluginService): StudyToolPlugin {
  const write = (a: Record<string, unknown>) => ['configure', 'invoke', 'lifecycle'].includes(String(a.operation));
  return {
    name: 'plugins', description: PLUGINS_TOOL.function.description,
    properties: PLUGINS_TOOL.function.parameters.properties, required: ['operation'],
    capability: a => write(a) ? 'write' : 'read',
    permissions: a => write(a) ? ['read', 'write'] : ['read'],
    parallelSafe: a => !write(a),
    execute: async (a, c) => service.tool(c.owner, a, c.checkActive),
  };
}

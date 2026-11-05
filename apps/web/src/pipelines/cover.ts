import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';

export async function ensureCover(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
  await assertPluginAvailable('material-tools');
  return runMaterialPluginTask('cover', id, undefined, undefined, { force: opts.force ?? false });
}

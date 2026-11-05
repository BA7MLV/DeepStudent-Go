import { getMaterialFile } from '../store/fileStore';
import { useLibraryRevision } from '../pipelines/folderPlan';
import { resourceCommand } from '../client/resources';
import { flushCloud } from '../cloud/sync';
import type { MaterialParseResult } from './reindex';

/** Ordinary Markdown persistence shared by editor and tools; server owns file and index. */
export async function saveMarkdownMaterial(id: string, text: string, expected?: string, name?: string,
  creation?: { folderId?: number; createOnly?: boolean }) {
  const current = expected ?? await (await getMaterialFile(id))?.text() ?? '';
  const operation = { kind: 'saveMarkdown' as const, courseId: id, text, expected: current, ...(name ? { name } : {}), ...creation };
  const result = await resourceCommand(operation);
  await flushCloud();
  useLibraryRevision.getState().bump();
  return result as unknown as MaterialParseResult;
}

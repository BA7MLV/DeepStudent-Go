import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator';

// The generator resolves its own pinned TS6 compiler API. Application tsc remains TS7.
const root = path.resolve(import.meta.dirname, '..');
const artifacts = new WorkspaceTypertGenerator(root, { rejectBuildOutputs: true }).generate(['@wangke/remote-host'], ['host']);
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('remote_artifacts_missing');
const artifact = artifacts[0];
const files = new Map();
for (const [name, content] of [
  ['typert.host.js', artifact.js], ['typert.host.d.ts', artifact.dts],
  ['typert.remote-client.js', artifact.remote.js], ['typert.remote-client.d.ts', artifact.remote.dts],
]) {
  if (typeof content !== 'string') throw new Error(`missing_generated_content:${name}`);
  files.set(name, content);
}
for (const [name, content] of files) {
  const destination = path.join(root, 'packages/remote-artifacts/generated', name);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) throw new Error(`generated_remote_drift:${name}`);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}

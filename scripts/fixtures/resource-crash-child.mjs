import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../../apps/api/src/storage/database.ts';
import { ProjectRepository } from '../../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../../apps/api/src/projects/resources.ts';
import { ProjectFileJournal } from '../../apps/api/src/projects/file-journal.ts';
import { executeResourceCommand, recoverResourceCommands } from '../../apps/api/src/realtime/resources.ts';

const { directory, owner, command, checkpoint } = JSON.parse(process.argv[2]);
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
const projects = new ProjectRepository(store, path.join(directory, 'files/projects'));
const resources = new ResourceFiles(projects, path.join(directory, 'files'));
if (checkpoint === 'prepared') {
  const append = ProjectFileJournal.prototype.append;
  ProjectFileJournal.prototype.append = function (...args) { append.apply(this, args); process.exit(86); };
} else if (checkpoint === 'committed') {
  ProjectFileJournal.prototype.cleanup = () => process.exit(86);
} else if (checkpoint === 'during-rollback') {
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    rename(...args);
    if (String(args[0]).includes('.resource-journal') && String(args[0]).endsWith('.old')) process.exit(86);
  };
  recoverResourceCommands(resources);
  throw new Error('rollback checkpoint not reached');
} else {
  const method = checkpoint;
  const original = projects.files[method].bind(projects.files);
  projects.files[method] = (...args) => { const result = original(...args); process.exit(86); return result; };
}
executeResourceCommand(resources, owner, command);
throw new Error('filesystem checkpoint not reached');

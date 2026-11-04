import { FLASHCARDS_PLUGIN } from '@wangke/contracts/learning-plugins';
import crypto from 'node:crypto';
import { CloudRecords } from '../../cloud/records.js';
import { recordMutation } from '../../cloud/execution.js';
import { taskDto } from '../../cloud/tasks.js';
import { materialResolver } from '../learning.js';
import { cardsRevision, learningCards } from '../learning-results.js';
import type { PluginService } from '../service.js';

const material = { type: 'string', minLength: 1, maxLength: 256 };
const schema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const flashcardsProvider = {
  package: FLASHCARDS_PLUGIN,
  setup(service: PluginService) {
    const { store } = service, records = new CloudRecords(store), resolveMaterial = materialResolver(service);
    service.register({ id: 'cards.list', capability: 'learning', access: 'read', schema: schema({ materialId: material }, []), run: (a, c) => {
      const id = resolveMaterial(a, c), cards = learningCards(store, c.owner, id);
      return { materialId: id, cards, revision: cardsRevision(cards) };
    } });
    service.register({ id: 'cards.update', capability: 'learning', access: 'write', atomic: 'sqlite', schema: schema({ materialId: material, id: { type: 'integer', minimum: 1 }, status: { enum: [0, 1, 2] } }), run: (a, c) => {
      const id = resolveMaterial(a, c), card = records.get(c.owner, 'cards', a.id);
      if (!card || card.videoId !== id) throw new Error('plugin_card_not_found');
      records.apply(c.owner, [recordMutation('cards', card.id, card, { ...card, status: a.status })]);
      return { saved: true };
    } });
    service.register({ id: 'cards.generate', capability: 'learning', access: 'write', atomic: 'sqlite', schema: schema({ materialId: material, clientNonce: { type: 'string', minLength: 1, maxLength: 100 }, replaceRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['materialId', 'clientNonce']), run: (a, c) => {
      const id = resolveMaterial(a, c);
      const request = JSON.stringify({ materialId: id, replaceRevision: a.replaceRevision ?? null });
      const nonce = `plugin:${crypto.createHash('sha256').update(JSON.stringify([c.plugin.id, c.instance.id, 'cards.generate', a.clientNonce])).digest('hex')}`;
      return store.transaction(() => {
        const previous = store.db.prepare('SELECT t.*,l.request FROM cloud_tasks t JOIN plugin_learning_tasks l ON l.task_id=t.id WHERE t.owner_id=? AND t.nonce=?').get(c.owner, nonce) as any;
        if (previous) {
          if (previous.request !== request) throw new Error('plugin_nonce_conflict');
          return taskDto(previous);
        }
        const cards = learningCards(store, c.owner, id), expected = cardsRevision(cards);
        if (cards.length && a.replaceRevision !== expected) throw new Error('plugin_cards_replace_conflict');
        if (a.replaceRevision && a.replaceRevision !== expected) throw new Error('plugin_cards_replace_conflict');
        if (store.db.prepare("SELECT 1 FROM cloud_tasks WHERE owner_id=? AND kind='cards' AND resource=? AND status IN ('queued','running','waiting_user')").get(c.owner, `course:${id}`)) throw new Error('plugin_generation_conflict');
        const taskId = crypto.randomUUID(), now = new Date().toISOString();
        store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,'cards',?,?,'queued',?,?)").run(taskId, c.owner, nonce, `course:${id}`, JSON.stringify(service.files.admitTask(c.owner, 'cards', { videoId: id, expectedCardsRevision: expected })), now, now);
        store.db.prepare('INSERT INTO plugin_learning_tasks(task_id,owner_id,plugin_id,instance_id,action_id,material_id,request) VALUES(?,?,?,?,?,?,?)').run(taskId, c.owner, c.plugin.id, c.instance.id, 'cards.generate', id, request);
        return taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(taskId));
      });
    } });
  },
};

import type { DatabaseStore } from '../storage/database.js';
import { getConfig } from '../config.js';

/** 容量与保留期会由测试在用例内改小并立刻触发清理,因此每次现读 env(惰性)。 */
export const gatewayLimits = () => {
  const settings = getConfig();
  return {
    pending: settings.gatewayPendingLimit,
    dedupe: settings.gatewayDedupeLimit,
    pendingMs: settings.gatewayPendingDays * 86400000,
    bodyMs: settings.gatewayBodyDays * 86400000,
  };
};
export function cleanupGateway(store: DatabaseStore, time = Date.now()) {
  const limits = gatewayLimits();
  store.transaction(() => {
    store.db.prepare("UPDATE gateway_outbox SET status='failed',error='pending_expired' WHERE seq IN (SELECT seq FROM gateway_outbox WHERE status='pending' AND created_at<? LIMIT 100)").run(time - limits.pendingMs);
    // Keep stable IDs and terminal statuses permanently, bounded by a metadata
    // capacity guard. Never discard dedupe identity and accidentally replay IM.
    store.db.prepare("UPDATE gateway_inbox SET envelope='' WHERE id IN (SELECT id FROM gateway_inbox WHERE status IN ('done','cancelled') AND envelope!='' AND received_at<? AND NOT EXISTS(SELECT 1 FROM messages m JOIN runs r ON r.trigger_message_id=m.id WHERE m.client_nonce='im:'||gateway_inbox.id AND r.status IN ('queued','running','waiting_user','paused')) LIMIT 100)").run(time - limits.bodyMs);
    store.db.prepare("UPDATE gateway_outbox SET payload='{}' WHERE seq IN (SELECT seq FROM gateway_outbox WHERE status IN ('sent','cancelled') AND payload!='{}' AND created_at<? LIMIT 100)").run(time - limits.bodyMs);
    store.db.prepare("DELETE FROM bot_artifacts WHERE id IN (SELECT a.id FROM bot_artifacts a JOIN runs r ON r.id=a.run_id WHERE r.status IN ('completed','cancelled','failed') AND a.created_at<? LIMIT 50)").run(new Date(time - limits.bodyMs).toISOString());
    store.db.prepare('DELETE FROM cloud_audit WHERE id IN (SELECT id FROM cloud_audit WHERE created_at<? LIMIT 100)').run(new Date(time - 90 * 86400000).toISOString());
  });
}

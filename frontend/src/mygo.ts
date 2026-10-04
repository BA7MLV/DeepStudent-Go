/**
 * Generated-compatible binding for the first Go bridge service.
 * `mygo generate` can replace this file in a full Go toolchain; keeping the
 * small typed client in source also lets the web shell build outside MyGo.
 */
import { call } from "mygo-runtime";

export {
  createRuntimeSession,
  createSession,
  getRuntimeReadiness,
  getRuntimeSessionMessages,
  getSessionMessages,
  getSessions,
  listRuntimeSessions,
  normalizeRuntimeBaseUrl,
  postRuntimeSessionMessage,
  postSessionMessage,
  runtimeApiBaseUrl,
  runtimeApiUrl,
  runtimeAttachmentUrl,
  RuntimeApiError,
  type RuntimeApiOptions,
  type RuntimeAttachment,
  type RuntimeFetch,
  type RuntimeMessage,
  type RuntimeReadiness,
  type RuntimeRunStart,
  type RuntimeSession,
  type RuntimeSessionMessageInput,
  uploadRuntimeAttachment,
} from "./runtime-api";

export interface HealthStatus {
  status: string;
  runtime: string;
  startedAt: string;
}

export const HealthService = {
  health: () => call<HealthStatus>("HealthService.Health"),
};

/**
 * Generated-compatible binding for the first Go bridge service.
 * `mygo generate` can replace this file in a full Go toolchain; keeping the
 * small typed client in source also lets the web shell build outside MyGo.
 */
import { call } from "mygo-runtime";

export interface HealthStatus {
  status: string;
  runtime: string;
  startedAt: string;
}

export const HealthService = {
  health: () => call<HealthStatus>("HealthService.Health"),
};

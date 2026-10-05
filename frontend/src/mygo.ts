/** Generated MyGo TypeScript bindings. Regenerate with `mygo generate`. */
import { call } from "mygo-runtime";

export interface HealthStatus {
  status: string;
  runtime: string;
  startedAt: string;
}

export const HealthService = {
  health: () => call<HealthStatus>("HealthService.Health"),
};

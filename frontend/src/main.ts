import { HealthService } from "./mygo";

const status = document.querySelector<HTMLParagraphElement>("#status");

if (status) {
  const health = await HealthService.health();
  status.textContent = `${health.runtime} runtime: ${health.status}`;
}

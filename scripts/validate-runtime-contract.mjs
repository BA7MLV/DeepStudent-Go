import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const protocol = await readFile(new URL("../protocol/runtime-v1.md", import.meta.url), "utf8");
const bridge = await readFile(new URL("../frontend/src/mygo.ts", import.meta.url), "utf8");

const examples = [...protocol.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) =>
  JSON.parse(match[1]),
);
assert.ok(examples.length >= 2, "runtime.v1 must contain request and event examples");

const request = examples.find((example) => example.method === "runtime.health");
const event = examples.find((example) => example.type === "runtime.health.result");
assert.ok(request, "runtime.v1 must contain a runtime.health request example");
assert.ok(event, "runtime.v1 must contain a runtime.health.result event example");
assert.equal(request.version, "deepstudent.runtime.v1");
assert.equal(event.version, request.version);
assert.equal(request.id, event.id, "the result must correlate to the request id");
assert.equal(request.method, "runtime.health");
assert.equal(event.type, "runtime.health.result");
assert.deepEqual(Object.keys(event.data).sort(), ["runtime", "startedAt", "status"]);
assert.match(event.data.startedAt, /^\d{4}-\d\d-\d\dT.*Z$/, "startedAt must be an RFC3339 UTC example");

for (const field of ["status", "runtime", "startedAt"]) {
  assert.match(bridge, new RegExp(`\\b${field}\\??:`), `HealthStatus must expose ${field}`);
}
assert.match(bridge, /call<HealthStatus>\("HealthService\.Health"\)/);

console.log("runtime.v1 contract examples and MyGo health bridge are aligned");

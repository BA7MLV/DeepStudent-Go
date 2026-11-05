import { setTimeout } from 'node:timers/promises';

// Some Playwright builds accept an async predicate's Promise as truthy. Await
// evaluate on the Node side so a database predicate must actually become true.
export async function waitForProbe(page, predicate, argument, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    if (await page.evaluate(predicate, argument)) return;
    await setTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`Probe did not converge: ${predicate}`);
}

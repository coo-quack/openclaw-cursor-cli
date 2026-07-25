/**
 * The one property of the integration harness that has to hold everywhere.
 *
 * This lives in the unit suite, not beside the integration tests, because the
 * integration suite skips itself wherever `openclaw` is absent — which is
 * exactly the developer machine where the mistake it guards against would cost
 * money. `npm run check` runs it on every change.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandbox } from "./integration/harness.ts";

test("a sandbox never carries CURSOR_API_KEY to the backend", () => {
  // `cursor-agent status` prints "Not logged in" whether or not this is set
  // (measured), so the suite's skip guard cannot see it. A developer who
  // exports it would sail past the guard, run the real binary, authenticate,
  // and spend live quota on a turn the test only ever wanted to fail.
  const before = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "not-a-real-key-0000";
  const sandbox = createSandbox();
  try {
    assert.equal(
      sandbox.env.CURSOR_API_KEY,
      undefined,
      "the sandbox would hand cursor-agent working credentials",
    );
    // The rest of the environment still has to come through, or the suite
    // cannot find the binaries it runs.
    assert.equal(sandbox.env.PATH, process.env.PATH);
  } finally {
    sandbox.cleanup();
    if (before === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = before;
  }
});

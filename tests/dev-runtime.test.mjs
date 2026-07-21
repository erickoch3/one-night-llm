import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  buildChildEnvironment,
  findAvailablePort,
  parsePreferredPort,
  portIsAvailable,
} from "../scripts/dev-runtime.mjs";

test("the dev runtime validates the preferred API port", () => {
  assert.equal(parsePreferredPort("4318"), 4318);
  for (const value of ["", "0", "65536", "3.14", "not-a-port"]) {
    assert.throws(() => parsePreferredPort(value), /ONE_NIGHT_API_PORT/);
  }
});

test("the dev runtime scans upward and keeps both child processes paired", async () => {
  const checked = [];
  const selected = await findAvailablePort(4318, {
    isAvailable: async (port) => {
      checked.push(port);
      return port === 4320;
    },
  });

  assert.equal(selected, 4320);
  assert.deepEqual(checked, [4318, 4319, 4320]);
  assert.deepEqual(
    buildChildEnvironment(
      {
        KEEP_ME: "yes",
        ONE_NIGHT_API_PORT: "4318",
        NEXT_PUBLIC_GAME_API_URL: "http://localhost:9999",
      },
      selected,
    ),
    {
      KEEP_ME: "yes",
      ONE_NIGHT_API_PORT: "4320",
      NEXT_PUBLIC_GAME_API_URL: "http://localhost:4320",
    },
  );
});

test("the real port probe notices an occupied loopback port", async (context) => {
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  context.after(() => new Promise((resolve) => blocker.close(resolve)));

  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  assert.equal(await portIsAvailable(address.port), false);
});

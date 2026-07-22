import { describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const DEV_SERVER_SHUTDOWN_TIMEOUT_MS = 360_000;
// The signal-to-exit window. Comfortable for slow CI, yet far below the
// disabled backstop so a leaked handle cannot masquerade as a clean exit.
const GRACEFUL_EXIT_DEADLINE_MS = 20_000;

describe("eve dev shutdown", () => {
  // The backstop that force-exits on a leaked handle is pushed far out so it
  // cannot rescue this test: the process must drain the event loop on its own
  // after the signal. A regression that leaks a handle leaves the process
  // alive until the harness escalates to SIGKILL, which the assertions catch.
  const env = { EVE_EXIT_BACKSTOP_MS: "120000" } as const;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(
      `drains and exits on its own after ${signal} without a forced kill`,
      async () => {
        const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
        const server = await startEveDev(app.appRoot, { env });

        const exit = await server.signalAndAwaitExit(signal, GRACEFUL_EXIT_DEADLINE_MS);

        expect(
          exit.forcedKill,
          `eve dev did not exit within ${GRACEFUL_EXIT_DEADLINE_MS}ms of ${signal}; ` +
            `a leaked handle kept the event loop alive.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        ).toBe(false);
        // A graceful drain exits normally; it is never killed by its own signal.
        expect(exit.signal).toBe(null);
        expect(exit.code).toBe(0);
      },
      DEV_SERVER_SHUTDOWN_TIMEOUT_MS,
    );
  }
});

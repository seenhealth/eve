import { reportDevExitDiagnostics } from "#cli/dev/exit-diagnostics.js";
import type { ProductionServerHandle } from "#internal/nitro/host/types.js";

export interface DevShutdownController {
  /** Aborts on the first SIGINT/SIGTERM so the interactive TUI can unwind. */
  readonly signal: AbortSignal;
  /** Resolves on the first SIGINT/SIGTERM; used by the headless wait loop. */
  readonly firstSignal: Promise<void>;
  /** Removes the process handlers once the command completes normally. */
  dispose(): void;
}

/**
 * Installs the single SIGINT/SIGTERM handler for `eve dev`. Both modes route
 * through it: the first signal begins a graceful shutdown (aborting `signal`
 * and resolving `firstSignal`); a second signal — which reaches us once the
 * TUI has restored the terminal, exactly the "press Ctrl+C again" case —
 * reports any lingering handles and exits deterministically instead of falling
 * through to Node's default hard-kill.
 */
export function installDevShutdownController(): DevShutdownController {
  const controller = new AbortController();
  let resolveFirstSignal: () => void = () => {};
  const firstSignal = new Promise<void>((resolve) => {
    resolveFirstSignal = resolve;
  });
  let signalCount = 0;
  const handleSignal = (signalName: NodeJS.Signals) => {
    signalCount += 1;
    if (signalCount === 1) {
      controller.abort();
      resolveFirstSignal();
      return;
    }
    reportDevExitDiagnostics(`received ${signalName} during shutdown`);
    process.exit(130);
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    firstSignal,
    dispose: () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

/**
 * Resolves on the first SIGINT/SIGTERM after closing the supplied handle. Used
 * by the production `eve start` server, which has no interactive UI to unwind.
 */
export async function waitForShutdownSignal(input: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    };

    const handleSignal = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      void input.close().then(resolve, reject);
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  });
}

/** Runs the production server until it stops on its own or a signal arrives. */
export async function waitForProductionServer(input: ProductionServerHandle): Promise<void> {
  await Promise.race([
    input.wait(),
    waitForShutdownSignal({
      close: () => input.close(),
    }),
  ]);
}

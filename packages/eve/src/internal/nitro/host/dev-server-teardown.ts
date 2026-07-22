import type { Nitro } from "nitro/types";

import type { AuthoredSourceWatcherHandle } from "#internal/nitro/host/dev-authored-source-watcher.js";
import { DrainedNitroDevServer } from "#internal/nitro/host/drained-nitro-dev-server.js";
import { stopDevelopmentSandboxResources } from "#execution/sandbox/bindings/local.js";
import type { ParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-server.js";
import { toErrorMessage } from "#shared/errors.js";

// A single hung teardown step (a wedged docker call, an unresponsive worker)
// must never block `eve dev` from exiting. Each step is bounded; a step that
// overruns is recorded as an error and shutdown continues, leaving the
// guarded backstop in `bin/eve.js` to reap any residual handle.
const DEVELOPMENT_TEARDOWN_STEP_TIMEOUT_MS = 5_000;
// Background work is signalled to abort first, so this only bounds the tail of
// an operation that cannot be interrupted at a checkpoint (e.g. an in-flight
// backend prewarm subprocess).
const DEVELOPMENT_BACKGROUND_DRAIN_TIMEOUT_MS = 3_000;

/** Resolves when `operation` settles or `ms` elapses; the timer never holds the loop open. */
async function settleWithinDeadline(operation: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Aborts and drains the dev server's background work, then closes each owned
 * resource under a per-step deadline. Errors (including timeouts) are collected
 * rather than thrown so one wedged step cannot strand the others — the caller
 * decides how to surface them.
 */
export async function closeDevelopmentServerResources(input: {
  readonly appRoot: string;
  readonly authoredSourceWatcher: AuthoredSourceWatcherHandle | undefined;
  readonly backgroundController: AbortController;
  readonly backgroundTasks: ReadonlySet<Promise<void>>;
  readonly devServer: DrainedNitroDevServer | undefined;
  readonly developmentSandboxRunId: string;
  readonly nitro: Nitro | undefined;
  readonly workflowWorld: ParentDevelopmentWorkflowWorld | undefined;
}): Promise<{ readonly errors: readonly unknown[]; readonly listenerClosed: boolean }> {
  const errors: unknown[] = [];
  const attempt = async (label: string, operation: () => Promise<void>): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out after ${DEVELOPMENT_TEARDOWN_STEP_TIMEOUT_MS}ms closing development ${label}.`,
                ),
              ),
            DEVELOPMENT_TEARDOWN_STEP_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  // Signal fire-and-forget work to stop, then drain it before tearing down the
  // resources it may still be touching (sandbox templates, the worker pool).
  input.backgroundController.abort();
  if (input.backgroundTasks.size > 0) {
    await settleWithinDeadline(
      Promise.allSettled(input.backgroundTasks),
      DEVELOPMENT_BACKGROUND_DRAIN_TIMEOUT_MS,
    );
  }

  const authoredSourceWatcher = input.authoredSourceWatcher;
  if (authoredSourceWatcher !== undefined) {
    await attempt("file watcher", () => authoredSourceWatcher.close());
  }
  // Close the workflow world and the HTTP listener it delivers to together.
  // Order within the pair matters and is guaranteed by argument evaluation:
  // the world's close() synchronously aborts the queue's close signal before
  // its first await, so by the time the listener destroys an in-flight
  // delivery socket, the queue treats the resulting hang-up as shutdown and
  // stays silent (no spurious "Queue message failed … socket hang up").
  // Running them concurrently — rather than world-then-server — is what keeps
  // exit near-instant: destroying the socket lets the queue's undici agent
  // close immediately instead of draining a delivery to a turn that the
  // interrupt left running on the server.
  const workflowWorld = input.workflowWorld;
  const devServer = input.devServer;
  const [, listenerClosed] = await Promise.all([
    workflowWorld === undefined
      ? Promise.resolve(true)
      : attempt("workflow world", () => workflowWorld.close()),
    devServer === undefined ? Promise.resolve(true) : attempt("server", () => devServer.close()),
  ]);
  const nitro = input.nitro;
  if (nitro !== undefined) {
    await attempt("bundler", () => nitro.close());
  }
  await attempt("sandbox resources", () =>
    stopDevelopmentSandboxResources({
      appRoot: input.appRoot,
      devRunId: input.developmentSandboxRunId,
      log: (message) => console.warn(`[eve:dev] ${message}`),
    }),
  );

  return { errors, listenerClosed };
}

/** Collapses collected teardown errors into a single throwable, or undefined when clean. */
export function createDevelopmentServerCleanupError(errors: readonly unknown[]): Error | undefined {
  if (errors.length === 0) {
    return undefined;
  }

  if (errors.length === 1) {
    const error = errors[0];
    return error instanceof Error
      ? error
      : new Error(`Failed to close the development server: ${toErrorMessage(error)}`, {
          cause: error,
        });
  }

  return new AggregateError(errors, "Multiple development-server resources failed to close.");
}

/** Wraps a startup failure together with any cleanup errors that followed it. */
export function createDevelopmentServerStartupCleanupError(
  startupError: unknown,
  cleanupErrors: readonly unknown[],
): AggregateError {
  return new AggregateError(
    [startupError, ...cleanupErrors],
    `${toErrorMessage(startupError)} Cleanup also failed.`,
    { cause: startupError },
  );
}

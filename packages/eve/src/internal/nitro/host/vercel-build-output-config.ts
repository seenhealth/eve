import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createEveWorkflowQueueTrigger } from "#internal/workflow/queue-namespace.js";

/** Route Nitro's Vercel preset emits as the queue-triggered workflow function. */
export const EVE_WORKFLOW_FLOW_ROUTE_PATH = "/.well-known/workflow/v1/flow";

/**
 * Builds eve's Vercel preset options.
 *
 * The flow route's `functionRules` entry makes Nitro emit a dedicated
 * `flow.func` from the same build output, carrying the agent's queue trigger
 * and an extended execution window. Every other function setting (runtime,
 * memory, streaming) is inherited from the base server function config.
 */
export function createEveVercelOptions(input: { agentName: string; enabled: boolean }) {
  if (!input.enabled) {
    return undefined;
  }

  return {
    config: {
      version: 3 as const,
      framework: {
        slug: EVE_PACKAGE_NAME,
        version: resolveInstalledPackageInfo().version,
      },
    },
    functionRules: {
      [EVE_WORKFLOW_FLOW_ROUTE_PATH]: {
        maxDuration: "max" as const,
        experimentalTriggers: [createEveWorkflowQueueTrigger(input.agentName)],
        environment: {
          // Reject replay decisions made from an event log that missed a
          // concurrent wake.
          WORKFLOW_PRECONDITION_GUARD: "1",
        },
      },
    },
  };
}

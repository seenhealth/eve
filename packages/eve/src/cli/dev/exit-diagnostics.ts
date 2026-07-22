/**
 * Shutdown diagnostics for `eve dev`. The dev command must drain the event
 * loop on its own after a signal; when it does not, this reports what is still
 * keeping the process alive so an intermittent hang can be reproduced and
 * traced. Gated on `EVE_DEV_TRACE_EXIT` so ordinary sessions stay quiet.
 */

/** Whether shutdown diagnostics are enabled via `EVE_DEV_TRACE_EXIT`. */
export function isDevExitTraceEnabled(): boolean {
  return Boolean(process.env.EVE_DEV_TRACE_EXIT?.trim());
}

/**
 * The kinds of handles/requests still registered with the event loop, by
 * count. Empty when the runtime does not expose `getActiveResourcesInfo`
 * (added in Node 17.3) or nothing remains.
 */
export function summarizeActiveResources(): string {
  const info = process.getActiveResourcesInfo?.();
  if (info === undefined || info.length === 0) {
    return "none";
  }
  const counts = new Map<string, number>();
  for (const resource of info) {
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}

/** Reports the active resources keeping the loop alive, when tracing is on. */
export function reportDevExitDiagnostics(reason: string): void {
  if (!isDevExitTraceEnabled()) {
    return;
  }
  console.error(`[eve:dev] ${reason}; active resources: ${summarizeActiveResources()}`);
}

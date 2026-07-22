---
"eve": patch
---

Fix `eve dev` sometimes needing multiple Ctrl+C presses to exit. Background sandbox prewarm/prune are now owned and aborted on shutdown, teardown steps are individually time-bounded, and every dev mode (interactive, headless, remote) shares one SIGINT/SIGTERM handler so the process drains and exits on its own after a single signal. Shutdown now closes the workflow world and the HTTP listener concurrently — aborting the queue before its in-flight delivery socket is destroyed — and the dev server no longer writes an error response for a request whose worker was torn down mid-flight, so interrupting a turn and exiting is near-instant and no longer prints a spurious `[world-local] Queue message failed … socket hang up`.

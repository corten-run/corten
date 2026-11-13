# Incomplete native Laravel live-port checkpoint

This directory is paused work in progress, not a delivered, registered or
qualified live/recovery application. Do not use this checkpoint as parity,
readiness, browser-correctness or measurement evidence. It is separate from the
completed fullstack Laravel marketplace alert implementation.

The existing scaffold uses installed Laravel, Livewire components and Reverb
broadcasting, with a native file-cache lock for cross-process synthetic state.
Its PHP dependency manifest and lock retain the fullstack application's existing
native dependencies. The JavaScript lock includes Laravel Echo and Pusher's client
for Reverb's actual native protocol, plus esbuild; these are intended native
clients, not an EventSource substitute or a shared renderer.

Known unfinished work:

- The browser client and its installed Livewire asset integration are absent.
  The Dockerfile currently expects the missing `client.js`; a full application
  image has not been built or verified.
- State currently advances before browser DOM acknowledgement. Staged state and
  actual browser-cursor/effect reconciliation must be implemented before recovery
  can be correct.
- Per-consumer teardown/readbacks, publication-acknowledgement ordering and native
  reconnect/resnapshot behavior still require implementation and validation.
- Native Reverb lifecycle integration and startup/cleanup topology are unverified.
- Raw native wire bindings, browser journeys, adversarial tests and native store
  tests are absent. No runtime or measurement qualification has been established.

This checkpoint preserves existing work without expanding it while the separately
committed Rails/Phoenix recovery and Laravel fullstack rounding repairs undergo
independent review. Syntax checks alone do not close any of the above limits.

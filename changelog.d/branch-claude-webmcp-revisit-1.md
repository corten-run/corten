- `docs/architecture.md` (Agents) records what WebMCP does with a Corten page in Chromium 159:
  a tool a script registers and a form with `toolname` work as they are, and a `data-patch`
  form is not to be a tool yet, since the agent's call fails after the write is made.
  ([#695 WebMCP: wait for the declarative form API before Corten offers anything, and record when to revisit](https://github.com/corten-run/corten/issues/695))

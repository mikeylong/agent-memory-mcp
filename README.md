# agent-memory-mcp (retired)

> [!WARNING]
> This project was retired in July 2026. Do not install it or add it to new
> agent workflows. The repository remains available for reference and for
> removing existing installations.

## Why it was retired

A live-system audit found that the always-on memory loop created more noise
than useful recall:

- 90% of active records came from automatic turn capture.
- 82% of a reviewed sample was ephemeral rather than durable memory.
- Retrieval regularly returned repeated, stale, or irrelevant material.
- Automated session imports could place content under the wrong project.

Current agent clients handle active task context and selective memory well
enough that this extra layer no longer earns its storage, privacy, and
maintenance cost.

## Recommended replacement

- Put required behavior and repository conventions in `AGENTS.md` or checked-in
  documentation.
- Use client-native task history or memory where available.
- Use a small, explicit decision log when multiple clients need shared context.
- Do not automatically capture every turn or import raw conversation history.

## Retiring an existing installation

Before deleting anything:

1. Stop memory automations and session imports.
2. Remove client wrappers, hooks, MCP configuration, and memory-policy blocks
   from `AGENTS.md`.
3. Back up `$HOME/.agent-memory` and treat the backup as sensitive.
4. Export only the durable facts you still need.
5. Verify each client starts cleanly before removing the runtime or database.

Keep the backup until the replacement workflow has been working long enough to
trust it.

## Status

No new features, fixes, or security updates are planned. The code remains
available under the MIT license.

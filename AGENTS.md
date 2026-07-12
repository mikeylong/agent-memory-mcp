# Repository Guidance

This repository is retired. Keep changes limited to decommissioning, security,
data export, or archival maintenance unless the project is explicitly reopened.

- Do not re-enable automatic turn capture, session imports, client wrappers, or
  scheduled memory jobs by default.
- Preserve existing user changes and historical data during retirement work.
- Run `npm run privacy:scan`, `npm run build`, `npm run test:retrieval`, and
  `npm test` when a change touches the archived implementation.

`CLAUDE.md` remains the compatibility shim that imports this file.

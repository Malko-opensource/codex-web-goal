# Contributing

Open an issue to discuss substantial changes before implementing them. Keep bug reports and pull requests
free of private source, tokens, state and real conversation URLs; security reports follow [SECURITY.md](SECURITY.md).

Install Node 22.16+ and run `npm ci`, `npm test`, `npm run build`, and `npm run test:browser`.
Install the matching Chromium using `npx playwright install chromium` before browser tests.
Tests open loopback ports and use temporary directories; restrictive sandboxes may need explicit local-network approval.

This repository builds independently. New behavior needs a regression test, especially changes to
delivery uncertainty, native Goal binding, file boundaries, approvals or local verification state.
Use synthetic browser fixtures by default. Never test against another person's actual chat without authorization.

Do not commit `node_modules`, state directories, backups, real chat screenshots, credentials or generated release bundles.
Update docs when the protocol or support boundary changes. Do not mark a feature live-verified based only on fixture tests.
Use the repository's own license for contributions. Dependencies keep their respective licenses.

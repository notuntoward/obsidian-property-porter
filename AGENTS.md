# Agent Instructions for this Obsidian plugin template

## Build verification rule

This project produces a pre-built artifact (`main.js`) that the Obsidian runtime
loads directly. After editing any source file under `src/`, you MUST:

1. Run `npm run build`.
2. Grep the built `main.js` for a fingerprint of your change to confirm the
   bundle on disk reflects the edit.

Do not declare a task done without grepping the built artifact for evidence.

## Tooling

- Lint: `npm run lint` (ESLint with `eslint-plugin-obsidianmd` rules, zero warnings).
- Type-check + bundle: `npm run build`.
- Unit tests: `npm run test:run` (Vitest). `obsidian` resolves to a mock in
  `tests/__mocks__/obsidian.ts`.
- Browser tests: `npm run test:browser` (Playwright, requires
  `npx playwright install chromium`).

## When building an Obsidian plugin inside a git worktree

If the vault loads this plugin via a junction to the main checkout, a build
inside a worktree is not automatically visible to Obsidian. Re-point the vault
junction with the shared relink script, or finish tests in the worktree and
build in the main checkout. See the global rule in `~/.config/kilo/AGENTS.md`.

# AGENTS.md - Obsidian Plugin Development Rules

## Task scope and validation

Cache exact instructions per checkout/task; read guides only for changed areas.
Restore only missing/changed sections after compaction.
- Docs/instructions-only: text/link/format checks, not application tests/builds,
  browsers, installs or consumer sweeps. This qualifies completion gates below.
- Publication-only: reuse green checks/artifacts for unchanged code, dependencies,
  build inputs AND linked commons; validate unchecked pending source once.
- Source changes: targeted iteration tests, required final checks once; reuse
  composite steps and verify their bundle rather than rebundling.
Keep fresh Git branch/identity/message/hook checks and final remote-tip verification.

## Shared library: commons

Use commons for workspace/window/tab/focus, per-window timers/clipboard, modal,
search, geometry, page-color and line-flash helpers; never duplicate its
undocumented Obsidian adapters in plugin code. For an owned-area change, consult
the installed module exports and relevant commons guide sections. Change commons
with a regression test if needed, never a local copy. Docs/publication-only work
does not require opening the library or rebuilding its consumers.
Local adoption uses file:../obsidian-commons; obey the library's existing
commons-adoption branch and explicit-ref/tag-disabled publication rules.

## Native Obsidian APIs

Prefer fileManager.processFrontMatter, metadataCache.getFileCache (remove
frontmatter.position before copying), vault.cachedRead/process, native createEl
and SuggestModal/FuzzySuggestModal over custom YAML/I/O/DOM/pickers. Use the
installed obsidian.d.ts for new/uncertain API signatures, not a full rescan for
already verified calls. Keep esbuild/sample-plugin structure, theme variables and
unload cleanup. Bootstrap official scaffolding/types only in a confirmed blank repo.

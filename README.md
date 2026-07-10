# Property Porter

[![Build](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/scorecard.yml)

Copy some or all YAML frontmatter properties from one note and paste them into another in Obsidian.

## Install

1. Create a new repository from this template, or clone this repo into `<vault>/.obsidian/plugins/obsidian-property-porter/`.
2. Run `npm install`.
3. Run `npm run build`.
4. Enable **Property Porter** in Obsidian's Community Plugins settings.

## Usage

Property Porter provides four commands:

- **Copy properties from active note** — saves the selected properties from the active file into an internal clipboard. The status bar shows `PP: N` with the number of copied properties.
- **Paste properties into another note** — opens a file picker so you can choose which file to paste into.
- **Paste properties into active note** — pastes directly into whichever file is active.
- **Clear clipboard** — empties the internal clipboard.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Only include** | `tags` | Comma-separated whitelist of properties to copy. When populated, **Exclude keys** is ignored. |
| **Exclude keys** | `aliases, created date, modified date` | Comma-separated properties to ignore. Automatically disabled when **Only include** is populated. |
| **Paste mode** | `Merge` | How copied properties merge into the destination note. |
| **Auto-clear clipboard after successful paste** | `Off` | Automatically clear copied properties after pasting. |

### Paste modes

- **Overwrite** — destination properties are replaced unconditionally.
- **Skip existing** — only newly added properties are inserted; existing keys are left unchanged.
- **Merge** — destination properties are merged with copied properties. Arrays/sets are merged by union; falsy source values preserve the destination. Objects are merged recursively.

## Notes

- This plugin relies on Obsidian's native `metadataCache` and `fileManager.processFrontMatter()` for reading and writing frontmatter. No custom YAML parser is used.
- Position metadata from Obsidian's cache is stripped before copy/paste to avoid corrupting the destination file's internal tracking data.

## Developing

- `npm run dev` — watch and rebuild `main.js` with esbuild.
- `npm run lint` — ESLint with zero-warning policy.
- `npm run build` — lint + type-check + production bundle.
- `npm run format` — Prettier write over `src`.
- `npm run test:run` — Vitest unit/integration suite.
- `npm run test:browser` — Playwright browser regression suite.

## Releasing

1. Bump the version: `npm version patch` (or `minor`/`major`). This updates `manifest.json` and `versions.json` via `version-bump.mjs`.
2. Push the tag: `git push && git push --tags`. The `release.yml` workflow builds the plugin and drafts a GitHub release containing `main.js`, `manifest.json`, and `styles.css`.
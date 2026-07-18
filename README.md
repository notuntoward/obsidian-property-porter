# Property Porter

[![Build](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/scorecard.yml)

Copy some or all YAML frontmatter properties from one note and paste them into another in Obsidian.

## Why use Property Porter?

Keeping frontmatter consistent across a vault is tedious and error-prone. When you want several notes to share the same `tags`, `status`, `project`, or other properties, you normally open each file, scroll to the top, and hand-edit YAML — easy to typo, easy to forget one note, and awkward when the property is a long list. Property Porter solves that: it gives you a clipboard for frontmatter properties, so you can copy properties from one note (or from a whole tab group, or from a tag picker) and paste them onto other notes in a single command. It is built for exactly the workflow Obsidian's default "copy/paste" can't do — moving and merging *metadata*, not text.

## Usage

Property Porter provides eight commands:

- **Copy properties from active note** — saves the properties matching **Only include**/**Exclude keys** from the active file into an internal clipboard, replacing whatever was there before. The status bar shows `PP: N`, where `N` is the total number of individual values copied (each list item counts separately; e.g. three tags shows `PP: 3`).
- **Copy properties from another note** — opens the same file picker as **Paste properties into another note** so you can choose which note to copy from, then collects its properties the same way as the active-note command.
- **Copy properties from the active tab group** — collects properties from every note open in the current tab group and unions them into one clipboard payload. List properties (e.g. `tags`) accumulate every distinct value across the notes; scalar properties keep the first value seen. Files in other tab groups are ignored.
- **Paste properties into another note** — opens a file picker so you can choose which file to paste into.
- **Paste properties into active note** — pastes directly into whichever file is active.
- **Paste properties into the active tab group** — pastes the clipboard into every note open in the current tab group.
- **Select tags to paste** — opens a searchable picker over every tag used anywhere in the vault so you can build up a `tags` list to paste, without needing an active note with those exact tags already on it. Requires **Only include** to be set to exactly `tags`. The picker is seeded with whatever tags are already in the clipboard, so you can keep adding across multiple runs; use "Clear all" or Ctrl/Cmd+Backspace to empty it, or the × on any tag to drop just that one. Type to filter, Enter to add the highlighted tag (or to add a brand-new tag typed verbatim when it matches nothing), Enter again on an empty search box (or "Finish selection") to commit. Esc cancels without changing the clipboard.
- **Clear properties** — empties the internal clipboard.

Commands other than **Select tags to paste** always *replace* the clipboard outright; they don't merge with whatever was copied/selected before.

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

## Terminology

Precise wording matters here because "property" and "tag" mean different things:

- **Property** — a YAML frontmatter *key*, e.g. `tags`, `status`, `aliases`. The **Only include** and **Exclude keys** settings operate on properties.
- **Property value** — whatever is stored under a property key. For `tags`, that's a list; for `status`, that might be a single string.
- **Item** — one element of a *list-type* property's value. Each tag in `tags: [a, b, c]` is an item of the `tags` property — an item is never itself a "property".

Currently, only the `tags` property has a dedicated item picker (**Select tags to paste**, above); every other property is copied or pasted as a whole value via **Copy properties**/**Paste properties**.

## Install

1. Create a new repository from this template, or clone this repo into `<vault>/.obsidian/plugins/obsidian-property-porter/`.
2. Run `npm install`.
3. Run `npm run build`.
4. Enable **Property Porter** in Obsidian's Community Plugins settings.

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

# Property Porter

[![Build](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-property-porter/actions/workflows/scorecard.yml)

Copy some or all YAML frontmatter properties from one note and paste them into another in Obsidian.

## Why use Property Porter?

Keeping frontmatter consistent across a vault is tedious and error-prone. When you want several notes to share the same `tags`, `status`, `project`, or other properties, you normally operate file-by-file, opening each, and either scroll through to the top to hand-edit YAML, or click and type through the properties sidebar — easy to typo, easy to forget on one note, and time-consuming when there are a lot of properties or when they are long lists. Property Porter simplifies this: you can simply copy properties from one note (or from a whole tab group, or from a property picker) and then paste them onto other notes. It is built for exactly the workflow Obsidian's default "copy/paste" can't do — moving and merging *metadata*, not text.

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
- **Skip existing** — new keys are added; any key already present in the destination is left completely unchanged (the clipboard value is discarded, not combined).
- **Merge** — new keys are added; for keys already present, the values are combined — lists are unioned, objects are merged recursively, and scalar values take the clipboard's value unless it is empty (in which case the destination is kept).

#### How paste modes affect each frontmatter data type

All three paste modes (Overwrite, Skip existing, Merge) are implemented for **every** property type below. They only differ in what happens to a key that **already exists** in the destination; all three add keys that are new. The "Implemented" column confirms the pasting methods apply to that type, and the three mode columns show the effect on an existing key.

| Data Structure / Property Type | Description | Most Common Example | Implemented | Overwrite | Skip existing | Merge |
| --- | --- | --- | --- | --- | --- | --- |
| Text (string) | Free-form text (titles, statuses, descriptions); may use YAML block scalars for multi-line text. | `status: "in-progress"` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Clipboard replaces destination, unless the clipboard value is empty (then destination kept). |
| Number | Integer or float; leave unquoted for numeric sorting. | `priority: 1` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Clipboard replaces destination, unless the clipboard value is empty (then destination kept). |
| Checkbox (boolean) | `true`/`false` toggle. | `done: false` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Clipboard replaces destination, unless the clipboard value is empty (then destination kept). |
| Date | Calendar day, ISO 8601 (`YYYY-MM-DD`). | `due: 2026-07-20` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Clipboard replaces destination, unless the clipboard value is empty (then destination kept). |
| Date & Time | Day with time (`YYYY-MM-DDTHH:MM`). | `meeting_time: 2026-08-24T14:30` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Clipboard replaces destination, unless the clipboard value is empty (then destination kept). |
| List (array) | Sequence of items, e.g. tags or aliases; inline `[A, B]` or bulleted. | `tags: [projects, writing]` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Union of clipboard and destination (distinct values from both). |
| Nested Object (mapping) | YAML dictionary under a parent key. Not editable in Obsidian's Properties UI, but valid YAML and parsed by plugins like Dataview. | `location:`<br>`  city: Seattle`<br>`  lat: 47.6` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Merged field by field; nested keys present in both are combined recursively. |
| Array of Objects | List whose items are mappings. Valid YAML but no native Properties UI support. | `tasks:`<br>`  - name: "Research"`<br>`    complete: true` | Yes — all copy/paste commands and all three modes. | Clipboard replaces destination. | Destination kept. | Treated as a list: if the destination is also an array, the two are unioned (deduplicated); if the destination is any other type, the clipboard array replaces it. No per-item object merging is performed. |

#### Select interface availability by property type

The only item-level "select" interface is **Select tags to paste**, which opens a searchable picker to build up a list one item at a time. It is implemented **only for the `tags` property** and only when **Only include** is set to exactly `tags` (otherwise it shows a notice and exits). All other property types are copied and pasted as a whole value — there is no per-item picker for them.

| Data Structure / Property Type | Select interface implemented? | Notes |
| --- | --- | --- |
| Text (string) | No | Copied/pasted as a whole value. |
| Number | No | Copied/pasted as a whole value. |
| Checkbox (boolean) | No | Copied/pasted as a whole value. |
| Date | No | Copied/pasted as a whole value. |
| Date & Time | No | Copied/pasted as a whole value. |
| List (array) | Partial — `tags` only | Implemented for the `tags` property (item-by-item picker). Other list properties such as `aliases` are copied/pasted as a whole value; the select interface is not available for them. |
| Nested Object (mapping) | No | Copied/pasted as a whole value. |
| Array of Objects | No | Copied/pasted as a whole value. |

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

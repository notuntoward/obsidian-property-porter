# Property Porter

Copy some or all YAML frontmatter properties from one note and paste them into another in Obsidian.

## Why use Property Porter?

Keeping frontmatter consistent across a vault is tedious and error-prone. When you want several notes to share the same `tags`, `status`, `project`, or other properties, you normally operate file-by-file, opening each, and either scroll through to the top to hand-edit YAML, or click and type through the properties sidebar — easy to typo, easy to forget on one note, and time-consuming when there are a lot of properties or when they are long lists. Property Porter simplifies this: you can simply copy properties from one note (or from a whole tab group, or from a property picker) and then paste them onto other notes. It is built for exactly the workflow Obsidian's default "copy/paste" can't do — moving and merging *metadata*, not text.

## Usage

Property Porter provides eight commands:

- **Copy properties from active note** — saves the properties matching **Only include properties**/**Exclude properties** from the active file into an internal clipboard, replacing whatever was there before. The status bar shows `PP: N`, where `N` is the total number of individual values copied (each list item counts separately; e.g. three tags shows `PP: 3`).
- **Copy properties from another note** — opens a fast file picker that searches note names, paths, and aliases with literal substring matching as you type, so you can choose which note to copy from; then it collects properties the same way as the active-note command.
- **Copy properties from the active tab group** — collects properties from every note open in the current tab group and unions them into one clipboard payload. List properties (e.g. `tags`) accumulate every distinct value across the notes; scalar properties keep the first value seen. Files in other tab groups are ignored.
- **Paste properties into another note** — opens a file picker so you can choose which file to paste into.
- **Paste properties into active note** — pastes directly into whichever file is active.
- **Paste properties into the active tab group** — pastes the clipboard into every note open in the current tab group.
- **Edit property clipboard** — opens one editor for the current clipboard, whether it contains properties, tags, or both. It initially shows only the properties already in the clipboard, so a tag-only clipboard stays tag-only. You can exclude properties or values, remove individual list values, search for additional properties, add a new property, and edit values. Tags use Obsidian-style bubbles; other list values are shown as plain text. When copying or pasting produces scalar conflicts, the same editor separates the required conflict choices from other properties, which are optional and shown for reference. Date conflicts are ordered newest first, and Enter accepts the default. The action bar stays visible while scrolling; Escape closes suggestions first or dismisses the editor, and Enter accepts when ready, including only after all conflicts are resolved. Ctrl/Cmd+Enter submits, Alt+ArrowUp/Down moves between property cards, Alt+X excludes the focused property, and Ctrl/Cmd+Backspace clears all when an input is empty or a conflict radio is focused. In conflicts, press 1–9 to choose a candidate or O for “Other value…”.
- **Clear properties clipboard** — empties the internal clipboard.

Copy commands replace the clipboard outright. **Edit property clipboard** replaces it with the selection you finish, including any properties you added.

### Conflict resolution

Scalar collisions are resolved interactively, at the moment they occur. Each candidate value shows the note or notes it came from. For scalar properties, **Other value…** accepts typed values directly; tags and other list properties ask for confirmation before adding a new entry.

- **Copy from the active tab group**: when the same scalar property holds different values across the group's notes (e.g. different `status` values), the conflicting options are presented once and exactly one must be chosen before anything reaches the clipboard. List properties union silently; agreeing scalars copy silently.
- **Paste** (merge mode only): when a scalar property in the clipboard collides with a different value already in the target note(s), the options are presented before anything is written; one resolution is applied to every target. For a tab-group paste, all conflicts in the group are resolved in a single pass. **Overwrite** and **Skip existing** paste modes never ask about value collisions — the mode itself already decides the winner. Cancel the dialog and nothing is written.
- **Repeated values**: identical scalar values within one note are shown once with a notice rather than treated as a conflict. Repeated list values are deduplicated and show their occurrence counts. For date and datetime properties, choosing **Other value…** opens the native date/time input. The chosen date stays visible and can be edited in place; changing it replaces the one selected value rather than adding a second date. Datetime edits retain the selected candidate's UTC offset.

Only conflicting properties require a choice. Other properties are shown in a separate optional section for reference and can be edited or excluded, but they do not need to be resolved.

#### Duplicate property keys

A note whose frontmatter contains the same property key more than once (e.g. two `modified_date` lines) is treated as a conflict in every property copy and paste command, regardless of paste mode and property filters. Property Porter reads the raw text and names the affected note in the conflict dialog, even if Obsidian's metadata cache returns no frontmatter.

During Copy, your choices determine the clipboard contents. A separate permission prompt lists the affected source files before any rewrite: **Repair notes and copy** removes redundant occurrences, while **Copy only** leaves source files unchanged. Dismissing this permission prompt also copies without rewriting. During Paste, duplicate keys in the target are repaired as part of the paste. Clearing a duplicate property removes it from the resolved values and, if repair is authorized, from the note. Cancelling conflict resolution leaves the notes and clipboard unchanged. Unrelated list items and other note content are not rewritten by the repair.

The **Only include properties** and **Exclude properties** filters match property names case-insensitively and treat underscores as spaces, so `created_date` is caught by an exclusion of `created date`.

## Settings

Settings are organized into groups:

### Property filters (property-copy commands)

These filters apply to all property-copy commands. Tags are frontmatter properties here, not a separate tag-only command. They do not change paste operations or **Edit property clipboard**; duplicate-key repair still runs regardless of these filters.

| Setting | Default | Description |
|---------|---------|-------------|
| **Only include properties** | `tags` | Choose existing properties or confirm new names to copy only those properties in property-copy commands. |
| **Exclude properties** | `aliases, created date, modified date` | Choose existing properties or confirm new names to skip after applying **Only include properties**. A property cannot be in both lists; the picker warns and rejects overlapping selections. |

### Paste behavior

| Setting | Default | Description |
|---------|---------|-------------|
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

The **Edit property clipboard** command opens the shared property editor. When a list property holds multiple values, you can select one or all of them. If only tags are in the clipboard, only tags are shown initially; use the property search to add more properties. Conflicts encountered while copying or pasting appear in a dedicated section of this editor.

| Data Structure / Property Type | Select interface implemented? | Notes |
| --- | --- | --- |
| Text (string) | Yes | Selectable via **Edit property clipboard**. When merging conflicting scalar values, options are presented and exactly one must be chosen. |
| Number | Yes | Selectable via **Edit property clipboard**. When merging conflicting numbers, options are presented and exactly one must be chosen. |
| Checkbox (boolean) | Yes | Selectable via **Edit property clipboard**. |
| Date | Yes | Selectable via **Edit property clipboard** and native date input for custom conflict values. |
| Date & Time | Yes | Selectable via **Edit property clipboard** and native date/time input for custom conflict values. |
| List (array) | Yes | Selectable via **Edit property clipboard**, with individual values removable from the list. |
| Nested Object (mapping) | Whole value | Copied/pasted as a whole value. |
| Array of Objects | Whole value | Copied/pasted as a whole value. |

## Terminology

Precise wording matters here because "property" and "tag" mean different things:

- **Property** — a YAML frontmatter property, e.g. `tags`, `status`, `aliases`. The **Only include properties** and **Exclude properties** settings operate on properties in all property-copy commands; `tags` is treated the same as other properties.
- **Property value** — whatever is stored under a property key. For `tags`, that's a list; for `status`, that might be a single string.
- **Item** — one element of a *list-type* property's value. Each tag in `tags: [a, b, c]` is an item of the `tags` property — an item is never itself a "property".

Both the `tags` property and general frontmatter properties can be interactively configured before pasting via **Edit property clipboard**.

# hedgesync

Sync Obsidian Markdown notes with HedgeDoc documents using [`hedgesync`](https://github.com/tionis/hedgesync).

This plugin uses a frontmatter property to map each Obsidian note to one HedgeDoc document.

## Features

- Push the active Obsidian note to HedgeDoc.
- Pull the active HedgeDoc document into Obsidian.
- Open the linked HedgeDoc document from Obsidian.
- Optional auto-push when a linked note is modified.
- Live sync toggle for the active note (periodic pull + debounced push).
- Optional confirmation prompt before manual pull/push overwrites differing content.
- Vault-wide pull command for all linked notes using HedgeDoc `/download`, while preserving local frontmatter.
- Quick action buttons (push, pull, live sync) in the ribbon, shown only for linked notes.

## Requirements

- Obsidian desktop.
- Obsidian mobile is intentionally unsupported in this workaround.
- Node.js 18+ for development.
- A reachable HedgeDoc 1.x server.

## Frontmatter mapping

Default frontmatter key: `hedgedoc` (configurable in plugin settings).

### Option 1: Full URL

```yaml
---
hedgedoc: https://md.example.com/my-note-id
---
```

### Option 2: Note ID with default server URL in settings

```yaml
---
hedgedoc: my-note-id
---
```

### Option 3: Object form

```yaml
---
hedgedoc:
  noteId: my-note-id
  serverUrl: https://md.example.com
---
```

You can also use `url` in object form:

```yaml
---
hedgedoc:
  url: https://md.example.com/my-note-id
---
```

## Commands

- `Sync active note to hedgedoc`
- `Sync active note from hedgedoc`
- `Open linked hedgedoc document`
- `Toggle live sync for active note`
- `Pull all linked notes from hedgedoc`

Use Obsidian hotkeys to assign keyboard shortcuts to these commands in **Settings → Hotkeys**.

## Settings

- `Default hedgedoc server URL`
- `Session cookie` (optional, for private notes)
- `Frontmatter link property`
- `Auto push on save`
- `Auto push debounce (ms)`
- `Request timeout (ms)`
- `Warn before overwrite`
- `Live sync pull interval (ms)`
- `Live sync push debounce (ms)`
- `Show quick action buttons`

## Development

Install dependencies:

```bash
npm install
```

Build once:

```bash
npm run build
```

Watch mode:

```bash
npm run dev
```

Manual test install path:

```text
<Vault>/.obsidian/plugins/hedgesync/
```

Copy `main.js`, `manifest.json`, and `styles.css` into that folder.

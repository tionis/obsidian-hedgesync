# hedgesync

Sync Obsidian Markdown notes with HedgeDoc documents using [`hedgesync`](https://github.com/tionis/hedgesync).

This plugin uses a frontmatter property to map each Obsidian note to one HedgeDoc document.

## Features

- Push the active Obsidian note to HedgeDoc.
- Pull the active HedgeDoc document into Obsidian.
- Open the linked HedgeDoc document from Obsidian.
- Optional auto-push when a linked note is modified.
- True live sync toggle for the active note (persistent HedgeDoc session with local/remote OT updates).
- Optional confirmation prompt before manual pull/push overwrites differing content.
- Vault-wide pull command for all linked notes using HedgeDoc `/download`, while preserving local frontmatter.
- Create a hedgedoc document from an Obsidian note and link it in frontmatter.
- Create an Obsidian note from a hedgedoc document URL or note ID.
- Context menu actions in file/editor menus for linked notes.

## Requirements

- Obsidian desktop.
- Obsidian mobile is intentionally unsupported in this workaround.
- Node.js 18+ for development.
- A reachable HedgeDoc 1.x server.

## Policy disclosures

- External service: this plugin syncs with user-configured HedgeDoc servers.
- Data sent over the network: linked note body content, linked note IDs/URLs, and optional session cookie.
- Network behavior: requests are only made for sync features (manual commands, live sync, or optional auto push).
- Local storage: plugin settings are stored in `.obsidian/plugins/hedgesync/data.json`.
- Telemetry: none.
- Ads, affiliate links, paid unlocks, and remote code execution: none.

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
- `Create hedgedoc document from active note`
- `Create note from hedgedoc document`

Use Obsidian hotkeys to assign keyboard shortcuts to these commands in **Settings → Hotkeys**.

## Settings

- `Default hedgedoc server URL`
- `Session cookie` (optional, for private notes)
- `Frontmatter link property`
- `Auto push on save`
- `Auto push debounce (ms)`
- `Request timeout (ms)`
- `Warn before overwrite`
- `Live sync push debounce (ms)`

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

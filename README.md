# Hedgesync

Sync Obsidian notes with HedgeDoc documents using frontmatter links and [`hedgesync`](https://github.com/tionis/hedgesync).

[Install from the Obsidian plugin store](https://community.obsidian.md/plugins/hedgesync)

Hedgesync maps each Obsidian note to one HedgeDoc document through a configurable frontmatter property. It supports manual sync commands, optional auto-push on save, and a live sync mode for the active note.

## Highlights

- Push the active Obsidian note to HedgeDoc.
- Pull the linked HedgeDoc document back into Obsidian.
- Open linked HedgeDoc documents from Obsidian.
- Create a HedgeDoc document from the active note and write the link to frontmatter.
- Create an Obsidian note from a HedgeDoc document URL or note ID.
- Pull all linked notes across the vault while preserving local frontmatter.
- Enable optional auto-push when linked notes are modified.
- Toggle live sync for the active note with local and remote OT updates.
- Confirm before manual pull or push overwrites differing content.
- Use file and editor context menu actions for linked notes.

## Install

### Community plugin store

Install Hedgesync from the Obsidian plugin store:

https://community.obsidian.md/plugins/hedgesync

### Manual install

Download the release assets and place them in:

```text
<Vault>/.obsidian/plugins/hedgesync/
```

Required files:

- `main.js`
- `manifest.json`
- `styles.css`

Then reload Obsidian and enable **Hedgesync** in **Settings -> Community plugins**.

## Requirements

- Obsidian desktop.
- A reachable HedgeDoc 1.x server.
- Node.js 18+ for development.

Obsidian mobile is intentionally unsupported because this plugin depends on desktop-compatible sync behavior.

## Frontmatter

Default frontmatter key: `hedgedoc`

You can change the key in plugin settings.

### Full URL

```yaml
---
hedgedoc: https://md.example.com/my-note-id
---
```

### Note ID with a default server URL

```yaml
---
hedgedoc: my-note-id
---
```

### Object form

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

Use Obsidian hotkeys to assign keyboard shortcuts in **Settings -> Hotkeys**.

## Settings

- `Default hedgedoc server URL`
- `Session cookie`
- `Frontmatter link property`
- `Auto push on save`
- `Auto push debounce (ms)`
- `Request timeout (ms)`
- `Warn before overwrite`
- `Live sync push debounce (ms)`

The session cookie is optional and only needed for private HedgeDoc notes.

## Privacy

- External service: user-configured HedgeDoc servers.
- Data sent over the network: linked note body content, linked note IDs or URLs, and optional session cookie.
- Network behavior: requests are only made for sync features, including manual commands, live sync, and optional auto-push.
- Local storage: settings are stored in `.obsidian/plugins/hedgesync/data.json`.
- Telemetry: none.
- Ads, affiliate links, paid unlocks, and remote code execution: none.

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

Lint with Obsidian plugin rules:

```bash
npm run lint
```

Manual test install path:

```text
<Vault>/.obsidian/plugins/hedgesync/
```

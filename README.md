# Hedgesync

Sync Obsidian notes with HedgeDoc documents using frontmatter links and [`hedgesync`](https://github.com/tionis/hedgesync).

[Install from the Obsidian plugin store](https://community.obsidian.md/plugins/hedgesync)

Hedgesync maps each Obsidian note to one HedgeDoc document through a configurable frontmatter property. You can push and pull by hand, push automatically on save, or edit together in real time with live sync.

## Highlights

- Live sync: edit a note in Obsidian while others edit it in HedgeDoc. Changes go both ways as they happen, without moving your cursor or polluting your undo history. Several notes can be live at once.
- Live sync survives connection loss: edits made while offline are merged with remote edits when the connection returns.
- See where others' cursors are, with their names, and they see yours (in HedgeDoc or in Obsidian).
- A status bar item shows the live sync state of the active note and who else is in it.
- Log in from Obsidian with any login method your HedgeDoc server offers (OIDC, GitHub, LDAP, email, ...).
- Push the active note to HedgeDoc, or pull the HedgeDoc document into it.
- Create a HedgeDoc document from a note, or a note from a HedgeDoc document.
- Copy or open the published page (`/s/...`) and slide link of a note.
- Change who can view and edit a note (for notes you own).
- Pull all linked notes across the vault, keeping local frontmatter.
- Browse the notes you have opened on a server, see which are already in your vault, and import the rest.
- Optional auto-push when linked notes change.

## Requirements

- Obsidian desktop **1.13 or newer**. Mobile is not supported. Hedgesync 0.3.0 is the last version for older Obsidian releases.
- A HedgeDoc **1.10.4 or newer** server. HedgeDoc 1.10.3 and older use Socket.IO 2, which hedgesync cannot talk to; HedgeDoc 2 is not supported yet.

## Install

### Community plugin store

Install Hedgesync from the Obsidian plugin store:

https://community.obsidian.md/plugins/hedgesync

### Manual install

Download `main.js`, `manifest.json` and `styles.css` from a release and place them in:

```text
<Vault>/.obsidian/plugins/hedgesync/
```

Then reload Obsidian and enable **Hedgesync** in **Settings → Community plugins**.

## Getting started

1. In **Settings → Hedgesync**, set the **Default hedgedoc server URL**.
2. Open **Accounts** and select **Add account** and log in through your server's login page. You can skip this for public notes. Instead of logging in, you can paste a session cookie (`connect.sid`) from a browser where you are logged in.
3. Open a note and run **Create hedgedoc document from active note**, or add a link to an existing document in the frontmatter (see below).
4. Run **Toggle live sync for active note**, or select the status bar item, to edit together in real time.

## Frontmatter

Default frontmatter key: `hedgedoc` (configurable).

```yaml
---
hedgedoc: https://md.example.com/my-note-id
---
```

A bare note ID uses the default server:

```yaml
---
hedgedoc: my-note-id
---
```

Object form:

```yaml
---
hedgedoc:
  noteId: my-note-id
  serverUrl: https://md.example.com
---
```

Only the text below the frontmatter is synchronized; the frontmatter stays in Obsidian. HedgeDoc's own settings (title, tags, `type: slide`, ...) live in a YAML block at the top of the HedgeDoc document, which appears in Obsidian as ordinary text below your frontmatter.

## Commands

- `Sync active note to hedgedoc` (push)
- `Sync active note from hedgedoc` (pull)
- `Toggle live sync for active note`
- `Open linked hedgedoc document`
- `Copy published link of active note`
- `Copy slide link of active note`
- `Open published page of active note`
- `Change who can view and edit the linked hedgedoc note`
- `Create hedgedoc document from active note`
- `Create note from hedgedoc document`
- `Pull all linked notes from hedgedoc`
- `Browse hedgedoc notes`
- `Log in to hedgedoc`

Assign keyboard shortcuts in **Settings → Hotkeys**.

## Live sync

While live sync is on, the open editor and the HedgeDoc document stay identical: your edits are sent as you type, and remote edits are applied to the editor directly. If the note is not open in an editor, remote edits are written to the file.

- **Starting**: if the note and the HedgeDoc document differ, you choose which version to keep (with **Warn before overwrite** off, the HedgeDoc version wins).
- **Connection loss**: the status bar shows **Offline**. Keep editing; when the connection returns, your edits and the remote edits are merged.
- **Cursors**: other people's cursors appear as colored carets; their name shows briefly when they move and when you hover the line. Your cursor is shown to them while your editor has focus, except inside the front matter, which only you see. HedgeDoc shares cursors but not selections.
- **Read-only notes**: if you are not allowed to edit the note, remote changes still arrive, but local changes are not sent.
- **Start automatically**: with this setting on, live sync starts when you open a linked note and stops when you close its last tab.

## Browse notes on a server

**Browse hedgedoc notes** lists the notes in your HedgeDoc history on a server: the notes you have opened there while logged in (HedgeDoc has no list of all notes you can access). It needs an account for that server.

- Each note shows when you last opened it, its tags, and the vault notes linked to it, or **Not in the vault**.
- Search by title, tag or vault path, and turn on **Only notes not in the vault** to see what is missing.
- **Import** creates a linked note in **Folder for new notes**, named after the note's title; **Import N** imports every listed note that is not in the vault. **Open** opens the linked vault note.
- A vault note counts as linked when its frontmatter link uses the same note ID as the history: the ID in the note's address in HedgeDoc (its alias, or the long generated ID). A link written with a different form of the ID, such as the raw UUID, is not recognized.

## Accounts

You can have one account per HedgeDoc server, as many servers as you like. **Settings → Hedgesync → Accounts** lists them with the account name and when the session was last checked:

- **Add account**: enter a server URL, then **Log in** on the server's login page (any method it offers: OIDC, GitHub, LDAP, email, ...) or paste a session cookie from your browser. A pasted cookie is checked with the server before it is saved.
- **Check** (refresh icon): asks the server whether the session is still valid; expired sessions are marked.
- **Log in again**, and **Log out** (login-window sessions are ended on the server) or **Forget** (a pasted browser cookie is only removed, so your browser stays logged in).
- The command **Log in to hedgedoc** opens **Add account** for the active note's server.

- **Background checks**: shortly after Obsidian starts and every 6 hours, each account's session is checked. This also keeps it alive: HedgeDoc extends a session whenever it is used (by default to 14 days). When a session has expired you get a notice, and errors caused by missing access say whether to add an account or log in again. An expired login cannot be renewed without you, since the server's login page needs you to sign in.

The login window uses its own temporary browser session; after you sign in, only the HedgeDoc session cookie is kept and the window's data is discarded.

Session cookies are kept in Obsidian's secret storage, not in the plugin's `data.json`, and cookies saved by older versions are moved there automatically. Cookies are only ever sent to their own server.

## Troubleshooting

- **"The TLS certificate ... is not trusted"**: the server uses a certificate from a private certificate authority. Install that CA in your operating system's certificate store; hedgesync uses the system store when Obsidian's Node.js version supports it (Node 22.15 or newer). On older versions, start Obsidian with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
- **"... runs HedgeDoc 1.10.3 or older"**: upgrade the server to HedgeDoc 1.10.4 or newer.
- **"The server did not accept the session"**: the session expired or the cookie is wrong. Check the account in **Accounts** and log in again.
- Error details are logged to the developer console (**View → Toggle developer tools**) with the prefix `[hedgesync]`.

## Settings

- **Default hedgedoc server URL**: for new documents and links that store only a note ID.
- **Accounts**: logins per server (see above).
- **Frontmatter link property**: frontmatter key of the link (default `hedgedoc`).
- **Warn before overwrite**: ask before a manual push or pull replaces different content.
- **Auto push on save** and **Auto push delay**.
- **Request timeout**.
- **Live sync → Start automatically**.

## Privacy

- External service: the HedgeDoc servers you configure or link to.
- Data sent: the text of linked notes (below the frontmatter), their note IDs or URLs, and the session cookie for that server.
- Network requests happen only for sync features (commands, live sync, auto-push, login) and for checking saved accounts every few hours.
- Local storage: settings in `.obsidian/plugins/hedgesync/data.json`; session cookies in Obsidian's secret storage.
- Telemetry, ads, paid features, remote code: none.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # production build
npm run lint    # Obsidian plugin rules
npm test        # unit tests
```

Manual test install path: `<Vault>/.obsidian/plugins/hedgesync/`.

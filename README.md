# YouTube Playlist Importer

A two-way YouTube playlist manager for Obsidian.

**YouTube Playlist Importer** connects Markdown notes in your Obsidian vault with your YouTube playlists. It can import playlists from YouTube into Obsidian, and it can also scan the currently open Markdown note, find YouTube links, remove duplicates, compare them with an existing YouTube playlist, and send only the missing videos back to YouTube.

The goal is to make Obsidian a practical workspace for collecting, cleaning, sorting, reviewing, and organizing YouTube content before syncing it back to playlists.

---

## Features

### Obsidian → YouTube

- Scan the currently open `.md` note for YouTube video links
- Support common YouTube URL formats:
  - `https://www.youtube.com/watch?v=...`
  - `https://youtu.be/...`
  - YouTube Shorts
  - YouTube Live links
  - YouTube Embed links
- Extract YouTube video IDs automatically
- Remove duplicate links from the note before sending
- Load your YouTube playlists directly inside Obsidian
- Choose the target playlist from a dropdown
- Optionally check the target playlist before importing
- Skip videos that already exist in the selected playlist
- Add only new videos through YouTube Data API v3
- Show import progress and a final result summary
- Ribbon button for quick access
- Command Palette integration

### YouTube → Obsidian

- Import an existing YouTube playlist into Obsidian
- Use `yt-dlp` to read playlist metadata
- Folder mode: create one Markdown note per video
- Single-note mode: create one Markdown document containing the playlist links
- Add useful frontmatter metadata
- Preserve video URL, video ID, playlist information, channel and thumbnail metadata
- Optional Auto Card Link-compatible blocks
- Avoid duplicate note creation

---

## Why this plugin exists

YouTube is convenient for saving videos, but large playlists can quickly become difficult to organize. Obsidian is much better suited for manual sorting, categorization, notes, tags, folders, links, AI-assisted processing, and long-term knowledge management.

This plugin bridges the two workflows:

```text
YouTube playlist
      ↓
   Obsidian
      ↓
organize / sort / edit / review
      ↓
YouTube playlist
```

For example, you can import or collect a large list of videos in Obsidian, sort them into topics such as AI, VPN, design, psychology, finance, or anything else, remove unnecessary links, and then send the cleaned list into the appropriate YouTube playlist.

---

## Requirements

### General

- Desktop version of Obsidian
- Obsidian **1.11.4 or newer**

The current plugin is desktop-only because OAuth authorization uses a temporary local loopback server and the YouTube → Obsidian importer can use the local `yt-dlp` executable.

### For Obsidian → YouTube

You need:

- a Google account with YouTube
- a Google Cloud project
- **YouTube Data API v3** enabled
- an OAuth 2.0 Client configured as **Desktop app**
- OAuth **Client ID**
- OAuth **Client secret**

### For YouTube → Obsidian

You need `yt-dlp` installed and available in your system `PATH`, or you can specify its full executable path in the plugin settings.

---

## Installation via BRAT

The current development builds are distributed through GitHub releases and can be installed with **BRAT (Beta Reviewers Auto-update Tool)**.

1. Install **BRAT** from Obsidian Community Plugins.
2. Enable BRAT.
3. Open `Settings → BRAT`.
4. Add the repository: `https://github.com/kudesnikoff/youtube-playlist-importer`
5. If the repository is already installed, open **Change plugin version**.
6. Select the latest beta release, for example `0.2.0-beta.2`.
7. Keep **Enable after installing the plugin** enabled.
8. Install/change the version.
9. Open `Settings → Community plugins`.
10. Make sure **YouTube Playlist Importer** is enabled.

The release contains the files required by BRAT: `main.js`, `manifest.json`, and `styles.css`.

---

## Google OAuth setup

The Obsidian → YouTube workflow requires permission to manage your YouTube playlists.

### 1. Create a Google Cloud project

Open Google Cloud Console and create a project, for example `YouTube Sort`.

You do not need to activate the Google Cloud free trial just for this plugin.

### 2. Enable YouTube Data API v3

Open `APIs & Services → Library`, search for `YouTube Data API v3`, open it and press **Enable**.

### 3. Configure Google Auth Platform

Open **Google Auth Platform** and complete the required application information under **Branding**.

A simple setup for personal use can use:

- App name: `Obsidian YouTube Playlist Importer`
- User support email: your Google account email
- Developer contact email: your email

### 4. Configure the audience

Open **Audience**.

For a personal Google account use:

- User type: **External**
- Publishing status: **Testing**

While the app is in Testing mode, add the Google account that owns the YouTube playlists under **Test users**. You do not need to publish the application publicly for personal use.

### 5. Create an OAuth Desktop client

Open `Google Auth Platform → Clients`, choose **Create client** and select:

- Application type: **Desktop app**
- Name: `Obsidian YouTube Playlist Importer`

Google will create credentials containing a Client ID and Client secret.

### 6. Enter the credentials in Obsidian

Open `Settings → YouTube Playlist Importer` and enter:

- **Google OAuth Client ID**
- **Google OAuth Client secret**

The Client secret is stored using Obsidian **SecretStorage** rather than normal plugin settings.

### 7. Connect YouTube

Press **Connect**. The plugin will open Google authorization in your browser. Select the Google account that owns the YouTube playlists and approve the requested access.

During authorization the plugin starts a temporary local callback server on `127.0.0.1:<random-port>`. It exists only while the OAuth authorization flow is active.

---

## Usage: send the current Obsidian note to YouTube

Create or open a Markdown note containing YouTube links, then run:

`YouTube Playlist Importer: Send links from current note to YouTube playlist`

The plugin analyzes the note, reports total links, unique video IDs and duplicates, then lets you select a destination playlist. With **Skip videos already in playlist** enabled, existing videos are ignored and only missing videos are added.

---

## Duplicate handling

The plugin handles duplicates at two levels:

- duplicate URLs inside the Markdown note are normalized to video IDs and sent only once;
- videos already present in the target playlist can be skipped before insertion.

---

## Usage: import YouTube playlist into Obsidian

Run:

`YouTube Playlist Importer: Import YouTube playlist to Obsidian`

Paste a YouTube playlist URL and choose either folder mode (one Markdown note per video) or single-note mode (one Markdown note containing the playlist links).

---

## Auto Card Link support

When enabled, imported video notes can include blocks compatible with **obsidian-auto-card-link**, allowing YouTube links to be displayed as visual cards instead of plain URLs.

---

## Commands

Current commands include:

- **Import YouTube playlist to Obsidian**
- **Send links from current note to YouTube playlist**

The Obsidian → YouTube command is also available through a ribbon icon.

---

## Privacy & Security

The plugin is designed to keep authentication data local to your Obsidian installation.

- The Google OAuth Client ID is stored in plugin settings.
- The Google OAuth Client secret and refresh token are stored using **Obsidian SecretStorage**.
- Access tokens are kept in memory and refreshed when necessary.
- Google authorization uses a temporary loopback callback on `127.0.0.1`.
- No external server operated by this project is required for authentication.
- The plugin communicates directly with Google OAuth endpoints, YouTube Data API v3, and YouTube/`yt-dlp` for playlist import.

Only authorize the plugin using a Google Cloud OAuth client that you control and trust.

---

## Current status

The Obsidian → YouTube functionality is currently in **beta testing**.

Current beta release: `0.2.0-beta.2`.

---

## Roadmap

Planned and possible improvements include:

- Select only part of the current note instead of scanning the full document
- Send links from a selected heading/section
- Send links from multiple notes or an entire folder
- Create a new YouTube playlist directly from Obsidian
- Map Obsidian headings to separate YouTube playlists
- Better per-video error reporting
- Retry failed imports
- Import progress/history log
- Preview videos before sending
- Detect unavailable/private/deleted videos before import
- Playlist search for accounts with many playlists
- Remember favorite/recent destination playlists
- Optional removal of successfully imported links from the note
- Add frontmatter markers such as `youtube_imported: true`
- Synchronize a Markdown note and a YouTube playlist in both directions
- AI-assisted sorting of YouTube links by topic before export
- Batch processing workflows for large video collections
- Better mobile compatibility where platform APIs allow it

---

## Example workflow

```text
YouTube Later playlist
        ↓
Import / collect links in Obsidian
        ↓
Sort by topic
        ↓
AI / VPN / Design / Mental / Finance / Geek
        ↓
Review and remove unnecessary items
        ↓
Send each cleaned list to its YouTube playlist
```

This makes Obsidian the organizational layer while YouTube remains the playback platform.

---

## Development

Repository: `kudesnikoff/youtube-playlist-importer`

Development of the Obsidian → YouTube workflow currently happens in `feature/export-note-to-youtube`.

Beta builds are published as GitHub prereleases for installation through BRAT.

---

## License

This project is **source-available for noncommercial use** under the **PolyForm Noncommercial License 1.0.0**.

You may use, study, modify, and redistribute the software for purposes permitted by that license. Commercial use is **not granted** by the public license.

Commercial use, resale, paid distribution, inclusion in commercial products or services, or other use intended for commercial advantage requires separate written permission or a separate commercial license from the copyright holder.

See:

- [`LICENSE`](./LICENSE) — PolyForm Noncommercial License 1.0.0
- [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md) — how commercial licensing works and how to request permission

This licensing model is intentionally **not OSI Open Source**, because commercial use is restricted. The source remains publicly readable and available for qualifying noncommercial use.

# YouTube Playlist Importer

Obsidian desktop plugin for two-way work with YouTube playlists.

## Features

### YouTube → Obsidian

- Import a YouTube playlist into Obsidian
- Folder mode: one Markdown note per video
- Single-note mode: one raw YouTube link per video
- Metadata frontmatter
- Duplicate avoidance
- `yt-dlp` integration

### Obsidian → YouTube

- Command: `YouTube Playlist Importer: Send links from current note to YouTube playlist`
- Reads the currently open `.md` note
- Finds standard `youtube.com/watch?v=...`, `youtu.be/...`, Shorts, Live, and Embed links
- Removes duplicate video IDs found in the note
- Connects to your Google/YouTube account with OAuth 2.0 + PKCE
- Loads your playlists into a dropdown
- Optionally checks the target playlist first and skips videos already present
- Adds the remaining videos through YouTube Data API v3
- Stores the refresh token in Obsidian SecretStorage rather than normal plugin settings

## Requirements

- Desktop Obsidian 1.11.4 or newer
- For YouTube → Obsidian: `yt-dlp` installed and available in PATH, or configure its full executable path
- For Obsidian → YouTube: a Google Cloud OAuth Desktop client with YouTube Data API v3 enabled

## Google setup

1. Open Google Cloud Console and create or select a project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen.
4. Create an OAuth client ID with application type **Desktop app**.
5. Copy the Client ID (`...apps.googleusercontent.com`). A client secret is not required by this plugin.
6. In Obsidian open **Settings → Community plugins → YouTube Playlist Importer** and paste the Client ID.
7. Press **Connect** and approve access in the browser.

The plugin starts a temporary loopback callback on `127.0.0.1` only while authorization is in progress.

## Sending a note to a playlist

1. Open a Markdown note containing YouTube links.
2. Run **YouTube Playlist Importer: Send links from current note to YouTube playlist** from the command palette, or use the YouTube ribbon icon.
3. Review the counts for total links, unique video IDs, and duplicates.
4. Select the target playlist.
5. Press **Send**.

## BRAT

The repository root contains `manifest.json`, `main.js`, and `styles.css`, so the plugin can be installed from a branch/release with BRAT for testing.

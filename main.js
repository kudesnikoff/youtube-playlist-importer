'use strict';

const obsidian = require('obsidian');
const childProcess = require('child_process');
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const PLUGIN_VERSION = '0.2.0';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const REFRESH_SECRET_ID = 'youtube-playlist-importer-refresh-token';

const DEFAULT_SETTINGS = {
  ytDlpPath: 'yt-dlp',
  defaultDestinationMode: 'folder',
  defaultDestinationPath: '_Resources/YT',
  createPlaylistSubfolder: true,
  createAutoCardLink: true,
  rawUrlOnOwnLine: true,
  enableDebugLogging: true,
  noteTypeProperty: 'type',
  noteTypeValue: 'youtube',
  googleClientId: '',
  defaultTargetPlaylistId: '',
  skipExistingInPlaylist: true
};

function sanitizeFileName(input) {
  const cleaned = String(input || 'Untitled')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.slice(0, 180) || 'Untitled';
}

function yamlString(value) { return JSON.stringify(String(value ?? '')); }
function normalizeVaultPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim();
}
function joinVaultPath(...parts) { return parts.map(normalizeVaultPath).filter(Boolean).join('/'); }
function isValidPlaylistUrl(value) {
  try {
    const url = new URL(String(value).trim());
    const host = url.hostname.replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host) && Boolean(url.searchParams.get('list'));
  } catch (_) { return false; }
}

function runCommand(command, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`yt-dlp timeout after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => code === 0
      ? finish(resolve, { stdout, stderr })
      : finish(reject, new Error(stderr.trim() || `yt-dlp exited with code ${code}`)));
  });
}

async function ensureFolder(app, folderPath) {
  const normalized = normalizeVaultPath(folderPath);
  if (!normalized) return;
  const parts = normalized.split('/');
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) await app.vault.createFolder(current);
    else if (!(existing instanceof obsidian.TFolder)) throw new Error(`Cannot create folder “${current}”: a file already exists at this path.`);
  }
}

function getVideoUrl(video) {
  if (video.webpage_url && /^https?:\/\//i.test(video.webpage_url)) return video.webpage_url;
  if (video.url && /^https?:\/\//i.test(video.url)) return video.url;
  const id = video.id || video.url || '';
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}
function getThumbnail(video) {
  if (video.thumbnail) return video.thumbnail;
  if (Array.isArray(video.thumbnails) && video.thumbnails.length) {
    const candidate = [...video.thumbnails].reverse().find((item) => item && item.url);
    if (candidate) return candidate.url;
  }
  return video.id ? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` : '';
}
function buildCardLink(videoUrl, title, description, thumbnail) {
  const lines = ['```cardlink', `url: ${videoUrl}`, `title: ${yamlString(title)}`, `description: ${yamlString(description || '')}`, 'host: www.youtube.com'];
  if (thumbnail) lines.push(`image: ${thumbnail}`);
  lines.push('```');
  return lines.join('\n');
}
function buildVideoNote(video, playlist, settings) {
  const videoUrl = getVideoUrl(video);
  const title = video.title || video.id || 'YouTube video';
  const thumbnail = getThumbnail(video);
  const description = String(video.description || '').trim();
  const channel = video.channel || video.uploader || playlist.channel || playlist.uploader || '';
  const playlistUrl = playlist.webpage_url || playlist.original_url || '';
  const lines = [
    '---', `title: ${yamlString(title)}`, `${settings.noteTypeProperty || 'type'}: ${yamlString(settings.noteTypeValue || 'youtube')}`,
    'source: youtube', `videoUrl: ${yamlString(videoUrl)}`, `videoId: ${yamlString(video.id || '')}`,
    `playlistUrl: ${yamlString(playlistUrl)}`, `playlistId: ${yamlString(playlist.id || '')}`, `channel: ${yamlString(channel)}`,
    `thumbnailUrl: ${yamlString(thumbnail)}`, `generated: ${yamlString(new Date().toISOString())}`, '---', '', `# ${title}`, ''
  ];
  if (settings.createAutoCardLink) lines.push(buildCardLink(videoUrl, title, description, thumbnail), '');
  if (settings.rawUrlOnOwnLine) lines.push(videoUrl, '');
  else if (!settings.createAutoCardLink) lines.push(`[Открыть на YouTube](${videoUrl})`, '');
  return lines.join('\n');
}

function extractYouTubeVideoIds(markdown) {
  const text = String(markdown || '');
  const patterns = [
    /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?[^\s<>)]*?v=([A-Za-z0-9_-]{11})/gi,
    /(?:https?:\/\/)?youtu\.be\/([A-Za-z0-9_-]{11})/gi,
    /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/gi
  ];
  const all = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) all.push(match[1]);
  }
  const unique = [...new Set(all)];
  return { all, unique, duplicates: all.length - unique.length };
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function randomToken(bytes = 32) { return base64Url(crypto.randomBytes(bytes)); }
function pkceChallenge(verifier) { return base64Url(crypto.createHash('sha256').update(verifier).digest()); }

class ExportToYouTubeModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.analysis = { all: [], unique: [], duplicates: 0 };
    this.playlists = [];
    this.selectedPlaylistId = plugin.settings.defaultTargetPlaylistId || '';
    this.isRunning = false;
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('ytpi-modal');
    this.contentEl.createEl('h2', { text: 'Send current note to YouTube playlist' });
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      this.contentEl.createEl('p', { text: 'Open a Markdown note first.' });
      return;
    }
    const markdown = await this.app.vault.cachedRead(file);
    this.analysis = extractYouTubeVideoIds(markdown);
    this.contentEl.createEl('p', { text: `Note: ${file.path}` });
    this.summaryEl = this.contentEl.createDiv({ cls: 'ytpi-summary' });
    this.summaryEl.setText(`Found ${this.analysis.all.length} YouTube links · ${this.analysis.unique.length} unique · ${this.analysis.duplicates} duplicates. Duplicates from the note will not be sent.`);
    this.statusEl = this.contentEl.createDiv({ cls: 'ytpi-modal__status' });
    this.playlistContainer = this.contentEl.createDiv();
    this.actionsEl = this.contentEl.createDiv({ cls: 'ytpi-modal__actions' });
    if (!this.analysis.unique.length) {
      this.statusEl.setText('No supported YouTube video links found in this note.');
      this.statusEl.addClass('is-error');
      return;
    }
    await this.renderConnectionState();
  }

  async renderConnectionState() {
    this.playlistContainer.empty();
    this.actionsEl.empty();
    this.statusEl.removeClass('is-error', 'is-success');
    if (!this.plugin.settings.googleClientId) {
      this.statusEl.setText('Google OAuth Client ID is not configured. Add it in plugin settings first.');
      this.statusEl.addClass('is-error');
      this.actionsEl.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
      return;
    }
    const connected = this.plugin.hasRefreshToken();
    if (!connected) {
      this.statusEl.setText('YouTube account is not connected.');
      const connect = this.actionsEl.createEl('button', { text: 'Connect YouTube', cls: 'mod-cta' });
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        try {
          this.statusEl.setText('Opening Google authorization…');
          await this.plugin.authorizeYouTube();
          this.statusEl.setText('Connected. Loading playlists…');
          await this.loadPlaylists();
        } catch (e) {
          this.statusEl.setText(e instanceof Error ? e.message : String(e));
          this.statusEl.addClass('is-error');
          connect.disabled = false;
        }
      });
      return;
    }
    await this.loadPlaylists();
  }

  async loadPlaylists() {
    this.playlistContainer.empty();
    this.actionsEl.empty();
    try { this.playlists = await this.plugin.listMyPlaylists(); }
    catch (e) {
      this.statusEl.setText(`Could not load playlists: ${e instanceof Error ? e.message : String(e)}`);
      this.statusEl.addClass('is-error');
      return;
    }
    if (!this.playlists.length) {
      this.statusEl.setText('No writable playlists found in this YouTube account.');
      this.statusEl.addClass('is-error');
      return;
    }
    if (!this.selectedPlaylistId || !this.playlists.some((p) => p.id === this.selectedPlaylistId)) this.selectedPlaylistId = this.playlists[0].id;
    this.statusEl.setText('Choose a playlist and send the unique links.');
    this.statusEl.addClass('is-success');
    new obsidian.Setting(this.playlistContainer).setName('Target playlist').addDropdown((dropdown) => {
      for (const playlist of this.playlists) dropdown.addOption(playlist.id, playlist.title);
      dropdown.setValue(this.selectedPlaylistId).onChange((value) => { this.selectedPlaylistId = value; });
    });
    new obsidian.Setting(this.playlistContainer)
      .setName('Skip videos already in playlist')
      .setDesc('Checks the target playlist before inserting anything.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.skipExistingInPlaylist).onChange(async (value) => {
        this.plugin.settings.skipExistingInPlaylist = value;
        await this.plugin.saveSettings();
      }));
    this.progressEl = this.playlistContainer.createDiv({ cls: 'ytpi-progress' });
    this.progressBarEl = this.progressEl.createDiv({ cls: 'ytpi-progress__bar' });
    this.progressEl.style.display = 'none';
    this.actionsEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    this.sendButton = this.actionsEl.createEl('button', { text: `Send ${this.analysis.unique.length} videos`, cls: 'mod-cta' });
    this.sendButton.addEventListener('click', () => this.startExport());
  }

  setProgress(done, total) {
    if (!this.progressEl) return;
    this.progressEl.style.display = total > 0 ? '' : 'none';
    this.progressBarEl.style.width = `${total ? Math.min(100, Math.round(done / total * 100)) : 0}%`;
  }

  async startExport() {
    if (this.isRunning || !this.selectedPlaylistId) return;
    this.isRunning = true;
    this.sendButton.disabled = true;
    try {
      this.plugin.settings.defaultTargetPlaylistId = this.selectedPlaylistId;
      await this.plugin.saveSettings();
      this.statusEl.setText('Checking target playlist…');
      const result = await this.plugin.exportVideoIdsToPlaylist(this.analysis.unique, this.selectedPlaylistId, (done, total, label) => {
        this.setProgress(done, total);
        this.statusEl.setText(`${label} (${done}/${total})`);
      });
      this.setProgress(result.processed, result.totalToInsert || 1);
      this.statusEl.setText(`Done. Added ${result.added}, skipped existing ${result.skippedExisting}, failed ${result.failed}.`);
      this.statusEl.removeClass('is-error', 'is-success');
      this.statusEl.addClass(result.failed ? 'is-error' : 'is-success');
      new obsidian.Notice(`YouTube: ${result.added} added, ${result.skippedExisting} already existed, ${result.failed} failed.`);
    } catch (e) {
      this.statusEl.setText(e instanceof Error ? e.message : String(e));
      this.statusEl.addClass('is-error');
    } finally {
      this.isRunning = false;
      this.sendButton.disabled = false;
    }
  }

  onClose() { this.contentEl.empty(); }
}

class ImportModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.playlistUrl = '';
    this.destinationMode = plugin.settings.defaultDestinationMode;
    this.destinationPath = plugin.settings.defaultDestinationPath;
    this.isRunning = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ytpi-modal');
    contentEl.createEl('h2', { text: 'Import YouTube playlist' });
    new obsidian.Setting(contentEl).setName('Playlist URL').addText((text) => {
      text.setPlaceholder('https://www.youtube.com/playlist?list=...');
      text.onChange((value) => { this.playlistUrl = value.trim(); this.updateStatus(); });
      setTimeout(() => text.inputEl.focus(), 0);
    });
    new obsidian.Setting(contentEl).setName('Output destination').addDropdown((dropdown) => dropdown
      .addOption('folder', 'Folder — one note per video')
      .addOption('note', 'Single note — list of links')
      .setValue(this.destinationMode)
      .onChange((value) => { this.destinationMode = value; this.renderDestinationSetting(); }));
    this.destinationContainer = contentEl.createDiv();
    this.renderDestinationSetting();
    this.statusEl = contentEl.createDiv({ cls: 'ytpi-modal__status' });
    this.progressEl = contentEl.createDiv({ cls: 'ytpi-progress' });
    this.progressBarEl = this.progressEl.createDiv({ cls: 'ytpi-progress__bar' });
    this.progressEl.style.display = 'none';
    const actions = contentEl.createDiv({ cls: 'ytpi-modal__actions' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    this.importButton = actions.createEl('button', { text: 'Import', cls: 'mod-cta' });
    this.importButton.addEventListener('click', () => this.startImport());
    this.updateStatus();
  }
  renderDestinationSetting() {
    if (!this.destinationContainer) return;
    this.destinationContainer.empty();
    const isFolder = this.destinationMode === 'folder';
    new obsidian.Setting(this.destinationContainer)
      .setName(isFolder ? 'Root destination folder' : 'Destination note')
      .setDesc(isFolder ? 'A playlist-named subfolder will be created here.' : 'Vault-relative Markdown path.')
      .addText((text) => {
        const initial = this.destinationPath || (isFolder ? '_Resources/YT' : '_Resources/YT/Playlist.md');
        text.setValue(initial).onChange((value) => { this.destinationPath = value.trim(); });
      });
  }
  updateStatus(message, kind) {
    if (!this.statusEl) return;
    this.statusEl.removeClass('is-error', 'is-success');
    if (kind) this.statusEl.addClass(kind === 'error' ? 'is-error' : 'is-success');
    if (message) return this.statusEl.setText(message);
    if (!this.playlistUrl) this.statusEl.setText('Paste a playlist URL.');
    else if (isValidPlaylistUrl(this.playlistUrl)) { this.statusEl.setText('Playlist URL detected.'); this.statusEl.addClass('is-success'); }
    else { this.statusEl.setText('The URL does not look like a YouTube playlist URL.'); this.statusEl.addClass('is-error'); }
  }
  setProgress(done, total) {
    this.progressEl.style.display = total > 0 ? '' : 'none';
    this.progressBarEl.style.width = `${total ? Math.min(100, Math.round(done / total * 100)) : 0}%`;
  }
  async startImport() {
    if (this.isRunning) return;
    if (!isValidPlaylistUrl(this.playlistUrl)) return this.updateStatus('Enter a valid YouTube playlist URL.', 'error');
    if (!this.destinationPath.trim()) return this.updateStatus('Choose a destination.', 'error');
    this.isRunning = true;
    this.importButton.disabled = true;
    this.updateStatus('Reading playlist metadata…');
    this.setProgress(0, 1);
    try {
      const result = await this.plugin.importPlaylist({
        playlistUrl: this.playlistUrl,
        destinationMode: this.destinationMode,
        destinationPath: this.destinationPath,
        onProgress: (done, total, label) => { this.setProgress(done, total); this.updateStatus(`${label} (${done}/${total})`); }
      });
      this.setProgress(result.total, result.total);
      this.updateStatus(`Done. Created ${result.created}, skipped ${result.skipped}, failed ${result.failed}.`, result.failed ? 'error' : 'success');
      new obsidian.Notice(`YouTube import: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed.`);
    } catch (error) {
      this.updateStatus(error instanceof Error ? error.message : String(error), 'error');
      new obsidian.Notice('YouTube playlist import failed.');
    } finally {
      this.isRunning = false;
      this.importButton.disabled = false;
    }
  }
  onClose() { this.contentEl.empty(); }
}

class SettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: `YouTube Playlist Importer ${PLUGIN_VERSION}` });
    containerEl.createEl('h3', { text: 'Obsidian → YouTube' });
    new obsidian.Setting(containerEl)
      .setName('Google OAuth Client ID')
      .setDesc('Create a Desktop app OAuth client in Google Cloud with YouTube Data API v3 enabled. Only the client ID is needed; PKCE is used.')
      .addText((text) => text.setPlaceholder('1234567890-....apps.googleusercontent.com').setValue(this.plugin.settings.googleClientId).onChange(async (value) => {
        this.plugin.settings.googleClientId = value.trim();
        await this.plugin.saveSettings();
      }));
    const connected = this.plugin.hasRefreshToken();
    new obsidian.Setting(containerEl)
      .setName('YouTube authorization')
      .setDesc(connected ? 'Connected. Refresh token is stored in Obsidian SecretStorage.' : 'Not connected.')
      .addButton((button) => button.setButtonText(connected ? 'Reconnect' : 'Connect').onClick(async () => {
        try { await this.plugin.authorizeYouTube(); new obsidian.Notice('YouTube account connected.'); this.display(); }
        catch (e) { new obsidian.Notice(e instanceof Error ? e.message : String(e)); }
      }))
      .addButton((button) => button.setButtonText('Disconnect').setDisabled(!connected).onClick(async () => {
        await this.plugin.disconnectYouTube();
        new obsidian.Notice('YouTube account disconnected.');
        this.display();
      }));
    new obsidian.Setting(containerEl).setName('Skip videos already in target playlist').addToggle((toggle) => toggle
      .setValue(this.plugin.settings.skipExistingInPlaylist).onChange(async (value) => {
        this.plugin.settings.skipExistingInPlaylist = value;
        await this.plugin.saveSettings();
      }));
    containerEl.createEl('h3', { text: 'YouTube → Obsidian' });
    new obsidian.Setting(containerEl).setName('yt-dlp executable').addText((text) => text
      .setValue(this.plugin.settings.ytDlpPath).onChange(async (value) => {
        this.plugin.settings.ytDlpPath = value.trim() || 'yt-dlp'; await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Default destination path').addText((text) => text
      .setValue(this.plugin.settings.defaultDestinationPath).onChange(async (value) => {
        this.plugin.settings.defaultDestinationPath = value.trim(); await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Create playlist subfolder').addToggle((toggle) => toggle
      .setValue(this.plugin.settings.createPlaylistSubfolder).onChange(async (value) => {
        this.plugin.settings.createPlaylistSubfolder = value; await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Create Auto Card Link block').addToggle((toggle) => toggle
      .setValue(this.plugin.settings.createAutoCardLink).onChange(async (value) => {
        this.plugin.settings.createAutoCardLink = value; await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Keep raw YouTube URL').addToggle((toggle) => toggle
      .setValue(this.plugin.settings.rawUrlOnOwnLine).onChange(async (value) => {
        this.plugin.settings.rawUrlOnOwnLine = value; await this.plugin.saveSettings();
      }));
  }
}

class YouTubePlaylistImporterPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.addCommand({ id: 'import-youtube-playlist', name: 'Import YouTube playlist to Obsidian', callback: () => new ImportModal(this.app, this).open() });
    this.addCommand({ id: 'send-current-note-to-youtube-playlist', name: 'Send links from current note to YouTube playlist', callback: () => new ExportToYouTubeModal(this.app, this).open() });
    this.addRibbonIcon('youtube', 'Send current note links to YouTube playlist', () => new ExportToYouTubeModal(this.app, this).open());
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  async saveSettings() { await this.saveData(this.settings); }
  hasRefreshToken() {
    try { return Boolean(this.app.secretStorage && this.app.secretStorage.getSecret(REFRESH_SECRET_ID)); }
    catch (_) { return false; }
  }
  getRefreshToken() {
    if (!this.app.secretStorage) throw new Error('This Obsidian version does not provide SecretStorage. Update Obsidian to 1.11.4 or newer.');
    return this.app.secretStorage.getSecret(REFRESH_SECRET_ID);
  }
  setRefreshToken(value) {
    if (!this.app.secretStorage) throw new Error('This Obsidian version does not provide SecretStorage.');
    this.app.secretStorage.setSecret(REFRESH_SECRET_ID, value || '');
  }
  async disconnectYouTube() {
    this.setRefreshToken('');
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async authorizeYouTube() {
    const clientId = String(this.settings.googleClientId || '').trim();
    if (!clientId) throw new Error('Configure Google OAuth Client ID in plugin settings first.');
    const verifier = randomToken(48);
    const challenge = pkceChallenge(verifier);
    const state = randomToken(24);
    const authorization = await new Promise((resolve, reject) => {
      let timer;
      const server = http.createServer((req, res) => {
        try {
          const requestUrl = new URL(req.url, 'http://127.0.0.1');
          if (requestUrl.pathname !== '/oauth2callback') { res.writeHead(404); res.end('Not found'); return; }
          const returnedState = requestUrl.searchParams.get('state');
          const error = requestUrl.searchParams.get('error');
          const code = requestUrl.searchParams.get('code');
          if (returnedState !== state) throw new Error('OAuth state mismatch.');
          if (error) throw new Error(`Google authorization failed: ${error}`);
          if (!code) throw new Error('Google did not return an authorization code.');
          const port = server.address().port;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>Connected</title><h2>YouTube connected to Obsidian</h2><p>You can close this browser tab and return to Obsidian.</p>');
          clearTimeout(timer);
          server.close();
          resolve({ code, redirectUri: `http://127.0.0.1:${port}/oauth2callback` });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(e instanceof Error ? e.message : String(e));
          clearTimeout(timer);
          server.close();
          reject(e);
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: YOUTUBE_SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        });
        await shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
      });
      timer = setTimeout(() => {
        try { server.close(); } catch (_) {}
        reject(new Error('YouTube authorization timed out.'));
      }, 180000);
    });
    const tokenResponse = await obsidian.requestUrl({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        client_id: clientId,
        code: authorization.code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: authorization.redirectUri
      }).toString(),
      throw: false
    });
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) throw new Error(`Token exchange failed (${tokenResponse.status}): ${tokenResponse.text}`);
    const token = tokenResponse.json;
    if (!token.access_token) throw new Error('Google token response did not contain an access token.');
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in || 3600) - 60) * 1000;
    if (token.refresh_token) this.setRefreshToken(token.refresh_token);
    if (!this.hasRefreshToken()) throw new Error('Google did not return a refresh token. Reconnect and approve consent.');
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) throw new Error('YouTube account is not connected.');
    const response = await obsidian.requestUrl({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        client_id: String(this.settings.googleClientId || '').trim(),
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`Could not refresh Google access token (${response.status}): ${response.text}`);
    const token = response.json;
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in || 3600) - 60) * 1000;
    return this.accessToken;
  }

  async youtubeRequest(url, options = {}) {
    const accessToken = await this.getAccessToken();
    const response = await obsidian.requestUrl({
      url,
      method: options.method || 'GET',
      headers: Object.assign({ Authorization: `Bearer ${accessToken}` }, options.headers || {}),
      contentType: options.body ? 'application/json' : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      throw: false
    });
    if (response.status === 401) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`YouTube API ${response.status}: ${response.text}`);
    return response.json;
  }

  async listMyPlaylists() {
    const result = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.youtubeRequest(`https://www.googleapis.com/youtube/v3/playlists?${params.toString()}`);
      for (const item of data.items || []) result.push({ id: item.id, title: item.snippet?.title || item.id });
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return result;
  }

  async listPlaylistVideoIds(playlistId) {
    const ids = new Set();
    let pageToken = '';
    do {
      const params = new URLSearchParams({ part: 'contentDetails', playlistId, maxResults: '50' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.youtubeRequest(`https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`);
      for (const item of data.items || []) {
        const id = item.contentDetails?.videoId;
        if (id) ids.add(id);
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return ids;
  }

  async exportVideoIdsToPlaylist(videoIds, playlistId, onProgress) {
    const uniqueIds = [...new Set(videoIds)];
    let existing = new Set();
    if (this.settings.skipExistingInPlaylist) existing = await this.listPlaylistVideoIds(playlistId);
    const toInsert = uniqueIds.filter((id) => !existing.has(id));
    let added = 0;
    let failed = 0;
    let processed = 0;
    for (const videoId of toInsert) {
      try {
        await this.youtubeRequest('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
          method: 'POST',
          body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }
        });
        added++;
      } catch (e) {
        console.error('[YouTube Playlist Importer] Failed to insert video', videoId, e);
        failed++;
      }
      processed++;
      if (onProgress) onProgress(processed, toInsert.length, `Sending ${videoId}`);
    }
    return { total: uniqueIds.length, totalToInsert: toInsert.length, processed, added, skippedExisting: uniqueIds.length - toInsert.length, failed };
  }

  async importPlaylist({ playlistUrl, destinationMode, destinationPath, onProgress }) {
    const args = ['--flat-playlist', '--dump-single-json', '--no-warnings', playlistUrl];
    const { stdout } = await runCommand(this.settings.ytDlpPath || 'yt-dlp', args);
    const playlist = JSON.parse(stdout);
    const entries = Array.isArray(playlist.entries) ? playlist.entries.filter(Boolean) : [];
    const total = entries.length;
    let created = 0, skipped = 0, failed = 0;
    if (!total) return { total: 0, created: 0, skipped: 0, failed: 0 };
    if (destinationMode === 'note') {
      let path = normalizeVaultPath(destinationPath);
      if (!path.toLowerCase().endsWith('.md')) path += '.md';
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent) await ensureFolder(this.app, parent);
      const seen = new Set();
      const lines = [`# ${playlist.title || 'YouTube playlist'}`, ''];
      for (let i = 0; i < entries.length; i++) {
        const url = getVideoUrl(entries[i]);
        if (seen.has(url)) { skipped++; continue; }
        seen.add(url);
        lines.push(url);
        if (onProgress) onProgress(i + 1, total, entries[i].title || entries[i].id || 'Video');
      }
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof obsidian.TFile) { await this.app.vault.modify(existing, lines.join('\n')); created = seen.size; }
      else { await this.app.vault.create(path, lines.join('\n')); created = seen.size; }
      return { total, created, skipped, failed };
    }
    const playlistFolder = this.settings.createPlaylistSubfolder ? sanitizeFileName(playlist.title || playlist.id || 'YouTube playlist') : '';
    const root = joinVaultPath(destinationPath, playlistFolder);
    await ensureFolder(this.app, root);
    for (let i = 0; i < entries.length; i++) {
      const video = entries[i];
      try {
        const title = sanitizeFileName(video.title || video.id || `Video ${i + 1}`);
        const path = joinVaultPath(root, `${title}.md`);
        if (this.app.vault.getAbstractFileByPath(path)) skipped++;
        else { await this.app.vault.create(path, buildVideoNote(video, playlist, this.settings)); created++; }
      } catch (e) { failed++; console.error('[YouTube Playlist Importer]', e); }
      if (onProgress) onProgress(i + 1, total, video.title || video.id || 'Video');
    }
    return { total, created, skipped, failed };
  }
}

module.exports = YouTubePlaylistImporterPlugin;

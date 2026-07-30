'use strict';

const obsidian = require('obsidian');
const childProcess = require('child_process');
const path = require('path');

const PLUGIN_VERSION = '0.1.2';
const DEFAULT_SETTINGS = {
  ytDlpPath: 'yt-dlp',
  defaultDestinationMode: 'folder',
  defaultDestinationPath: '_Resources/YT',
  createPlaylistSubfolder: true,
  createAutoCardLink: true,
  rawUrlOnOwnLine: true,
  enableDebugLogging: true,
  noteTypeProperty: 'type',
  noteTypeValue: 'youtube'
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

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function normalizeVaultPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

function joinVaultPath(...parts) {
  return parts.map(normalizeVaultPath).filter(Boolean).join('/');
}

function isValidPlaylistUrl(value) {
  try {
    const url = new URL(String(value).trim());
    const host = url.hostname.replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)
      && Boolean(url.searchParams.get('list'));
  } catch (_) {
    return false;
  }
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
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
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
    else if (!(existing instanceof obsidian.TFolder)) {
      throw new Error(`Cannot create folder “${current}”: a file already exists at this path.`);
    }
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
  const lines = [
    '```cardlink',
    `url: ${videoUrl}`,
    `title: ${yamlString(title)}`,
    `description: ${yamlString(description || '')}`,
    'host: www.youtube.com'
  ];
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
    '---',
    `title: ${yamlString(title)}`,
    `${settings.noteTypeProperty || 'type'}: ${yamlString(settings.noteTypeValue || 'youtube')}`,
    'source: youtube',
    `videoUrl: ${yamlString(videoUrl)}`,
    `videoId: ${yamlString(video.id || '')}`,
    `playlistUrl: ${yamlString(playlistUrl)}`,
    `playlistId: ${yamlString(playlist.id || '')}`,
    `channel: ${yamlString(channel)}`,
    `thumbnailUrl: ${yamlString(thumbnail)}`,
    `generated: ${yamlString(new Date().toISOString())}`,
    '---',
    '',
    `# ${title}`,
    ''
  ];
  if (settings.createAutoCardLink) lines.push(buildCardLink(videoUrl, title, description, thumbnail), '');
  if (settings.rawUrlOnOwnLine) lines.push(videoUrl, '');
  else if (!settings.createAutoCardLink) lines.push(`[Открыть на YouTube](${videoUrl})`, '');
  return lines.join('\n');
}

class ImportLogger {
  constructor(plugin, enabled) {
    this.plugin = plugin;
    this.enabled = enabled;
    this.startedAt = Date.now();
    this.lines = [];
  }
  log(level, message, data) {
    let line = `[${new Date().toISOString()}] [${level}] ${message}`;
    if (data !== undefined) {
      try { line += ` | ${typeof data === 'string' ? data : JSON.stringify(data)}`; }
      catch (_) { line += ' | [unserializable data]'; }
    }
    this.lines.push(line);
    if (level === 'ERROR') console.error('[YouTube Playlist Importer]', message, data || '');
    else console.log('[YouTube Playlist Importer]', message, data || '');
  }
  info(message, data) { this.log('INFO', message, data); }
  error(message, data) { this.log('ERROR', message, data); }
  async write(result, destination) {
    if (!this.enabled) return null;
    const folder = '.yt-playlist-importer';
    await ensureFolder(this.plugin.app, folder);
    const finished = new Date();
    const stamp = finished.toISOString().replace(/[:.]/g, '-');
    const logPath = `${folder}/import-${stamp}.md`;
    const report = [
      '# YouTube Playlist Importer log', '',
      `- Plugin version: ${PLUGIN_VERSION}`,
      `- Started: ${new Date(this.startedAt).toISOString()}`,
      `- Finished: ${finished.toISOString()}`,
      `- Destination: ${destination || ''}`,
      `- Total: ${result.total}`,
      `- Created: ${result.created}`,
      `- Skipped: ${result.skipped}`,
      `- Failed: ${result.failed}`,
      `- Elapsed: ${((Date.now() - this.startedAt) / 1000).toFixed(1)} s`, '',
      '## Events', '', '```text', ...this.lines, '```', ''
    ].join('\n');
    await this.plugin.app.vault.create(logPath, report);
    return logPath;
  }
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
    else if (isValidPlaylistUrl(this.playlistUrl)) {
      this.statusEl.setText('Playlist URL detected.');
      this.statusEl.addClass('is-success');
    } else {
      this.statusEl.setText('The URL does not look like a YouTube playlist URL.');
      this.statusEl.addClass('is-error');
    }
  }
  setProgress(done, total) {
    this.progressEl.style.display = total > 0 ? '' : 'none';
    this.progressBarEl.style.width = `${total ? Math.min(100, Math.round((done / total) * 100)) : 0}%`;
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
        onProgress: (done, total, label) => {
          this.setProgress(done, total);
          this.updateStatus(`${label} (${done}/${total})`);
        }
      });
      this.setProgress(result.total, result.total);
      this.updateStatus(`Done. Created ${result.created}, skipped ${result.skipped}, failed ${result.failed}.${result.logPath ? ` Log: ${result.logPath}` : ''}`, result.failed ? 'error' : 'success');
      new obsidian.Notice(`YouTube import: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed.`);
    } catch (error) {
      console.error('[YouTube Playlist Importer]', error);
      this.updateStatus(error instanceof Error ? error.message : String(error), 'error');
      new obsidian.Notice('YouTube playlist import failed. See the modal and debug log.');
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
    new obsidian.Setting(containerEl).setName('yt-dlp executable').addText((text) => text
      .setValue(this.plugin.settings.ytDlpPath).onChange(async (value) => {
        this.plugin.settings.ytDlpPath = value.trim() || 'yt-dlp'; await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Default destination path').addText((text) => text
      .setValue(this.plugin.settings.defaultDestinationPath).onChange(async (value) => {
        this.plugin.settings.defaultDestinationPath = value.trim(); await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Create playlist subfolder')
      .setDesc('Creates Root folder / Playlist title / Video title.md.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.createPlaylistSubfolder).onChange(async (value) => {
        this.plugin.settings.createPlaylistSubfolder = value; await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Create Auto Card Link block')
      .setDesc('Writes a cardlink YAML code block compatible with obsidian-auto-card-link.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.createAutoCardLink).onChange(async (value) => {
        this.plugin.settings.createAutoCardLink = value; await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Keep raw YouTube URL')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.rawUrlOnOwnLine).onChange(async (value) => {
        this.plugin.settings.rawUrlOnOwnLine = value; await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl).setName('Enable debug logging')
      .setDesc('Creates a detailed report in .yt-playlist-importer/.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.enableDebugLogging).onChange(async (value) => {
        this.plugin.settings.enableDebugLogging = value; await this.plugin.saveSettings();
      }));
  }
}

class YouTubePlaylistImporterPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addCommand({ id: 'import-youtube-playlist', name: 'Import YouTube playlist', callback: () => new ImportModal(this.app, this).open() });
    this.addSettingTab(new SettingsTab(this.app, this));
  }
  async saveSettings() { await this.saveData(this.settings); }
  async fetchPlaylist(url, logger) {
    const args = ['--flat-playlist', '--dump-single-json', '--no-warnings', '--ignore-errors', '--yes-playlist', url];
    logger.info('Starting yt-dlp', { command: this.settings.ytDlpPath, args });
    let output;
    try { output = await runCommand(this.settings.ytDlpPath, args); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('yt-dlp failed', message);
      if (/ENOENT|not recognized|cannot find/i.test(message)) throw new Error('yt-dlp was not found. Install it or set its full path in plugin settings.');
      throw error;
    }
    let playlist;
    try { playlist = JSON.parse(output.stdout); }
    catch (_) { throw new Error('yt-dlp returned invalid JSON. Update yt-dlp and try again.'); }
    if (!playlist || !Array.isArray(playlist.entries)) throw new Error('No playlist entries were found.');
    playlist.original_url = url;
    logger.info('Playlist loaded', { title: playlist.title, id: playlist.id, entries: playlist.entries.length });
    return playlist;
  }
  async importPlaylist(options) {
    const logger = new ImportLogger(this, this.settings.enableDebugLogging);
    logger.info('Import requested', options);
    let result = { total: 0, created: 0, skipped: 0, failed: 0 };
    let destination = options.destinationPath;
    try {
      const playlist = await this.fetchPlaylist(options.playlistUrl, logger);
      const entries = playlist.entries.filter(Boolean);
      if (!entries.length) throw new Error('The playlist contains no accessible videos.');
      if (options.destinationMode === 'folder') {
        destination = normalizeVaultPath(options.destinationPath);
        if (this.settings.createPlaylistSubfolder) destination = joinVaultPath(destination, sanitizeFileName(playlist.title || playlist.id || 'YouTube playlist'));
        result = await this.importToFolder(entries, playlist, { ...options, destinationPath: destination }, logger);
      } else result = await this.importToSingleNote(entries, playlist, options, logger);
    } catch (error) {
      logger.error('Import aborted', error instanceof Error ? error.stack || error.message : String(error));
      try { await logger.write(result, destination); } catch (_) {}
      throw error;
    }
    result.logPath = await logger.write(result, destination);
    return result;
  }
  async importToFolder(entries, playlist, options, logger) {
    const folder = normalizeVaultPath(options.destinationPath);
    await ensureFolder(this.app, folder);
    logger.info('Destination folder ready', folder);
    let created = 0, skipped = 0, failed = 0;
    const knownVideoIds = new Set();
    for (const file of this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${folder}/`))) {
      const cache = this.app.metadataCache.getFileCache(file);
      const id = cache && cache.frontmatter && cache.frontmatter.videoId;
      if (id) knownVideoIds.add(String(id));
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const label = entry.title || entry.id || 'Video';
      options.onProgress(index + 1, entries.length, label);
      try {
        const videoId = String(entry.id || entry.url || '');
        if (videoId && knownVideoIds.has(videoId)) {
          skipped += 1;
          logger.info('Skipped existing video', { videoId, title: label });
          continue;
        }
        const baseName = sanitizeFileName(label);
        let notePath = joinVaultPath(folder, `${baseName}.md`);
        let suffix = 2;
        while (this.app.vault.getAbstractFileByPath(notePath)) notePath = joinVaultPath(folder, `${baseName} (${suffix++}).md`);
        logger.info('Creating note', { notePath, videoId, url: getVideoUrl(entry) });
        const createdFile = await this.app.vault.create(notePath, buildVideoNote(entry, playlist, this.settings));
        if (!(createdFile instanceof obsidian.TFile) || !this.app.vault.getAbstractFileByPath(notePath)) throw new Error(`Obsidian did not confirm creation of ${notePath}`);
        created += 1;
        if (videoId) knownVideoIds.add(videoId);
        logger.info('Note created', notePath);
      } catch (error) {
        failed += 1;
        logger.error('Failed to create note', { title: label, id: entry.id || '', error: error instanceof Error ? error.stack || error.message : String(error) });
      }
    }
    options.onProgress(entries.length, entries.length, 'Finished');
    logger.info('Folder import finished', { total: entries.length, created, skipped, failed, folder });
    return { total: entries.length, created, skipped, failed };
  }
  async importToSingleNote(entries, playlist, options, logger) {
    let notePath = normalizeVaultPath(options.destinationPath);
    if (!notePath.toLowerCase().endsWith('.md')) notePath += '.md';
    const parent = path.posix.dirname(notePath);
    if (parent && parent !== '.') await ensureFolder(this.app, parent);
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    const existingText = existing instanceof obsidian.TFile ? await this.app.vault.cachedRead(existing) : '';
    const lines = [];
    if (!existingText.trim()) lines.push('---', `title: ${yamlString(playlist.title || 'YouTube playlist')}`, 'type: youtube-playlist', `playlistUrl: ${yamlString(playlist.original_url || options.playlistUrl)}`, '---', '', `# ${playlist.title || 'YouTube playlist'}`, '');
    let created = 0, skipped = 0;
    for (const entry of entries) {
      const url = getVideoUrl(entry);
      if (existingText.includes(url)) { skipped += 1; continue; }
      const title = entry.title || entry.id || 'YouTube video';
      lines.push(`## ${title}`, '', this.settings.createAutoCardLink ? buildCardLink(url, title, entry.description || '', getThumbnail(entry)) : url, '');
      if (this.settings.rawUrlOnOwnLine && this.settings.createAutoCardLink) lines.push(url, '');
      created += 1;
    }
    const addition = lines.join('\n');
    if (existing instanceof obsidian.TFile) { if (addition) await this.app.vault.append(existing, addition); }
    else await this.app.vault.create(notePath, addition);
    logger.info('Single note import finished', { notePath, created, skipped });
    options.onProgress(entries.length, entries.length, 'Finished');
    return { total: entries.length, created, skipped, failed: 0 };
  }
}

module.exports = YouTubePlaylistImporterPlugin;

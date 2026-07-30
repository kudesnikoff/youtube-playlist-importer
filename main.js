'use strict';

const obsidian = require('obsidian');
const childProcess = require('child_process');
const path = require('path');

const DEFAULT_SETTINGS = {
  ytDlpPath: 'yt-dlp',
  defaultDestinationMode: 'folder',
  defaultDestinationPath: '_Resources/YT',
  includeDescription: true,
  includeThumbnail: true,
  useVideoTitleAsFilename: true,
  rawUrlOnOwnLine: true,
  noteTypeProperty: 'type',
  noteTypeValue: 'youtube'
};

function sanitizeFileName(input) {
  const cleaned = String(input || 'Untitled')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.slice(0, 180) || 'Untitled';
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function normalizeVaultPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

function isValidPlaylistUrl(value) {
  try {
    const url = new URL(String(value).trim());
    const host = url.hostname.replace(/^www\./, '');
    const validHost = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
    return validHost && Boolean(url.searchParams.get('list'));
  } catch (_) {
    return false;
  }
}

function runCommand(command, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      windowsHide: true,
      shell: false
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`yt-dlp timeout after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
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
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function buildVideoNote(video, playlist, settings) {
  const videoUrl = video.webpage_url || video.url || `https://www.youtube.com/watch?v=${video.id}`;
  const title = video.title || video.id || 'YouTube video';
  const thumbnail = video.thumbnail || (Array.isArray(video.thumbnails) && video.thumbnails.length ? video.thumbnails[video.thumbnails.length - 1].url : '');
  const description = video.description || '';
  const durationSeconds = Number(video.duration || 0);
  const duration = formatDuration(durationSeconds);
  const channel = video.channel || video.uploader || playlist.channel || playlist.uploader || '';
  const channelUrl = video.channel_url || video.uploader_url || '';
  const uploadDate = video.upload_date || '';
  const playlistId = playlist.id || '';
  const playlistUrl = playlist.webpage_url || playlist.original_url || '';
  const playlistIndex = video.playlist_index || video.playlist_autonumber || '';
  const generated = new Date().toISOString();

  const lines = [
    '---',
    `title: ${yamlString(title)}`,
    `${settings.noteTypeProperty || 'type'}: ${yamlString(settings.noteTypeValue || 'youtube')}`,
    'source: youtube',
    `channel: ${yamlString(channel)}`,
    `channelUrl: ${yamlString(channelUrl)}`,
    `videoUrl: ${yamlString(videoUrl)}`,
    `videoId: ${yamlString(video.id || '')}`,
    `playlistUrl: ${yamlString(playlistUrl)}`,
    `playlistId: ${yamlString(playlistId)}`,
    `playlistIndex: ${playlistIndex || 'null'}`,
    `thumbnailUrl: ${yamlString(thumbnail)}`,
    `uploadDate: ${yamlString(uploadDate)}`,
    `durationSeconds: ${durationSeconds || 0}`,
    `duration: ${yamlString(duration)}`,
    `generated: ${yamlString(generated)}`,
    '---',
    '',
    `# ${title}`,
    ''
  ];

  if (settings.includeThumbnail && thumbnail) {
    lines.push(`![${title}](${thumbnail})`, '');
  }

  lines.push('## Видео', '');
  if (settings.rawUrlOnOwnLine) lines.push(videoUrl);
  else lines.push(`[Открыть на YouTube](${videoUrl})`);
  lines.push('');

  if (settings.includeDescription && description) {
    lines.push('## Описание', '', description.trim(), '');
  }

  return lines.join('\n');
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
    contentEl.createEl('h2', { text: 'Import YouTube playlist', cls: 'ytpi-modal__title' });

    new obsidian.Setting(contentEl)
      .setName('Playlist URL')
      .setDesc('A public or accessible YouTube playlist URL containing the list parameter.')
      .addText((text) => {
        text.setPlaceholder('https://www.youtube.com/playlist?list=...');
        text.onChange((value) => {
          this.playlistUrl = value.trim();
          this.updateStatus();
        });
        setTimeout(() => text.inputEl.focus(), 0);
      });

    new obsidian.Setting(contentEl)
      .setName('Output destination')
      .setDesc('Create one Markdown note per video in a folder, or append all video links to one Markdown note.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('folder', 'Folder — one note per video')
          .addOption('note', 'Single note — list of links')
          .setValue(this.destinationMode)
          .onChange((value) => {
            this.destinationMode = value;
            this.renderDestinationSetting();
          });
      });

    this.destinationContainer = contentEl.createDiv();
    this.renderDestinationSetting();

    this.statusEl = contentEl.createDiv({ cls: 'ytpi-modal__status' });
    this.progressEl = contentEl.createDiv({ cls: 'ytpi-progress' });
    this.progressBarEl = this.progressEl.createDiv({ cls: 'ytpi-progress__bar' });
    this.progressEl.style.display = 'none';

    const actions = contentEl.createDiv({ cls: 'ytpi-modal__actions' });
    const cancelButton = actions.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => this.close());
    this.importButton = actions.createEl('button', { text: 'Import', cls: 'mod-cta' });
    this.importButton.addEventListener('click', () => this.startImport());

    this.updateStatus();
  }

  renderDestinationSetting() {
    if (!this.destinationContainer) return;
    this.destinationContainer.empty();
    const isFolder = this.destinationMode === 'folder';
    new obsidian.Setting(this.destinationContainer)
      .setName(isFolder ? 'Destination folder' : 'Destination note')
      .setDesc(isFolder
        ? 'Vault-relative folder path. It will be created automatically.'
        : 'Vault-relative Markdown path. Example: _Resources/YT/Playlist.md')
      .addText((text) => {
        const initial = this.destinationPath || (isFolder ? '_Resources/YT' : '_Resources/YT/Playlist.md');
        text.setValue(initial);
        text.setPlaceholder(isFolder ? '_Resources/YT' : '_Resources/YT/Playlist.md');
        text.onChange((value) => { this.destinationPath = value.trim(); });
      });
  }

  updateStatus(message, kind) {
    if (!this.statusEl) return;
    this.statusEl.removeClass('is-error', 'is-success');
    if (kind) this.statusEl.addClass(kind === 'error' ? 'is-error' : 'is-success');
    if (message) {
      this.statusEl.setText(message);
      return;
    }
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
    if (!this.progressEl || !this.progressBarEl) return;
    this.progressEl.style.display = total > 0 ? '' : 'none';
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    this.progressBarEl.style.width = `${percent}%`;
  }

  async startImport() {
    if (this.isRunning) return;
    if (!isValidPlaylistUrl(this.playlistUrl)) {
      this.updateStatus('Enter a valid YouTube playlist URL.', 'error');
      return;
    }
    if (!this.destinationPath.trim()) {
      this.updateStatus('Choose a destination folder or note.', 'error');
      return;
    }

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
      this.updateStatus(`Done. Created ${result.created}, skipped ${result.skipped}, failed ${result.failed}.`, 'success');
      new obsidian.Notice(`YouTube import finished: ${result.created} created, ${result.skipped} skipped.`);
    } catch (error) {
      console.error('[YouTube Playlist Importer]', error);
      this.updateStatus(error instanceof Error ? error.message : String(error), 'error');
      new obsidian.Notice('YouTube playlist import failed. See the modal or developer console.');
    } finally {
      this.isRunning = false;
      this.importButton.disabled = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'YouTube Playlist Importer' });

    new obsidian.Setting(containerEl)
      .setName('yt-dlp executable')
      .setDesc('Command name or full path to yt-dlp.exe. Example: yt-dlp or C:\\Tools\\yt-dlp.exe')
      .addText((text) => text
        .setValue(this.plugin.settings.ytDlpPath)
        .onChange(async (value) => {
          this.plugin.settings.ytDlpPath = value.trim() || 'yt-dlp';
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Default destination')
      .addDropdown((dropdown) => dropdown
        .addOption('folder', 'Folder — one note per video')
        .addOption('note', 'Single note — list of links')
        .setValue(this.plugin.settings.defaultDestinationMode)
        .onChange(async (value) => {
          this.plugin.settings.defaultDestinationMode = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Default destination path')
      .addText((text) => text
        .setValue(this.plugin.settings.defaultDestinationPath)
        .onChange(async (value) => {
          this.plugin.settings.defaultDestinationPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Type property name')
      .setDesc('Frontmatter property used for the source type.')
      .addText((text) => text
        .setValue(this.plugin.settings.noteTypeProperty)
        .onChange(async (value) => {
          this.plugin.settings.noteTypeProperty = value.trim() || 'type';
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Type property value')
      .setDesc('Default value written to the type property.')
      .addText((text) => text
        .setValue(this.plugin.settings.noteTypeValue)
        .onChange(async (value) => {
          this.plugin.settings.noteTypeValue = value.trim() || 'youtube';
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Include thumbnail')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeThumbnail)
        .onChange(async (value) => {
          this.plugin.settings.includeThumbnail = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Include YouTube description')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeDescription)
        .onChange(async (value) => {
          this.plugin.settings.includeDescription = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Raw URL on its own line')
      .setDesc('Keeps links compatible with card-style plugins. Programmatic insertion may still require those plugins to refresh the note.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.rawUrlOnOwnLine)
        .onChange(async (value) => {
          this.plugin.settings.rawUrlOnOwnLine = value;
          await this.plugin.saveSettings();
        }));
  }
}

class YouTubePlaylistImporterPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addCommand({
      id: 'import-youtube-playlist',
      name: 'Import YouTube playlist',
      callback: () => new ImportModal(this.app, this).open()
    });

    this.addSettingTab(new SettingsTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async fetchPlaylist(url) {
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--ignore-errors',
      '--yes-playlist',
      url
    ];
    let output;
    try {
      output = await runCommand(this.settings.ytDlpPath, args, 300000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not recognized|cannot find/i.test(message)) {
        throw new Error('yt-dlp was not found. Install it or set the full path in the plugin settings.');
      }
      throw error;
    }

    let playlist;
    try {
      playlist = JSON.parse(output.stdout);
    } catch (_) {
      throw new Error('yt-dlp returned invalid JSON. Update yt-dlp and try again.');
    }

    if (!playlist || !Array.isArray(playlist.entries)) {
      throw new Error('No playlist entries were found. The playlist may be private, unavailable, or invalid.');
    }
    playlist.original_url = url;
    return playlist;
  }

  async importPlaylist(options) {
    const playlist = await this.fetchPlaylist(options.playlistUrl);
    const entries = playlist.entries.filter(Boolean);
    if (!entries.length) throw new Error('The playlist contains no accessible videos.');

    if (options.destinationMode === 'folder') {
      return this.importToFolder(entries, playlist, options);
    }
    return this.importToSingleNote(entries, playlist, options);
  }

  async importToFolder(entries, playlist, options) {
    const folder = normalizeVaultPath(options.destinationPath);
    await ensureFolder(this.app, folder);

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      options.onProgress(index, entries.length, entry.title || entry.id || 'Video');
      try {
        const titlePart = this.settings.useVideoTitleAsFilename ? sanitizeFileName(entry.title || entry.id) : sanitizeFileName(entry.id);
        const baseName = `${String(index + 1).padStart(4, '0')} ${titlePart}`;
        let notePath = `${folder}/${baseName}.md`;
        let suffix = 2;
        while (this.app.vault.getAbstractFileByPath(notePath)) {
          const existing = this.app.vault.getAbstractFileByPath(notePath);
          if (existing instanceof obsidian.TFile) {
            const text = await this.app.vault.cachedRead(existing);
            if (text.includes(`videoId: ${yamlString(entry.id || '')}`)) {
              skipped += 1;
              notePath = '';
              break;
            }
          }
          notePath = `${folder}/${baseName} ${suffix}.md`;
          suffix += 1;
        }
        if (!notePath) continue;
        await this.app.vault.create(notePath, buildVideoNote(entry, playlist, this.settings));
        created += 1;
      } catch (error) {
        failed += 1;
        console.error('[YouTube Playlist Importer] Failed entry', entry, error);
      }
    }

    options.onProgress(entries.length, entries.length, 'Finished');
    return { total: entries.length, created, skipped, failed };
  }

  async importToSingleNote(entries, playlist, options) {
    let notePath = normalizeVaultPath(options.destinationPath);
    if (!notePath.toLowerCase().endsWith('.md')) notePath += '.md';
    const parent = path.posix.dirname(notePath);
    if (parent && parent !== '.') await ensureFolder(this.app, parent);

    const existing = this.app.vault.getAbstractFileByPath(notePath);
    let existingText = '';
    if (existing instanceof obsidian.TFile) existingText = await this.app.vault.cachedRead(existing);

    const lines = [];
    if (!existingText.trim()) {
      lines.push(
        '---',
        `title: ${yamlString(playlist.title || 'YouTube playlist')}`,
        `${this.settings.noteTypeProperty || 'type'}: ${yamlString(this.settings.noteTypeValue || 'youtube')}`,
        'source: youtube-playlist',
        `playlistUrl: ${yamlString(playlist.webpage_url || playlist.original_url || options.playlistUrl)}`,
        `playlistId: ${yamlString(playlist.id || '')}`,
        `videoCount: ${entries.length}`,
        `generated: ${yamlString(new Date().toISOString())}`,
        '---',
        '',
        `# ${playlist.title || 'YouTube playlist'}`,
        ''
      );
    } else if (!existingText.endsWith('\n')) {
      lines.push('');
    }

    let created = 0;
    let skipped = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      options.onProgress(index, entries.length, entry.title || entry.id || 'Video');
      const url = entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`;
      if (existingText.includes(url)) {
        skipped += 1;
        continue;
      }
      const title = entry.title || entry.id || 'YouTube video';
      lines.push(`## ${index + 1}. ${title}`, '', url, '');
      created += 1;
    }

    const addition = lines.join('\n');
    if (existing instanceof obsidian.TFile) {
      if (addition) await this.app.vault.append(existing, addition);
    } else {
      await this.app.vault.create(notePath, addition);
    }

    options.onProgress(entries.length, entries.length, 'Finished');
    return { total: entries.length, created, skipped, failed: 0 };
  }
}

module.exports = YouTubePlaylistImporterPlugin;

'use strict';

const obsidian = require('obsidian');
const childProcess = require('child_process');
const path = require('path');

const DEFAULT_SETTINGS = {
  ytDlpPath: 'yt-dlp',
  defaultDestinationMode: 'folder',
  defaultDestinationPath: '_Resources/YT',
  includeDescription: false,
  includeThumbnail: true,
  useVideoTitleAsFilename: true,
  rawUrlOnOwnLine: true,
  useAutoCardLink: true,
  enableDebugLogging: true,
  logFolderPath: '.yt-importer',
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

function yamlBlockString(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
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
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current);
    } else if (!(existing instanceof obsidian.TFolder)) {
      throw new Error(`Cannot create folder because a file exists at: ${current}`);
    }
  }
}

function buildCardLink(videoUrl, title, description, thumbnail) {
  const lines = [
    '```cardlink',
    `url: ${videoUrl}`,
    `title: ${yamlString(title)}`,
    'host: www.youtube.com'
  ];
  if (description) lines.push(`description: |-`, yamlBlockString(description));
  if (thumbnail) lines.push(`image: ${thumbnail}`);
  lines.push('```');
  return lines.join('\n');
}

function buildVideoNote(video, playlist, settings) {
  const videoId = video.id || '';
  const videoUrl = video.webpage_url || video.url || `https://www.youtube.com/watch?v=${videoId}`;
  const title = video.title || videoId || 'YouTube video';
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
    `videoId: ${yamlString(videoId)}`,
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

  if (settings.useAutoCardLink) {
    lines.push(buildCardLink(videoUrl, title, description, thumbnail), '');
  } else {
    if (settings.includeThumbnail && thumbnail) lines.push(`![${title}](${thumbnail})`, '');
    if (settings.rawUrlOnOwnLine) lines.push(videoUrl, '');
    else lines.push(`[Открыть на YouTube](${videoUrl})`, '');
  }

  if (settings.includeDescription && description) {
    lines.push('## Описание', '', description.trim(), '');
  }

  return lines.join('\n');
}

class ImportLogger {
  constructor(plugin) {
    this.plugin = plugin;
    this.lines = [];
    this.errors = [];
    this.startedAt = new Date();
  }

  stamp() {
    return new Date().toISOString();
  }

  info(message) {
    const line = `[${this.stamp()}] INFO ${message}`;
    this.lines.push(line);
    console.log('[YouTube Playlist Importer]', message);
  }

  error(message, error) {
    const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error || '');
    const line = `[${this.stamp()}] ERROR ${message}${details ? `\n${details}` : ''}`;
    this.lines.push(line);
    this.errors.push(line);
    console.error('[YouTube Playlist Importer]', message, error);
  }

  async writeFile(filePath, content) {
    const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof obsidian.TFile) await this.plugin.app.vault.modify(existing, content);
    else await this.plugin.app.vault.create(filePath, content);
  }

  async flush(summary) {
    if (!this.plugin.settings.enableDebugLogging) return;
    const folder = normalizeVaultPath(this.plugin.settings.logFolderPath || '.yt-importer');
    await ensureFolder(this.plugin.app, folder);
    const runId = this.startedAt.toISOString().replace(/[:.]/g, '-');
    const report = [
      '# YouTube Playlist Import Report',
      '',
      `- Started: ${this.startedAt.toISOString()}`,
      `- Finished: ${new Date().toISOString()}`,
      `- Playlist: ${summary.playlistUrl}`,
      `- Destination: ${summary.destination}`,
      `- Total: ${summary.total}`,
      `- Created: ${summary.created}`,
      `- Skipped: ${summary.skipped}`,
      `- Failed: ${summary.failed}`,
      '',
      '## Log',
      '',
      '```text',
      ...this.lines,
      '```',
      ''
    ].join('\n');
    await this.writeFile(`${folder}/latest-report.md`, report);
    await this.writeFile(`${folder}/report-${runId}.md`, report);
    if (this.errors.length) {
      await this.writeFile(`${folder}/latest-errors.md`, ['# YouTube Playlist Import Errors', '', '```text', ...this.errors, '```', ''].join('\n'));
    }
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
      new obsidian.Notice(`YouTube import finished: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed.`);
    } catch (error) {
      console.error('[YouTube Playlist Importer]', error);
      this.updateStatus(error instanceof Error ? error.message : String(error), 'error');
      new obsidian.Notice('YouTube playlist import failed. See the modal or debug report.');
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
      .setName('Use Auto Card Link format')
      .setDesc('Writes a ```cardlink YAML block compatible with nekoshita/obsidian-auto-card-link. The Auto Card Link plugin must be installed and enabled to render the card.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useAutoCardLink)
        .onChange(async (value) => {
          this.plugin.settings.useAutoCardLink = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Enable debug logging')
      .setDesc('Creates import reports and error logs inside the vault.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enableDebugLogging)
        .onChange(async (value) => {
          this.plugin.settings.enableDebugLogging = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Log folder')
      .setDesc('Vault-relative folder for import reports.')
      .addText((text) => text
        .setValue(this.plugin.settings.logFolderPath)
        .onChange(async (value) => {
          this.plugin.settings.logFolderPath = value.trim() || '.yt-importer';
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
      .setDesc('Used when Auto Card Link format is disabled.')
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

  async fetchPlaylist(url, logger) {
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--ignore-errors',
      '--yes-playlist',
      url
    ];
    logger.info(`Running yt-dlp for playlist: ${url}`);
    let output;
    try {
      output = await runCommand(this.settings.ytDlpPath, args, 300000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('yt-dlp failed', error);
      if (/ENOENT|not recognized|cannot find/i.test(message)) {
        throw new Error('yt-dlp was not found. Install it or set the full path in the plugin settings.');
      }
      throw error;
    }

    let playlist;
    try {
      playlist = JSON.parse(output.stdout);
    } catch (error) {
      logger.error('Failed to parse yt-dlp JSON', error);
      throw new Error('yt-dlp returned invalid JSON. Update yt-dlp and try again.');
    }

    if (!playlist || !Array.isArray(playlist.entries)) {
      throw new Error('No playlist entries were found. The playlist may be private, unavailable, or invalid.');
    }
    playlist.original_url = url;
    logger.info(`Playlist parsed: ${playlist.title || playlist.id || 'Untitled'}; entries=${playlist.entries.length}`);
    return playlist;
  }

  async importPlaylist(options) {
    const logger = new ImportLogger(this);
    let summary = {
      playlistUrl: options.playlistUrl,
      destination: normalizeVaultPath(options.destinationPath),
      total: 0,
      created: 0,
      skipped: 0,
      failed: 0
    };

    try {
      const playlist = await this.fetchPlaylist(options.playlistUrl, logger);
      const entries = playlist.entries.filter(Boolean);
      if (!entries.length) throw new Error('The playlist contains no accessible videos.');
      summary.total = entries.length;
      logger.info(`Import started to ${summary.destination}`);

      const result = options.destinationMode === 'folder'
        ? await this.importToFolder(entries, playlist, options, logger)
        : await this.importToSingleNote(entries, playlist, options, logger);
      summary = Object.assign(summary, result);
      logger.info(`Import finished: created=${result.created}, skipped=${result.skipped}, failed=${result.failed}`);
      return result;
    } catch (error) {
      logger.error('Import aborted', error);
      throw error;
    } finally {
      try {
        await logger.flush(summary);
      } catch (logError) {
        console.error('[YouTube Playlist Importer] Failed to write log', logError);
      }
    }
  }

  async importToFolder(entries, playlist, options, logger) {
    const folder = normalizeVaultPath(options.destinationPath);
    await ensureFolder(this.app, folder);
    logger.info(`Destination folder ready: ${folder}`);

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const label = entry.title || entry.id || 'Video';
      options.onProgress(index, entries.length, label);
      try {
        const titlePart = this.settings.useVideoTitleAsFilename
          ? sanitizeFileName(entry.title || entry.id)
          : sanitizeFileName(entry.id);
        let notePath = `${folder}/${titlePart}.md`;
        let suffix = 2;

        while (this.app.vault.getAbstractFileByPath(notePath)) {
          const existing = this.app.vault.getAbstractFileByPath(notePath);
          if (existing instanceof obsidian.TFile) {
            const text = await this.app.vault.cachedRead(existing);
            const idNeedle = `videoId: ${yamlString(entry.id || '')}`;
            const urlNeedle = entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`;
            if (text.includes(idNeedle) || text.includes(urlNeedle)) {
              skipped += 1;
              logger.info(`Skipped existing note: ${notePath}`);
              notePath = '';
              break;
            }
          }
          notePath = `${folder}/${titlePart} (${suffix}).md`;
          suffix += 1;
        }

        if (!notePath) continue;
        logger.info(`Creating note: ${notePath}`);
        const createdFile = await this.app.vault.create(notePath, buildVideoNote(entry, playlist, this.settings));
        if (!(createdFile instanceof obsidian.TFile)) throw new Error(`Vault did not return a file for ${notePath}`);
        const verified = this.app.vault.getAbstractFileByPath(notePath);
        if (!(verified instanceof obsidian.TFile)) throw new Error(`Created file could not be verified: ${notePath}`);
        created += 1;
        logger.info(`Created note: ${notePath}`);
      } catch (error) {
        failed += 1;
        logger.error(`Failed entry ${entry.id || index + 1}: ${label}`, error);
      }
    }

    options.onProgress(entries.length, entries.length, 'Finished');
    return { total: entries.length, created, skipped, failed };
  }

  async importToSingleNote(entries, playlist, options, logger) {
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
        logger.info(`Skipped existing URL in single note: ${url}`);
        continue;
      }
      const title = entry.title || entry.id || 'YouTube video';
      lines.push(`## ${index + 1}. ${title}`, '');
      if (this.settings.useAutoCardLink) {
        lines.push(buildCardLink(url, title, entry.description || '', entry.thumbnail || ''), '');
      } else {
        lines.push(url, '');
      }
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

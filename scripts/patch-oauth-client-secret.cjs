// Copyright (c) 2026 Kudesnik
// Licensed under the PolyForm Noncommercial License 1.0.0.
// Commercial use requires separate permission.

const fs = require('fs');

const file = 'main.js';
let s = fs.readFileSync(file, 'utf8');

const licenseHeader = `// Copyright (c) 2026 Kudesnik\n// Licensed under the PolyForm Noncommercial License 1.0.0.\n// Commercial use requires separate permission.\n\n`;
if (!s.startsWith('// Copyright (c) 2026 Kudesnik')) s = licenseHeader + s;

function replaceOnce(from, to, label) {
  if (!s.includes(from)) throw new Error(`Patch target not found: ${label}`);
  s = s.replace(from, to);
}

replaceOnce(
  "const PLUGIN_VERSION = '0.2.0';",
  "const PLUGIN_VERSION = '0.2.0-beta.2';",
  'plugin version'
);

replaceOnce(
  "const REFRESH_SECRET_ID = 'youtube-playlist-importer-refresh-token';",
  "const REFRESH_SECRET_ID = 'youtube-playlist-importer-refresh-token';\nconst CLIENT_SECRET_ID = 'youtube-playlist-importer-google-client-secret';",
  'client secret id'
);

replaceOnce(
`    new obsidian.Setting(containerEl)
      .setName('Google OAuth Client ID')
      .setDesc('Create a Desktop app OAuth client in Google Cloud with YouTube Data API v3 enabled. Only the client ID is needed; PKCE is used.')
      .addText((text) => text.setPlaceholder('1234567890-....apps.googleusercontent.com').setValue(this.plugin.settings.googleClientId).onChange(async (value) => {
        this.plugin.settings.googleClientId = value.trim();
        await this.plugin.saveSettings();
      }));
    const connected = this.plugin.hasRefreshToken();`,
`    new obsidian.Setting(containerEl)
      .setName('Google OAuth Client ID')
      .setDesc('Desktop app OAuth Client ID from Google Cloud.')
      .addText((text) => text.setPlaceholder('1234567890-....apps.googleusercontent.com').setValue(this.plugin.settings.googleClientId).onChange(async (value) => {
        this.plugin.settings.googleClientId = value.trim();
        await this.plugin.saveSettings();
      }));
    new obsidian.Setting(containerEl)
      .setName('Google OAuth Client secret')
      .setDesc('Desktop app Client secret from the same Google Cloud OAuth client. Stored in Obsidian SecretStorage, not data.json.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('GOCSPX-...');
        text.setValue(this.plugin.getClientSecret() || '');
        text.onChange((value) => this.plugin.setClientSecret(value.trim()));
      });
    const connected = this.plugin.hasRefreshToken();`,
  'settings UI'
);

replaceOnce(
`  setRefreshToken(value) {
    if (!this.app.secretStorage) throw new Error('This Obsidian version does not provide SecretStorage.');
    this.app.secretStorage.setSecret(REFRESH_SECRET_ID, value || '');
  }
  async disconnectYouTube() {`,
`  setRefreshToken(value) {
    if (!this.app.secretStorage) throw new Error('This Obsidian version does not provide SecretStorage.');
    this.app.secretStorage.setSecret(REFRESH_SECRET_ID, value || '');
  }
  hasClientSecret() {
    try { return Boolean(this.app.secretStorage && this.app.secretStorage.getSecret(CLIENT_SECRET_ID)); }
    catch (_) { return false; }
  }
  getClientSecret() {
    if (!this.app.secretStorage) throw new Error('This Obsidian version does not provide SecretStorage. Update Obsidian to 1.11.4 or newer.');
    return this.app.secretStorage.getSecret(CLIENT_SECRET_ID) || '';
  }
  setClientSecret(value) {
    if (!this.app.secretStorage) throw new Error('This Obsidian version does not provide SecretStorage.');
    this.app.secretStorage.setSecret(CLIENT_SECRET_ID, value || '');
  }
  async disconnectYouTube() {`,
  'secret storage methods'
);

replaceOnce(
`  async authorizeYouTube() {
    const clientId = String(this.settings.googleClientId || '').trim();
    if (!clientId) throw new Error('Configure Google OAuth Client ID in plugin settings first.');`,
`  async authorizeYouTube() {
    const clientId = String(this.settings.googleClientId || '').trim();
    const clientSecret = this.getClientSecret();
    if (!clientId) throw new Error('Configure Google OAuth Client ID in plugin settings first.');
    if (!clientSecret) throw new Error('Configure Google OAuth Client secret in plugin settings first.');`,
  'authorization prerequisites'
);

replaceOnce(
`        client_id: clientId,
        code: authorization.code,`,
`        client_id: clientId,
        client_secret: clientSecret,
        code: authorization.code,`,
  'authorization code exchange'
);

replaceOnce(
`      body: new URLSearchParams({
        client_id: String(this.settings.googleClientId || '').trim(),
        refresh_token: refreshToken,`,
`      body: new URLSearchParams({
        client_id: String(this.settings.googleClientId || '').trim(),
        client_secret: this.getClientSecret(),
        refresh_token: refreshToken,`,
  'refresh token exchange'
);

replaceOnce(
`    if (!this.plugin.settings.googleClientId) {
      this.statusEl.setText('Google OAuth Client ID is not configured. Add it in plugin settings first.');`,
`    if (!this.plugin.settings.googleClientId || !this.plugin.hasClientSecret()) {
      this.statusEl.setText('Google OAuth Client ID or Client secret is not configured. Add both in plugin settings first.');`,
  'modal credential check'
);

fs.writeFileSync(file, s, 'utf8');
console.log('Patched main.js for 0.2.0-beta.2');

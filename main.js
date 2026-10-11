const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl, normalizePath } = require('obsidian');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'Files.ReadWrite offline_access';
const DEFAULTS = { clientId: '', remoteFolder: 'Obsidian/MyVault', interval: 0, maxMB: 20 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
function validPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(p => !p || p === '.' || p === '..' || /[\u0000-\u001f]/.test(p));
}
function excluded(path) {
  return path.split('/').some(p => p.startsWith('.')) || path.startsWith('OneDrive冲突副本/');
}
async function digest(buffer) {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer))).map(x => x.toString(16).padStart(2, '0')).join('');
}
function decide(local, remote, base) {
  if (!local) return remote ? 'download' : 'none';
  if (!remote) return 'upload';
  if (!base) return 'compare';
  const lc = local.hash !== base.hash;
  const rc = remote.eTag !== base.etag;
  return lc && rc ? 'compare' : lc ? 'upload' : rc ? 'download' : 'none';
}
class LoginModal extends Modal {
  constructor(app, code, cancel) { super(app); this.code = code; this.cancel = cancel; }
  onOpen() {
    this.contentEl.createEl('h2', { text: '连接 OneDrive' });
    this.contentEl.createEl('p', { text: '打开微软验证页面，输入下面的代码。完成后回到 Obsidian，等待连接成功。' });
    this.contentEl.createEl('pre', { text: this.code.user_code, cls: 'pocket-code' });
    this.contentEl.createEl('a', { text: '打开微软验证页面', href: this.code.verification_uri }).setAttr('target', '_blank');
    this.contentEl.createEl('p', { text: '只支持个人微软账户。请核对授权页面上的应用名称。' });
  }
  onClose() { this.cancel(); this.contentEl.empty(); }
}
class PocketSync extends Plugin {
  async onload() {
    const data = await this.loadData() || {};
    this.settings = { ...DEFAULTS, ...data.settings };
    this.auth = data.auth || {};
    this.state = Object.assign(Object.create(null), data.state || {});
    this.conflicts = new Map();
    this.binding = data.binding || '';
    this.logs = [];
    this.busy = false;
    this.stopped = false;
    this.status = this.addStatusBarItem();
    this.status.setText('OneDrive：待同步');
    this.addSettingTab(new PocketSettings(this.app, this));
    this.addRibbonIcon('refresh-cw', 'OneDrive：立即同步', () => this.sync());
    this.addCommand({ id: 'sync-now', name: '立即同步 OneDrive', callback: () => this.sync() });
    this.addCommand({ id: 'show-log', name: '查看同步日志', callback: () => this.showLog() });
    this.addCommand({ id: 'resolve-conflicts', name: '处理 OneDrive 冲突', callback: () => this.showConflicts() });
    this.timer = window.setInterval(() => {
      if (this.settings.interval > 0 && this.auth.refresh_token && Date.now() - (this.lastAttempt || 0) > this.settings.interval * 60000) this.sync(true);
    }, 30000);
    this.registerInterval(this.timer);
  }
  onunload() { this.stopped = true; if (this.loginCancel) this.loginCancel(); }
  async save() { await this.saveData({ settings: this.settings, auth: this.auth, state: this.state, binding: this.binding }); }
  log(message) { this.logs.push(`${new Date().toLocaleString()}  ${message}`); if (this.logs.length > 200) this.logs.shift(); }
  showLog() {
    const modal = new Modal(this.app);
    modal.onOpen = () => { modal.contentEl.createEl('h2', { text: '本次运行的同步日志' }); modal.contentEl.createEl('pre', { text: this.logs.join('\n') || '尚未同步。', cls: 'pocket-log' }); };
    modal.open();
  }
  showConflicts() {
    const modal = new Modal(this.app);
    modal.onOpen = () => {
      modal.contentEl.createEl('h2', { text: '处理同步冲突' });
      modal.contentEl.createEl('p', { text: '先对照 OneDrive冲突副本 手动合并到原笔记，再点击对应按钮上传合并结果。远端若已变化，操作会停止。若要采用远端版本，可手动将远端副本内容复制到原笔记，再同步。' });
      if (!this.conflicts.size) modal.contentEl.createEl('p', { text: '本次运行未发现冲突。重启后请先同步以重新检测。' });
      for (const [path, remote] of this.conflicts) {
        new Setting(modal.contentEl).setName(path).addButton(b => b.setButtonText('上传本地合并结果').onClick(async () => {
          if (this.busy) return new Notice('请等待当前同步完成。');
          this.busy = true; b.setDisabled(true);
          try {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!file || !('extension' in file)) throw new Error('找不到本地文件。');
            const buffer = await this.app.vault.readBinary(file);
            if (buffer.byteLength > this.settings.maxMB * 1024 * 1024) throw new Error('文件超过大小限制。');
            const hash = await digest(buffer);
            await this.localUnchanged(path, hash);
            const result = await this.upload(null, path, buffer, remote);
            this.state[path] = { hash, etag: result.eTag }; await this.save();
            this.conflicts.delete(path); this.log(`已上传合并结果：${path}`); new Notice('合并结果已上传。');
          } catch (error) { new Notice(error.message); }
          finally { this.busy = false; b.setDisabled(false); }
        }));
      }
    };
    modal.open();
  }
  async tokenRequest(fields) {
    return requestUrl({ url: `${AUTH}/token`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), throw: false });
  }
  async login() {
    if (this.busy || this.loginCancel) return new Notice('请等待当前操作完成。');
    if (!/^[a-f\d-]{36}$/i.test(this.settings.clientId)) return new Notice('请先填写微软应用的客户端 ID。');
    let cancelled = false;
    this.loginCancel = () => { cancelled = true; };
    let modal;
    try {
      const response = await requestUrl({ url: `${AUTH}/devicecode`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.settings.clientId, scope: SCOPE }).toString(), throw: false });
      if (response.status !== 200) throw new Error('无法申请登录代码，请检查客户端 ID 和公共客户端设置。');
      const code = response.json;
      modal = new LoginModal(this.app, code, () => { cancelled = true; }); modal.open();
      const deadline = Date.now() + code.expires_in * 1000;
      let interval = (code.interval || 5) * 1000;
      while (!cancelled && !this.stopped && Date.now() < deadline) {
        await pause(interval);
        if (cancelled || this.stopped) break;
        const reply = await this.tokenRequest({ client_id: this.settings.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code });
        if (cancelled || this.stopped) break;
        if (reply.status === 200) {
          this.auth = { ...reply.json, expiresAt: Date.now() + reply.json.expires_in * 1000 };
          this.state = Object.create(null); this.conflicts.clear(); this.binding = ''; await this.save();
          new Notice('OneDrive 已连接。请先手动同步。'); return;
        }
        if (reply.json.error === 'slow_down') interval += 5000;
        else if (reply.json.error !== 'authorization_pending') throw new Error(`登录未完成：${reply.json.error || reply.status}`);
      }
      if (!cancelled && !this.stopped) new Notice('登录代码已过期，请重新连接。');
    } catch (error) { new Notice(error.message); }
    finally { if (modal) modal.close(); this.loginCancel = null; }
  }
  async token() {
    if (this.auth.access_token && this.auth.expiresAt > Date.now() + 60000) return this.auth.access_token;
    if (!this.auth.refresh_token) throw new Error('请先连接 OneDrive。');
    const response = await this.tokenRequest({ client_id: this.settings.clientId, grant_type: 'refresh_token', refresh_token: this.auth.refresh_token, scope: SCOPE });
    if (response.status !== 200) throw new Error('登录已失效，请重新连接 OneDrive。');
    this.auth = { ...this.auth, ...response.json, expiresAt: Date.now() + response.json.expires_in * 1000 }; await this.save();
    return this.auth.access_token;
  }
  async api(route, method = 'GET', body, headers = {}) {
    const url = route.startsWith('https://') ? route : GRAPH + route;
    if (!url.startsWith(GRAPH + '/')) throw new Error('拒绝不属于 Microsoft Graph 的请求地址。');
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await requestUrl({ url, method, headers: { Authorization: `Bearer ${await this.token()}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers }, body, throw: false });
      if (response.status === 401 && attempt === 0) { this.auth.expiresAt = 0; continue; }
      if ((response.status === 429 || response.status === 503) && attempt < 3) { await pause(Math.min(30, Math.max(1, Number(response.headers['retry-after']) || 2 ** attempt)) * 1000); continue; }
      if (response.status >= 400) { const error = new Error(`OneDrive 请求失败（${response.status}）。${response.status === 412 ? '远端文件发生变化，请重新同步。' : ''}`); error.status = response.status; throw error; }
      return response;
    }
    throw new Error('OneDrive 暂时无法响应。');
  }
  async folder(parent, name) {
    try { const item = (await this.api(`/me/drive/items/${parent}:/${encodeURIComponent(name)}`)).json; if (!item.folder) throw new Error('远端同名项目不是文件夹。'); return item; }
    catch (error) { if (error.status !== 404) throw error; }
    return (await this.api(`/me/drive/items/${parent}/children`, 'POST', JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }))).json;
  }
  async scanRemote(root) {
    const files = new Map();
    const visit = async (id, prefix) => {
      let route = `/me/drive/items/${id}/children?$select=id,name,file,folder,eTag,size`;
      while (route) {
        const page = (await this.api(route)).json;
        for (const item of page.value) {
          const path = prefix + item.name;
          if (!validPath(path)) throw new Error('远端含有不安全的路径，已停止同步。');
          if (excluded(path)) continue;
          if (item.folder) await visit(item.id, path + '/');
          else if (item.file) files.set(path, item);
        }
        route = page['@odata.nextLink'];
      }
    };
    await visit(root, ''); return files;
  }
  async download(item) {
    const metadata = (await this.api(`/me/drive/items/${item.id}`)).json;
    if (metadata.eTag !== item.eTag) throw new Error('扫描后远端文件发生变化，请重新同步。');
    if (metadata.size > this.settings.maxMB * 1024 * 1024) throw new Error('远端文件超过单文件大小限制。');
    const url = metadata['@microsoft.graph.downloadUrl'];
    if (!url || !url.startsWith('https://')) throw new Error('OneDrive 未返回安全下载地址。');
    // The pre-authorized URL must never receive our bearer token.
    const result = await requestUrl({ url, throw: false });
    if (result.status !== 200) throw new Error(`下载失败（${result.status}）。`);
    const after = (await this.api(`/me/drive/items/${item.id}?$select=eTag`)).json;
    if (after.eTag !== item.eTag) throw new Error('下载过程中远端文件发生变化，请重新同步。');
    return result.arrayBuffer;
  }
  async ensureLocalParent(path) {
    const parts = path.split('/'); parts.pop(); let parent = '';
    for (const part of parts) { parent = parent ? parent + '/' + part : part; if (!await this.app.vault.adapter.exists(parent)) await this.app.vault.createFolder(parent); }
  }
  async writeLocal(path, buffer) {
    await this.ensureLocalParent(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) { if (!('extension' in file)) throw new Error('本地同名项目是文件夹。'); await this.app.vault.modifyBinary(file, buffer); }
    else await this.app.vault.createBinary(path, buffer);
  }
  async localUnchanged(path, expected) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!expected) { if (file) throw new Error('同步期间本地新增了同名文件，请重新同步。'); return; }
    if (!file || !('extension' in file) || await digest(await this.app.vault.readBinary(file)) !== expected) throw new Error('同步期间本地文件发生变化，请重新同步。');
  }
  async upload(root, path, buffer, remote) {
    if (remote) return (await this.api(`/me/drive/items/${remote.id}/content`, 'PUT', buffer, { 'Content-Type': 'application/octet-stream', 'If-Match': remote.eTag })).json;
    const parts = path.split('/'); const name = parts.pop(); let parent = root;
    for (const part of parts) parent = (await this.folder(parent, part)).id;
    // conflictBehavior=fail prevents a file created since scanning from being overwritten.
    return (await this.api(`/me/drive/items/${parent}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`, 'PUT', buffer, { 'Content-Type': 'application/octet-stream' })).json;
  }
  async sync(quiet = false) {
    if (this.busy || this.loginCancel || this.stopped) return;
    this.busy = true; this.lastAttempt = Date.now(); this.status.setText('OneDrive：同步中');
    let uploads = 0, downloads = 0, conflicts = 0, skipped = 0;
    try {
      const target = this.settings.remoteFolder.trim();
      if (!validPath(target) || target.split('/').some(p => p.startsWith('.'))) throw new Error('请填写专用远端文件夹，例如 Obsidian/MyVault。');
      const drive = (await this.api('/me/drive?$select=id')).json;
      let root = (await this.api('/me/drive/root?$select=id')).json.id;
      for (const part of target.split('/')) root = (await this.folder(root, part)).id;
      const binding = `${drive.id}/${root}`;
      if (this.binding !== binding) { this.state = Object.create(null); this.conflicts.clear(); this.binding = binding; await this.save(); }
      const remoteFiles = await this.scanRemote(root);
      const configDir = this.app.vault.configDir || '.obsidian';
      for (const path of remoteFiles.keys()) if (path === configDir || path.startsWith(configDir + '/')) remoteFiles.delete(path);
      const localFiles = new Map(this.app.vault.getFiles().filter(f => !excluded(f.path) && !f.path.startsWith(configDir + '/')).map(f => [f.path, f]));
      for (const path of new Set([...localFiles.keys(), ...remoteFiles.keys()])) {
        if (this.stopped) throw new Error('插件已停止。');
        if (!validPath(path)) throw new Error('本地路径无效。');
        const file = localFiles.get(path), remote = remoteFiles.get(path);
        if ((file && file.stat.size > this.settings.maxMB * 1024 * 1024) || (remote && remote.size > this.settings.maxMB * 1024 * 1024)) { skipped++; this.log(`跳过超限文件：${path}`); continue; }
        const buffer = file ? await this.app.vault.readBinary(file) : null;
        const local = buffer ? { hash: await digest(buffer) } : null;
        const action = decide(local, remote, this.state[path]);
        if (action === 'none') continue;
        if (action === 'upload') {
          await this.localUnchanged(path, local.hash);
          const result = await this.upload(root, path, buffer, remote);
          this.state[path] = { hash: local.hash, etag: result.eTag }; uploads++; this.log(`上传：${path}`);
          this.conflicts.delete(path);
        } else {
          const incoming = await this.download(remote); const hash = await digest(incoming);
          await this.localUnchanged(path, local && local.hash);
          if (action === 'compare' && hash !== local.hash) {
            const previous = this.conflicts.get(path);
            if (!previous || previous.eTag !== remote.eTag) {
              const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              const backup = normalizePath(`OneDrive冲突副本/${suffix}/${path}`);
              await this.writeLocal(backup, incoming);
              this.log(`冲突：${path}；远端副本：${backup}`);
            }
            this.conflicts.set(path, remote); conflicts++;
            // Keep both originals and do not advance the baseline until the user resolves it.
          } else {
            if (!local || hash !== local.hash) {
              if (local) await this.writeLocal(normalizePath(`OneDrive冲突副本/同步前备份-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/${path}`), buffer);
              await this.localUnchanged(path, local && local.hash);
              await this.writeLocal(path, incoming); downloads++; this.log(`下载：${path}`);
            }
            this.state[path] = { hash, etag: remote.eTag };
            this.conflicts.delete(path);
          }
        }
        await this.save();
      }
      const result = `上传 ${uploads} · 下载 ${downloads} · 冲突 ${conflicts} · 跳过 ${skipped}`;
      this.log(result); this.status.setText(conflicts ? 'OneDrive：有冲突' : 'OneDrive：已同步');
      if (!quiet || conflicts || skipped) new Notice(result, 8000);
    } catch (error) { this.log(`停止：${error.message}`); this.status.setText('OneDrive：同步失败'); new Notice(`OneDrive：${error.message}`, 10000); }
    finally { this.busy = false; }
  }
}
class PocketSettings extends PluginSettingTab {
  display() {
    const el = this.containerEl; el.empty(); el.addClass('pocket-settings'); const p = this.plugin;
    el.createEl('h2', { text: 'OneDrive Pocket Sync' });
    const summary = el.createDiv({ cls: 'pocket-summary' });
    summary.createEl('strong', { text: p.auth.refresh_token ? '已连接 OneDrive' : '先连接，再同步' });
    summary.createEl('p', { text: '个人微软账户 · iPad / iPhone / Windows' });
    new Setting(el).setName('立即同步').setDesc('首次同步会比较同名文件。冲突保留双方，不自动覆盖。').addButton(b => b.setButtonText('立即同步').setCta().setDisabled(p.busy).onClick(() => p.sync()));
    el.createEl('h3', { text: '连接与位置' });
    new Setting(el).setName('微软应用客户端 ID').setDesc('注册个人账户公共客户端应用后，复制 Application (client) ID。').addText(t => t.setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx').setValue(p.settings.clientId).onChange(async value => { if (p.busy || p.loginCancel) return; p.settings.clientId = value.trim(); p.auth = {}; p.conflicts.clear(); await p.save(); }));
    new Setting(el).setName('微软账户').setDesc('通过设备代码在 Safari 或浏览器授权；无需客户端密钥。').addButton(b => b.setButtonText('连接 / 重新连接').onClick(() => p.login())).addButton(b => b.setButtonText('退出登录').onClick(async () => { if (p.busy) return new Notice('请等待同步完成。'); if (p.loginCancel) p.loginCancel(); p.auth = {}; p.conflicts.clear(); await p.save(); this.display(); }));
    new Setting(el).setName('远端专用文件夹').setDesc('各设备必须填写同一路径。不要使用已有杂项文件的目录。').addText(t => t.setValue(p.settings.remoteFolder).onChange(async value => { if (p.busy || p.loginCancel) return; p.settings.remoteFolder = value.trim(); p.conflicts.clear(); await p.save(); }));
    el.createEl('h3', { text: '同步方式' });
    new Setting(el).setName('自动同步').setDesc('仅在 Obsidian 打开期间运行；iPad 后台或锁屏无法保证同步。默认关闭。').addDropdown(d => d.addOptions({ 0: '关闭', 1: '每 1 分钟', 5: '每 5 分钟', 15: '每 15 分钟' }).setValue(String(p.settings.interval)).onChange(async value => { p.settings.interval = Number(value); await p.save(); }));
    new Setting(el).setName('文件范围').setDesc('同步笔记和附件；排除隐藏目录（包括 .obsidian）、隐藏文件和 OneDrive冲突副本。单文件最多 20 MB。');
    new Setting(el).setName('删除规则').setDesc('0.1 版不传播删除：一端删除的文件会由另一端补回。重命名按新增处理，旧名字可能补回。');
    new Setting(el).setName('冲突与备份').setDesc('查看 OneDrive冲突副本 文件夹，手动合并内容，再处理冲突。自动替换本地文件前也会在此保存旧版本。').addButton(b => b.setButtonText('处理冲突').onClick(() => p.showConflicts())).addButton(b => b.setButtonText('查看日志').onClick(() => p.showLog()));
  }
}
module.exports = PocketSync;
module.exports._test = { decide, validPath, excluded, digest };

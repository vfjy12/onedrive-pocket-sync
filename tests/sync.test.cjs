const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto').webcrypto;
const sandbox = { module: { exports: {} }, require: () => ({ Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, normalizePath: p => p }), crypto, Uint8Array, URLSearchParams, Date, Math, Map, Set, Object, Array, Number, Error, setTimeout };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8'), sandbox);
const Plugin = sandbox.module.exports;
const { decide, validPath, excluded, digest } = Plugin._test;
const bytes = text => new TextEncoder().encode(text).buffer;
test('three-way decisions protect simultaneous edits and first-sync collisions', () => {
  const base = { hash: 'a', etag: '1' };
  assert.equal(decide({ hash: 'b' }, { eTag: '2' }, base), 'compare');
  assert.equal(decide({ hash: 'a' }, { eTag: '2' }, base), 'download');
  assert.equal(decide({ hash: 'b' }, { eTag: '1' }, base), 'upload');
  assert.equal(decide({ hash: 'a' }, { eTag: '1' }, base), 'none');
  assert.equal(decide({ hash: 'a' }, { eTag: '1' }), 'compare');
  assert.equal(decide(null, { eTag: '1' }, base), 'download');
  assert.equal(decide({ hash: 'a' }, null, base), 'upload');
});
test('reject traversal and exclude configuration and conflict backups', () => {
  for (const p of ['../a', '/a', 'a//b', 'a/./b', 'a\\b', 'a/\u0000']) assert.equal(validPath(p), false);
  assert.equal(validPath('笔记/附件 a.png'), true);
  for (const p of ['.obsidian/plugins/x/data.json', 'a/.hidden', 'OneDrive冲突副本/a.md']) assert.equal(excluded(p), true);
  assert.equal(excluded('笔记/知识点.md'), false);
});
function fixture(localText, remoteText, base) {
  const p = new Plugin();
  const store = new Map();
  if (localText !== null) store.set('note.md', bytes(localText));
  const file = path => store.has(path) ? { path, extension: 'md', stat: { size: store.get(path).byteLength } } : null;
  p.app = { vault: { configDir: '.obsidian', getFiles: () => [...store.keys()].map(file), getAbstractFileByPath: file, readBinary: async f => store.get(f.path) } };
  p.settings = { remoteFolder: 'Obsidian/Test', maxMB: 20 }; p.auth = {}; p.binding = 'drive/folder'; p.state = base ? { 'note.md': base } : {}; p.conflicts = new Map(); p.logs = [];
  p.status = { setText() {} }; p.save = async () => {}; p.api = async path => ({ json: { id: path.includes('root') ? 'root' : 'drive' } });
  p.folder = async () => ({ id: 'folder' });
  p.scanRemote = async () => new Map(remoteText === null ? [] : [['note.md', { id: 'remote', eTag: 'r2', size: bytes(remoteText).byteLength }]]);
  p.download = async () => bytes(remoteText);
  p.writeLocal = async (path, buffer) => store.set(path, buffer);
  const uploads = [];
  p.upload = async (root, path, buffer) => { uploads.push([path, new TextDecoder().decode(buffer)]); return { eTag: 'r3' }; };
  return { p, store, uploads };
}
test('first sync conflict leaves both originals and creates a remote copy', async () => {
  const { p, store, uploads } = fixture('local', 'remote');
  await p.sync();
  assert.equal(new TextDecoder().decode(store.get('note.md')), 'local');
  assert.equal(uploads.length, 0);
  assert.equal(store.size, 2);
  assert.equal(p.conflicts.size, 1);
  assert.equal(p.state['note.md'], undefined);
});
test('remote-only edit backs up local bytes before replacing them', async () => {
  const { p, store } = fixture('old', 'new', { hash: await digest(bytes('old')), etag: 'r1' });
  await p.sync();
  assert.equal(new TextDecoder().decode(store.get('note.md')), 'new');
  const backup = [...store.keys()].find(path => path !== 'note.md');
  assert.equal(new TextDecoder().decode(store.get(backup)), 'old');
  assert.equal(p.state['note.md'].hash, await digest(bytes('new')));
});
test('missing local file is downloaded and missing remote file is uploaded', async () => {
  const a = fixture(null, 'cloud'); await a.p.sync(); assert.equal(new TextDecoder().decode(a.store.get('note.md')), 'cloud');
  const b = fixture('local', null); await b.p.sync(); assert.equal(b.uploads.length, 1);
});
test('edit while downloading aborts replacement', async () => {
  const { p, store } = fixture('old', 'remote', { hash: await digest(bytes('old')), etag: 'r1' });
  p.download = async () => { store.set('note.md', bytes('typing')); return bytes('remote'); };
  await p.sync();
  assert.equal(new TextDecoder().decode(store.get('note.md')), 'typing');
  assert.match(p.logs.join('\n'), /本地文件发生变化/);
});
test('existing uploads use the scanned ETag and new uploads refuse collisions', async () => {
  const p = new Plugin(); const calls = [];
  p.api = async (...args) => { calls.push(args); return { json: { eTag: 'new' } }; };
  await p.upload('root', 'note.md', bytes('x'), { id: 'id', eTag: 'old' });
  assert.equal(calls[0][3]['If-Match'], 'old');
  calls.length = 0;
  await p.upload('root', 'note.md', bytes('x'), null);
  assert.match(calls[0][0], /conflictBehavior=fail/);
});

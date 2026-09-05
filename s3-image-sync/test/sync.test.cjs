const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { webcrypto, createHash } = require('node:crypto');

const bundle = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const baseSettings = {
  enabled: true, autoScanEnabled: true, scanIntervalMinutes: 15,
  quietSeconds: 0, attachmentRoot: 'assets', deletePolicy: 'keep',
  s3: {
    provider: 'custom', region: 'us-east-1', endpoint: 'http://127.0.0.1:9000',
    bucketName: 'local-test', accessKeyId: 'local-test', secretAccessKey: 'test-fixture-only',
    customDomainName: 'http://127.0.0.1:9000/local-test',
    pathTemplate: 'images/{hash}.{ext}',
  },
};

async function harness(overrides = {}, requestHandler) {
  const files = new Map();
  const requests = [];
  const deleted = [];
  const intervals = new Map();
  const notices = [];
  const listeners = new Map();
  const emit = event => { for (const fn of listeners.get(event) || []) fn(); };
  let nextTimer = 1;
  class TFile {
    constructor(filePath, content) {
      this.path = filePath;
      this.name = filePath.split('/').pop();
      this.extension = this.name.split('.').pop();
      this.basename = this.name.replace(/\.[^.]+$/, '');
      this.parent = { path: filePath.split('/').slice(0, -1).join('/') };
      this.content = content;
      this.stat = { mtime: 0, ctime: 0, size: Buffer.byteLength(content) };
    }
  }
  const app = {
    vault: {
      getFiles: () => [...files.values()],
      trash: async (f, system) => { assert.equal(system, false); deleted.push(f.path); files.delete(f.path); emit('delete'); },
      on: (event, fn) => { listeners.set(event, [...(listeners.get(event) || []), fn]); return {}; },
      getMarkdownFiles: () => [...files.values()].filter(f => f.extension === 'md'),
      read: async f => f.content,
      readBinary: async f => Uint8Array.from(f.content).buffer,
      getAbstractFileByPath: p => files.get(p),
      process: async (f, fn) => { f.content = fn(f.content); emit('modify'); },
    },
    metadataCache: {
      getFirstLinkpathDest: (target, source) => files.get(path.posix.normalize(path.posix.join(path.posix.dirname(source), target)))
        || [...files.values()].find(f => f.name === target),
    },
    fileManager: { trashFile: async f => { deleted.push(f.path); files.delete(f.path); emit('delete'); } },
    workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
  };
  class Plugin {
    constructor() { this.app = app; this.saved = structuredClone({ ...baseSettings, ...overrides }); }
    async loadData() { return structuredClone(this.saved); }
    async saveData(data) { this.saved = structuredClone(data); }
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab() {}
    registerInterval() {}
    registerEvent() {}
  }
  class Notice {
    constructor(text) { notices.push(text); }
    setMessage() {}
    hide() {}
  }
  const obsidian = {
    Plugin, TFile, Notice, MarkdownView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {},
    Platform: { isMobile: false }, getLanguage: () => 'zh',
    requestUrl: async params => {
      const host = new URL(params.url).hostname;
      if (host === 'codex-oss-fixture.s3.oss-cn-hangzhou.aliyuncs.com') {
        // OSS branch has no transport or callback: capture only, never access the cloud.
        requests.push(params); return {status: 200, text: ''};
      }
      assert.equal(host, '127.0.0.1', 'Tests must never contact an external host');
      requests.push(params);
      return requestHandler ? requestHandler(params) : { status: 200, text: '' };
    },
  };
  const context = {
    module: { exports: {} }, exports: {}, URL, TextEncoder, Uint8Array, crypto: webcrypto,
    console: { ...console, error() {} },
    window: {
      setInterval(fn, ms) { const id = nextTimer++; intervals.set(id, { fn, ms }); return id; },
      clearInterval(id) { intervals.delete(id); },
      setTimeout(fn) { queueMicrotask(fn); },
    },
    require(id) { assert.equal(id, 'obsidian'); return obsidian; },
  };
  vm.runInNewContext(bundle, context, { filename: 'main.js' });
  const plugin = new context.module.exports.default();
  await plugin.onload();
  return {
    plugin, files, requests, deleted, intervals, notices, app, emit, MarkdownView: obsidian.MarkdownView,
    add(filePath, content = png) { const f = new TFile(filePath, content); files.set(filePath, f); emit('create'); return f; },
  };
}

test('saved interval, enable switch, folder and other general options survive reload', async () => {
  const h = await harness({ scanIntervalMinutes: 7, quietSeconds: 23, attachmentRoot: 'images', autoScanMinSizeMiB: 2 });
  assert.equal(h.plugin.settings.scanIntervalMinutes, 7);
  assert.equal(h.plugin.settings.autoScanEnabled, true);
  assert.equal(h.plugin.settings.attachmentRoot, 'images');
  assert.equal(h.plugin.settings.quietSeconds, 23);
  assert.equal(h.plugin.settings.autoScanMinSizeMiB, 2);
  await h.plugin.saveSettings();
  await h.plugin.loadSettings();
  assert.equal(h.plugin.settings.scanIntervalMinutes, 7);
  assert.equal(h.plugin.settings.deletePolicy, 'keep');
});

test('timer uses the chosen interval, waits before first scan and stops on unload', async () => {
  const h = await harness({ scanIntervalMinutes: 7 });
  h.add('a.md', '![[assets/a.png]]'); h.add('assets/a.png');
  const timer = h.intervals.get(h.plugin.autoScanTimer);
  assert.equal(timer.ms, 7 * 60 * 1000);
  assert.equal(h.requests.length, 0);
  h.plugin.settings.autoScanEnabled = false;
  h.plugin.configureAutoScan();
  assert.equal(h.plugin.autoScanTimer, null);
  h.plugin.settings.autoScanEnabled = true;
  h.plugin.configureAutoScan();
  const id = h.plugin.autoScanTimer;
  h.plugin.onunload();
  assert.equal(h.intervals.has(id), false);
  await h.plugin.runAutoScan();
  assert.equal(h.requests.length, 0);
});

test('interval is bounded and the scheduler is desktop-only', async () => {
  const h = await harness({ scanIntervalMinutes: 0.1 });
  assert.equal(h.intervals.get(h.plugin.autoScanTimer).ms, 60000);
  h.plugin.settings.scanIntervalMinutes = 999999999;
  h.plugin.configureAutoScan();
  assert.equal(h.intervals.get(h.plugin.autoScanTimer).ms, 10080 * 60000);
  h.plugin.isMobile = true;
  h.plugin.configureAutoScan();
  assert.equal(h.plugin.autoScanTimer, null);
});

test('scheduled scan replaces image references in place and keeps original files', async () => {
  const h = await harness({ deletePolicy: 'delayed' });
  const note = h.add('a.md', 'before\n![[assets/a.png]]\n![说明](assets/a.png)\nafter');
  h.add('assets/a.png');
  await h.plugin.runAutoScan();
  assert.match(note.content, /^before\n!\[a.png\]\(http:\/\/127\.0\.0\.1:9000\/local-test\/images\/[a-f0-9]+\.png\)/);
  assert.match(note.content, /!\[说明\]\(http:.*\)\nafter$/);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(h.plugin.settings.pendingDeletes.length, 0);
  await h.plugin.processPendingDeletes();
  assert.equal(h.deleted.length, 0);
  assert.ok(h.files.has('assets/a.png'));
  const uploaded = h.requests.length;
  await h.plugin.runAutoScan();
  assert.equal(h.requests.length, uploaded, 'already replaced links are not uploaded again');
});

test('matching text in fenced and inline code is preserved; ordinary links remain links', async () => {
  const h = await harness();
  const code = '```md\n![[assets/a.png]]\n```\n`![[assets/a.png]]`';
  const note = h.add('a.md', '![[assets/a.png]]\n[下载](assets/a.png)\n' + code);
  h.add('assets/a.png');
  await h.plugin.runAutoScan();
  assert.ok(note.content.endsWith(code));
  assert.match(note.content, /\n\[下载\]\(http:/);
  assert.doesNotMatch(note.content, /!\[下载\]/);
});

test('quiet period and attachment folder filter exclude ineligible images', async () => {
  const h = await harness({ quietSeconds: 600 });
  const note = h.add('a.md', '![[assets/recent.png]]\n![[outside/a.png]]');
  const recent = h.add('assets/recent.png'); recent.stat.mtime = Date.now();
  h.add('outside/a.png');
  const before = note.content;
  await h.plugin.runAutoScan();
  assert.equal(h.requests.length, 0);
  assert.equal(note.content, before);
});

test('failed uploads keep the note and local image intact', async () => {
  const h = await harness({}, async () => ({ status: 503, text: 'temporary test failure' }));
  const note = h.add('a.md', '![[assets/a.png]]'); h.add('assets/a.png');
  await h.plugin.runAutoScan();
  assert.equal(note.content, '![[assets/a.png]]');
  assert.ok(h.requests.length <= 4);
  assert.equal(h.plugin.settings.pendingDeletes.length, 0);
  assert.equal(h.deleted.length, 0);
});

test('an edit during upload is preserved and remote objects are never deleted on conflict', async () => {
  let note;
  const h = await harness({}, async () => {
    note.content += '\nuser edited this while uploading';
    return { status: 200, text: '' };
  });
  note = h.add('a.md', '![[assets/a.png]]'); h.add('assets/a.png');
  await h.plugin.runAutoScan();
  assert.equal(note.content, '![[assets/a.png]]\nuser edited this while uploading');
  assert.equal(h.requests.filter(r => r.method === 'DELETE').length, 0);
  assert.equal(h.plugin.settings.pendingDeletes.length, 0);
});

test('overlapping scheduled scans do not upload or rewrite the same note twice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({}, async () => { await gate; return { status: 200, text: '' }; });
  h.add('a.md', '![[assets/a.png]]'); h.add('assets/a.png');
  const first = h.plugin.runAutoScan();
  await h.plugin.runAutoScan();
  release();
  await first;
  assert.equal(h.requests.length, 1);
});

test('real localhost HTTP upload receives image bytes and serves the replacement URL', async t => {
  const objects = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (createHash('sha256').update(body).digest('hex') !== req.headers['x-amz-content-sha256']) {
        res.writeHead(400).end(); return;
      }
      if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=local-test/')) {
        res.writeHead(403).end(); return;
      }
      objects.set(req.url, body);
      res.writeHead(200).end();
    } else if (req.method === 'GET' && objects.has(req.url)) {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(objects.get(req.url));
    } else { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const h = await harness({ s3: { ...baseSettings.s3, endpoint, customDomainName: `${endpoint}/local-test` } }, async params => {
    const response = await fetch(params.url, {
      method: params.method, headers: params.headers,
      body: params.body ? Buffer.from(new Uint8Array(params.body)) : undefined,
    });
    return { status: response.status, text: await response.text() };
  });
  const note = h.add('a.md', '![[assets/a.png]]'); h.add('assets/a.png');
  await h.plugin.runAutoScan();
  const url = note.content.match(/\]\((http[^)]+)\)/)?.[1];
  assert.ok(url);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(objects.size, 1);
});

function record(h, sourcePath, key = 'images/recorded.png') {
  h.plugin.cleanup.recordUpload(sourcePath, 'fixture-hash', key,
    `${h.plugin.settings.s3.customDomainName}/${key}`, h.plugin.settings.s3);
}

const paths = scan => Array.from(scan.items, item => item.path);

test('unused scan protects Markdown, Wiki, HTML, YAML, Canvas, reference definitions and code mentions across the vault', async () => {
  const h = await harness();
  for (const name of ['wiki', 'md space', 'html', 'cover', 'canvas', 'reference', 'code', 'stem', 'unused']) h.add(`assets/${name}.png`);
  h.add('notes/a.md', '![[wiki.png|100]]\n![alt](../assets/md%20space.png "title")\n<img src="../assets/html.png">\n---\ncover: assets/cover.png\n---\n![x][r]\n[r]: assets/reference.png\n`![[code.png]]`\n![[assets/stem]]');
  h.add('board.canvas', JSON.stringify({ nodes: [{ type: 'file', file: 'assets/canvas.png' }] }));
  h.add('outside/unreferenced.avif');
  const scan = await h.plugin.cleanup.scan();
  assert.deepEqual(paths(scan), ['assets/unused.png', 'outside/unreferenced.avif']);
  assert.equal(h.requests.length, 0, 'a scan has no network effects');
  assert.equal(h.deleted.length, 0);
});

test('upload record survives settings reload and remote image alt text does not count as a local reference', async () => {
  const h = await harness();
  h.add('a.md', '![[assets/a.png]]'); h.add('assets/a.png');
  await h.plugin.runAutoScan();
  await h.plugin.loadSettings();
  assert.equal(h.plugin.settings.uploadRecords.length, 1);
  const stored = h.plugin.settings.uploadRecords[0];
  assert.equal(stored.key, `images/${createHash('sha256').update(png).digest('hex')}.png`);
  assert.equal('secretAccessKey' in stored, false);
  const scan = await h.plugin.cleanup.scan();
  assert.deepEqual(paths(scan), ['assets/a.png']);
  assert.match(scan.items[0].remoteBlock, /仍被引用/);
  const blocked = await h.plugin.cleanup.deleteSelected(scan.items, 'both');
  assert.equal(blocked[0].status, 'skipped');
  const local = await h.plugin.cleanup.deleteSelected(scan.items, 'local');
  assert.equal(local[0].localDeleted, true);
  assert.equal(h.requests.filter(r => r.method === 'DELETE').length, 0);
  assert.deepEqual(paths(await h.plugin.cleanup.scan()), [], 'referenced cloud-only records are not listed');
});

test('deletion processes checked rows only; untracked images are restricted to local deletion', async () => {
  const h = await harness(); h.add('assets/a.png'); h.add('assets/b.png');
  let scan = await h.plugin.cleanup.scan();
  let result = await h.plugin.cleanup.deleteSelected([scan.items[0]], 'both');
  assert.equal(result[0].status, 'skipped');
  assert.equal(h.deleted.length, 0);
  result = await h.plugin.cleanup.deleteSelected([scan.items[0]], 'local');
  assert.equal(result[0].status, 'deleted');
  assert.ok(h.files.has('assets/b.png'));
  assert.equal(h.requests.length, 0);
});

test('recorded cloud object and local file are deleted, tombstones survive reload', async () => {
  const h = await harness(); h.add('assets/a.png'); record(h, 'assets/a.png');
  const result = await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items, 'both');
  assert.equal(result[0].localDeleted, true);
  assert.equal(result[0].remoteDeleted, 1);
  assert.equal(h.requests[0].method, 'DELETE');
  assert.equal(h.requests[0].url, 'http://127.0.0.1:9000/local-test/images/recorded.png');
  await h.plugin.loadSettings();
  assert.ok(h.plugin.settings.uploadRecords[0].deletedAt);
  assert.deepEqual(paths(await h.plugin.cleanup.scan()), []);
});

test('403 and network failures retain originals and do not mark cloud objects deleted', async () => {
  for (const handler of [async () => ({status:403, text:'forbidden'}), async () => { throw new Error('offline'); }]) {
    const h = await harness({}, handler); h.add('assets/a.png'); record(h, 'assets/a.png');
    const result = await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items, 'both');
    assert.equal(result[0].status, 'failed');
    assert.equal(result[0].remoteDeleted, 0);
    assert.ok(h.files.has('assets/a.png'));
    assert.equal(h.plugin.settings.uploadRecords[0].deletedAt, undefined);
  }
});

test('404 means already absent, while redirects and server errors must not be treated as successful deletes', async () => {
  for (const status of [404, 301, 500]) {
    const h = await harness({}, async () => ({status, text:''})); h.add('assets/a.png'); record(h, 'assets/a.png');
    const result = await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items, 'both');
    assert.equal(result[0].status, status === 404 ? 'deleted' : 'failed');
    assert.equal(h.deleted.length, status === 404 ? 1 : 0);
  }
});

test('shared cloud keys are protected via alternate domains and deleted only once after all references disappear', async () => {
  const h = await harness(); h.add('assets/a.png'); h.add('assets/b.png');
  record(h, 'assets/a.png'); record(h, 'assets/b.png');
  const note = h.add('other.md', '<img src="https://alternate.invalid/images/recorded.png?signature=example">');
  const blocked = await h.plugin.cleanup.scan();
  assert.ok(blocked.items.every(item => item.remoteBlock));
  assert.ok((await h.plugin.cleanup.deleteSelected(blocked.items, 'both')).every(r => r.status === 'skipped'));
  note.content = '';
  const result = await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items, 'both');
  assert.ok(result.every(r => r.status === 'deleted'));
  assert.equal(h.requests.length, 1);
  assert.equal(h.deleted.length, 2);
});

test('a new local or remote reference after scan cancels the relevant deletion', async () => {
  for (const remote of [false, true]) {
    const h = await harness(); h.add('assets/a.png'); record(h, 'assets/a.png');
    const scan = await h.plugin.cleanup.scan();
    h.add('new-note.md', remote ? '![](https://example.invalid/images/recorded.png)' : '![[assets/a.png]]');
    const result = await h.plugin.cleanup.deleteSelected(scan.items, remote ? 'both' : 'local');
    assert.equal(result[0].status, 'skipped');
    assert.equal(h.deleted.length, 0);
    assert.equal(h.requests.length, 0);
  }
});

test('changed image contents with unchanged size and timestamps invalidate a reviewed selection', async () => {
  const h = await harness(); const file = h.add('assets/a.png');
  const scan = await h.plugin.cleanup.scan();
  file.content = Buffer.from(png); file.content[20] ^= 1;
  const result = await h.plugin.cleanup.deleteSelected(scan.items, 'local');
  assert.equal(result[0].status, 'skipped');
  assert.equal(h.deleted.length, 0);
});

test('unreadable notes abort scan; vault changes during scan invalidate it', async () => {
  const h = await harness(); h.add('assets/a.png'); h.add('a.md', '');
  h.app.vault.read = async () => { throw new Error('read failure'); };
  await assert.rejects(h.plugin.cleanup.scan(), /read failure/);
  h.app.vault.read = async () => { h.emit('modify'); return ''; };
  await assert.rejects(h.plugin.cleanup.scan(), /引用已变化/);
  assert.equal(h.deleted.length, 0);
});

test('unsaved Markdown editor references protect images', async () => {
  const h = await harness(); h.add('assets/a.png'); const note = h.add('a.md', '');
  const view = new h.MarkdownView(); view.file = note; view.editor = { getValue: () => '![[assets/a.png]]' };
  h.app.workspace.getLeavesOfType = () => [{view}];
  assert.deepEqual(paths(await h.plugin.cleanup.scan()), []);
});

test('storage change blocks cloud deletion, and new objects cannot silently expand a reviewed selection', async () => {
  const h = await harness(); h.add('assets/a.png'); record(h, 'assets/a.png');
  const scan = await h.plugin.cleanup.scan();
  h.plugin.settings.s3.bucketName = 'different-bucket';
  let result = await h.plugin.cleanup.deleteSelected(scan.items, 'both');
  assert.equal(result[0].status, 'skipped');
  h.plugin.settings.s3.bucketName = 'local-test';
  record(h, 'assets/a.png', 'images/new-object.png');
  result = await h.plugin.cleanup.deleteSelected(scan.items, 'both');
  assert.equal(result[0].status, 'failed');
  assert.equal(h.requests.length, 0);
  assert.equal(h.deleted.length, 0);
});

test('retained upload records let a later scan clean unreferenced cloud-only images', async () => {
  const h = await harness(); h.add('assets/a.png'); record(h, 'assets/a.png');
  await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items, 'local');
  await h.plugin.loadSettings();
  const scan = await h.plugin.cleanup.scan();
  assert.equal(scan.items[0].local, false);
  const result = await h.plugin.cleanup.deleteSelected(scan.items, 'both');
  assert.equal(result[0].remoteDeleted, 1);
  assert.equal(result[0].localDeleted, false);
});

test('cleanup excludes overlapping uploads and repeated deletion calls', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({}, async () => { await gate; return {status:200, text:''}; });
  h.add('assets/a.png'); record(h, 'assets/a.png');
  const scan = await h.plugin.cleanup.scan();
  const first = h.plugin.cleanup.deleteSelected(scan.items, 'both');
  await assert.rejects(h.plugin.cleanup.deleteSelected(scan.items, 'both'), /正在执行/);
  h.add('pending.md', '![[assets/b.png]]'); h.add('assets/b.png');
  await h.plugin.runAutoScan();
  release(); await first;
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 0);
  assert.equal(h.plugin.cleanup.running, false);
});

test('partial failure reports cloud success separately when trashing fails', async () => {
  const h = await harness(); h.add('assets/a.png'); record(h, 'assets/a.png');
  h.app.vault.trash = async () => { throw new Error('trash unavailable'); };
  const result = await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items, 'both');
  assert.equal(result[0].status, 'failed');
  assert.equal(result[0].localDeleted, false);
  assert.equal(result[0].remoteDeleted, 1);
  assert.ok(h.plugin.settings.uploadRecords[0].deletedAt);
  assert.ok(h.files.has('assets/a.png'));
});

test('real localhost service verifies DELETE target and local removal after cloud acknowledgement', async t => {
  let cloudExists = true;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'DELETE');
    assert.equal(req.url, '/local-test/images/recorded.png');
    assert.ok(req.headers.authorization.startsWith('AWS4-HMAC-SHA256 '));
    cloudExists = false;
    res.writeHead(204).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const h = await harness({s3:{...baseSettings.s3, endpoint, customDomainName:`${endpoint}/local-test`}}, async p => {
    const r = await fetch(p.url, {method:p.method, headers:p.headers}); return {status:r.status, text:await r.text()};
  });
  h.add('assets/a.png'); record(h, 'assets/a.png');
  const originalTrash = h.app.vault.trash;
  h.app.vault.trash = async (f, system) => { assert.equal(cloudExists, false); return originalTrash(f, system); };
  const result = await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items, 'both');
  assert.equal(result[0].status, 'deleted');
  assert.equal(cloudExists, false);
});

test('percent-encoded and double-encoded cloud paths remain protected', async () => {
  const h = await harness(); h.add('assets/a.png');
  const key = 'images/中文 空格.png';
  h.plugin.cleanup.recordUpload('assets/a.png', 'hash', key,
    `${baseSettings.s3.customDomainName}/images/${encodeURIComponent('中文 空格.png')}`, baseSettings.s3);
  const stored = h.plugin.settings.uploadRecords[0];
  h.add('note.md', `![a.png](${encodeURI(stored.publicUrl)})`);
  const scan = await h.plugin.cleanup.scan();
  assert.match(scan.items[0].remoteBlock, /仍被引用/);
  const result = await h.plugin.cleanup.deleteSelected(scan.items, 'both');
  assert.equal(result[0].status, 'skipped');
  assert.equal(h.requests.length, 0);
});

test('metadata resolution protects references whose written target omits the extension', async () => {
  const h = await harness(); h.add('assets/a.png'); h.add('note.md', '[picture](assets/a)');
  h.app.metadataCache.resolvedLinks = {'note.md': {'assets/a.png': 1}};
  assert.deepEqual(paths(await h.plugin.cleanup.scan()), []);
});


test('OSS scheduled upload, encoded note links, reload and selected cloud cleanup work together', async () => {
  const h = await harness({s3: {...baseSettings.s3, provider: 'oss', region: 'oss-cn-hangzhou', endpoint: '',
    bucketName: 'codex-oss-fixture', customDomainName: 'https://img.example.com/相册 1', pathTemplate: 'images/中文 空格/{hash}.{ext}'}});
  const note = h.add('a.md', '![[assets/a.png]]'); h.add('assets/a.png');
  h.plugin.ensureS3Settings();
  await h.plugin.runAutoScan();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method, 'PUT');
  assert.ok(note.content.includes('/images/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC/'));
  assert.equal(note.content.includes('%25E4'), false);
  assert.ok(note.content.includes('/%E7%9B%B8%E5%86%8C%201/images/'));
  await h.plugin.loadSettings();
  const r = h.plugin.settings.uploadRecords[0];
  assert.equal(r.addressingStyle, 'virtual');
  assert.equal(r.endpoint, 'https://s3.oss-cn-hangzhou.aliyuncs.com');
  assert.equal(r.region, 'cn-hangzhou');
  assert.ok(h.files.has('assets/a.png'));
  assert.match((await h.plugin.cleanup.scan()).items[0].remoteBlock, /仍被引用/);
  note.content = ''; h.emit('modify');
  h.plugin.settings.s3.provider = 'custom';
  h.plugin.settings.s3.endpoint = r.endpoint;
  h.plugin.settings.s3.region = r.region;
  assert.match((await h.plugin.cleanup.scan()).items[0].remoteBlock, /配置/);
  h.plugin.settings.s3.provider = 'oss';
  const result = await h.plugin.cleanup.deleteSelected((await h.plugin.cleanup.scan()).items,'both');
  assert.equal(result[0].status,'deleted');
  assert.equal(h.requests[1].method,'DELETE');
  assert.equal(h.requests[0].url,h.requests[1].url);
  assert.deepEqual(h.deleted,['assets/a.png']);
  await h.plugin.loadSettings();
  assert.ok(h.plugin.settings.uploadRecords[0].deletedAt);
});

test('legacy path-style records remain deletable but cannot become OSS objects by changing provider', async () => {
  const h = await harness(); h.add('assets/a.png'); record(h,'assets/a.png');
  delete h.plugin.settings.uploadRecords[0].addressingStyle;
  assert.equal((await h.plugin.cleanup.scan()).items[0].remoteBlock,null);
  h.plugin.settings.s3 = {...h.plugin.settings.s3, provider:'oss', region:'cn-hangzhou', bucketName:'codex-oss-fixture'};
  const scan = await h.plugin.cleanup.scan();
  assert.ok(scan.items[0].remoteBlock);
  await h.plugin.cleanup.deleteSelected(scan.items,'both');
  assert.equal(h.requests.length,0);
});

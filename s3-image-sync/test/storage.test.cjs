const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { buildSync } = require('esbuild');
const { SignatureV4 } = require('@smithy/signature-v4');
const { Hash } = require('@smithy/hash-node');
const { HttpRequest } = require('@smithy/protocol-http');
const path = require('node:path');

const source = buildSync({
  stdin: { contents: 'export * from "./src/s3-client"; export * from "./src/storage-config";', resolveDir: path.join(__dirname, '..') },
  bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['obsidian'],
}).outputFiles[0].text;
const when = new Date('2026-09-05T10:20:30Z');
const config = { provider: 'oss', endpoint: 'ignored', region: 'cn-hangzhou', bucketName: 'codex-oss-fixture',
  accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret', customDomainName: 'https://img.example.com', pathTemplate: 'images/{hash}.{ext}' };
function client(respond = () => ({ status: 200, text: '' })) {
  const requests = [];
  const context = { module: {exports: {}}, exports: {}, URL, TextEncoder, Uint8Array, crypto: webcrypto,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [when])); } },
    window: { setTimeout: fn => queueMicrotask(fn) },
    require: id => { assert.equal(id, 'obsidian'); return { requestUrl: async request => {
      // No HTTP transport exists in this harness. All OSS requests stay in memory.
      requests.push(request); return respond(request, requests.length);
    } }; },
  };
  vm.runInNewContext(source, context);
  return { ...context.module.exports, requests };
}

async function assertAWSSignature(request) {
  const u = new URL(request.url);
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([k]) => k !== 'Authorization').map(([k,v]) => [k.toLowerCase(),v]));
  headers.host = u.host;
  const signer = new SignatureV4({ credentials: {accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey},
    service: 's3', region: config.region, sha256: Hash.bind(null, 'sha256'), uriEscapePath: false });
  const signed = await signer.sign(new HttpRequest({ hostname: u.hostname, protocol: u.protocol,
    method: request.method, path: u.pathname, headers, body: request.body ? Buffer.from(request.body) : undefined }),
    { signingDate: when, unsignableHeaders: new Set(['content-type']) });
  assert.equal(request.headers.Authorization, signed.headers.authorization);
}

test('OSS PUT, GET connection and DELETE use virtual hosts with AWS SDK matching signatures', async () => {
  const c = client();
  const key = "images/中文 空格!'()*+%.png";
  await c.putS3Object(config, key, new Uint8Array([1,2,3]), 'image/png', (s,t) => `${s}: ${t}`);
  await c.testS3Connection(config);
  await c.deleteS3Object(config, key);
  assert.deepEqual(c.requests.map(r => r.method), ['PUT','GET','DELETE']);
  for (const request of c.requests) {
    assert.equal(new URL(request.url).hostname, 'codex-oss-fixture.s3.oss-cn-hangzhou.aliyuncs.com');
    assert.equal(request.url.includes('/codex-oss-fixture/'), false);
    assert.equal(request.headers['x-oss-object-acl'], undefined);
    await assertAWSSignature(request);
  }
  assert.equal(new URL(c.requests[0].url).pathname, '/images/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC%21%27%28%29%2A%2B%25.png');
  assert.equal(c.requests[0].url, c.requests[2].url);
  assert.equal(new URL(c.requests[1].url).pathname, '/');
});

test('OSS accepts console region prefix, derives endpoint, rejects malformed config and unsafe paths before requesting', async () => {
  const c = client();
  assert.equal(c.resolveStorageConfig({...config, region: 'oss-cn-hangzhou'}).region, 'cn-hangzhou');
  assert.equal(c.resolveStorageConfig({...config, endpoint: ''}).endpoint, 'https://s3.oss-cn-hangzhou.aliyuncs.com');
  for (const broken of [{region: 'auto'}, {region: ''}, {region: '../x'}, {bucketName: 'UPPER'}, {bucketName: 'a.b'}]) {
    await assert.rejects(c.testS3Connection({...config, ...broken}), /Invalid OSS/);
  }
  for (const key of ['images/../a.png', './a.png']) await assert.rejects(c.deleteS3Object(config,key), /dot segments/);
  assert.equal(c.requests.length, 0);
});

test('existing R2, AWS S3, MinIO and custom endpoints retain path addressing', async () => {
  const c = client();
  for (const provider of ['r2','s3','minio','custom']) {
    const cfg = {...config, provider, endpoint: 'http://127.0.0.1:9000/prefix/'};
    assert.equal(c.storageRequestUrl(cfg,'images/a.png'), 'http://127.0.0.1:9000/prefix/codex-oss-fixture/images/a.png');
  }
});

test('connection redirects fail; permissions do not retry uploads; transient errors retry', async () => {
  for (const status of [301, 403, 404]) {
    const c = client(() => ({status, text:'fixture error'}));
    await assert.rejects(c.testS3Connection(config));
    await assert.rejects(c.putS3Object(config,'a.png',new Uint8Array([1]),'image/png',s=>String(s)));
    assert.equal(c.requests.length, 2);
  }
  for (const status of [429,503]) {
    const c = client((_,n) => ({status:n===1?status:200,text:''}));
    await c.putS3Object(config,'a.png',new Uint8Array([1]),'image/png',s=>String(s));
    assert.equal(c.requests.length,2);
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import test from 'node:test';
import { makeMessenger } from '../src/feishu.mjs';

const config = { appId: 'cli_mock', appSecret: 'mock_secret' };
const tokenResponse = () => Response.json({ code: 0, tenant_access_token: 'mock_token', expire: 3600 });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cX2sAAAAASUVORK5CYII=', 'base64');
const downloadError = (message) => ({ code: 'FEISHU_IMAGE_DOWNLOAD', message });

async function makeDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-image-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function mockFeishu(t, resource) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/auth/v3/tenant_access_token/internal')) return tokenResponse();
    return resource(url, options);
  });
}

test('downloads message image bytes with the current app token and uses separate private files', async (t) => {
  const directory = await makeDirectory(t);
  const fetch = mockFeishu(t, () => new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } }));
  const messenger = makeMessenger(config);
  const first = await messenger.downloadImage('om_mock/id', 'img_a?b', directory);
  const second = await messenger.downloadImage('om_mock/id', 'img_next', directory);

  assert.equal(fetch.mock.callCount(), 3);
  const [, authOptions] = fetch.mock.calls[0].arguments;
  assert.equal(authOptions.method, 'POST');
  assert.deepEqual(JSON.parse(authOptions.body), { app_id: config.appId, app_secret: config.appSecret });
  const [url, resourceOptions] = fetch.mock.calls[1].arguments;
  assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages/om_mock%2Fid/resources/img_a%3Fb?type=image');
  assert.equal(resourceOptions.method, 'GET');
  assert.equal(resourceOptions.headers.Authorization, 'Bearer mock_token');
  assert.equal(resourceOptions.redirect, 'error');
  assert.notEqual(first, second);
  for (const file of [first, second]) {
    assert.equal(dirname(file), directory);
    assert.equal(extname(file), '.png');
    assert.deepEqual(await readFile(file), png);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('classifies Feishu resource errors without exposing response details or writing a file', async (t) => {
  const directory = await makeDirectory(t);
  mockFeishu(t, () => Response.json({ code: 99991672, msg: 'sensitive response detail' }, { status: 403 }));
  await assert.rejects(
    makeMessenger(config).downloadImage('om_mock', 'img_denied', directory),
    (error) => error.code === 'FEISHU_IMAGE_DOWNLOAD' && /99991672.*im:message:readonly/.test(error.message)
      && !error.message.includes('sensitive response detail'),
  );
  assert.deepEqual(await readdir(directory), []);
});

test('rejects oversized advertised and chunked images before saving', async (t) => {
  const directory = await makeDirectory(t);
  let cancelled = false;
  const advertisedBody = new ReadableStream({ cancel() { cancelled = true; } });
  mockFeishu(t, (url) => {
    if (url.includes('img_advertised')) {
      return new Response(advertisedBody, { headers: { 'Content-Length': String(11 * 1024 * 1024) } });
    }
    const chunks = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        controller.close();
      },
    });
    return new Response(chunks);
  });
  const messenger = makeMessenger(config);
  for (const key of ['img_advertised', 'img_chunked']) {
    await assert.rejects(messenger.downloadImage('om_mock', key, directory), downloadError(/超过 10 MiB/));
  }
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(directory), []);
});

test('rejects empty or unsupported image bytes', async (t) => {
  const directory = await makeDirectory(t);
  mockFeishu(t, (url) => url.includes('img_empty') ? new Response() : new Response('unexpected text', {
    headers: { 'Content-Type': 'image/png' },
  }));
  const messenger = makeMessenger(config);
  await assert.rejects(messenger.downloadImage('om_mock', 'img_empty', directory), downloadError(/空图片/));
  await assert.rejects(messenger.downloadImage('om_mock', 'img_bad', directory), downloadError(/格式不受支持/));
  assert.deepEqual(await readdir(directory), []);
});

test('times out during body transfer before saving', async (t) => {
  const directory = await makeDirectory(t);
  const deadline = new AbortController();
  const started = Promise.withResolvers();
  mockFeishu(t, (_, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(png.subarray(0, 8));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      started.resolve();
    },
  })));
  const messenger = makeMessenger(config);
  await messenger.check();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const download = messenger.downloadImage('om_mock', 'img_slow', directory);
  await started.promise;
  deadline.abort();
  await assert.rejects(download, downloadError(/下载飞书图片超时/));
  assert.deepEqual(timeout.mock.calls[0].arguments, [10_000]);
  assert.deepEqual(await readdir(directory), []);
});

test('cancels an image job awaiting the shared token without stopping other callers', async (t) => {
  const directory = await makeDirectory(t);
  const auth = Promise.withResolvers();
  const fetch = t.mock.method(globalThis, 'fetch', async () => auth.promise);
  const messenger = makeMessenger(config);
  const controller = new AbortController();
  const download = messenger.downloadImage('om_mock', 'img_cancelled', directory, { signal: controller.signal });
  const check = messenger.check();
  controller.abort();
  await assert.rejects(download, downloadError(/下载已取消/));
  assert.equal(fetch.mock.callCount(), 1);
  auth.resolve(tokenResponse());
  await check;
  assert.deepEqual(await readdir(directory), []);
});

import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const API = 'https://open.feishu.cn/open-apis';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const imageError = (message) => Object.assign(new Error(message), { code: 'FEISHU_IMAGE_DOWNLOAD' });
const silentLogger = Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((method) => [method, () => {}]),
);

export async function connectFeishu(config, onMessage) {
  const { default: lark } = await import('@larksuiteoapi/node-sdk');
  const ws = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: lark.Domain.Feishu,
    logger: silentLogger,
  });
  const eventDispatcher = new lark.EventDispatcher({ logger: silentLogger }).register({
    'im.message.receive_v1': (event) => { onMessage(event); },
  });
  return ws.start({ eventDispatcher }).then(() => ws);
}

async function request(path, { method, payload, token }) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = 'Bearer ' + token;

  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
  } catch {
    throw new Error('无法访问飞书接口。请检查网络。');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 0) {
    const code = Number.isSafeInteger(body?.code) ? body.code : response.status;
    throw new Error('飞书接口失败（' + code + '）。请检查应用权限与发布状态。');
  }
  return body;
}

async function readImageResponse(response) {
  if (!response.body) return Buffer.alloc(0);
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    void response.body.cancel().catch(() => {});
    throw imageError('图片超过 10 MiB，请压缩后重新发送。');
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_IMAGE_BYTES) throw imageError('图片超过 10 MiB，请压缩后重新发送。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  const signature = bytes.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') return '.gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return undefined;
}

export function makeMessenger(config) {
  let cachedToken;
  let pendingToken;
  async function token() {
    if (cachedToken?.expiresAt > Date.now()) return cachedToken.value;
    pendingToken ??= request('/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      payload: { app_id: config.appId, app_secret: config.appSecret },
    }).then((data) => {
      if (!data.tenant_access_token || !Number.isFinite(data.expire)) {
        throw new Error('飞书返回了无效的应用凭证响应。');
      }
      cachedToken = {
        value: data.tenant_access_token,
        expiresAt: Date.now() + 1000 * Math.max(0, data.expire - 60),
      };
      return cachedToken.value;
    }).finally(() => { pendingToken = undefined; });
    return pendingToken;
  }

  async function downloadToken(signal) {
    // A cancelled download must stop waiting without aborting authentication for other calls.
    signal.throwIfAborted();
    let listener;
    const aborted = new Promise((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    try {
      return await Promise.race([token(), aborted]);
    } finally {
      listener[Symbol.dispose]();
    }
  }

  return {
    async check() { await token(); },
    async getBotOpenId() {
      const { bot } = await request('/bot/v3/info', { method: 'GET', token: await token() });
      if (typeof bot?.open_id !== 'string' || !/^ou_\S+$/.test(bot.open_id)) {
        throw new Error('飞书未返回有效的机器人 Open ID。');
      }
      return bot.open_id;
    },
    async downloadImage(messageId, imageKey, directory, { signal } = {}) {
      if ([messageId, imageKey].some((value) => typeof value !== 'string' || !value || value === '.' || value === '..')) {
        throw imageError('飞书图片消息缺少有效的下载信息，请重新发送。');
      }
      const timeout = AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
      const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let bytes;
      try {
        const accessToken = await downloadToken(downloadSignal);
        const path = '/im/v1/messages/' + encodeURIComponent(messageId) + '/resources/' + encodeURIComponent(imageKey);
        const response = await fetch(API + path + '?type=image', {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + accessToken },
          signal: downloadSignal,
          redirect: 'error',
        });
        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (!response.ok || contentType === 'application/json') {
          let code = response.status;
          if (contentType === 'application/json') {
            const errorBytes = await readImageResponse(response);
            try {
              const error = JSON.parse(errorBytes.toString('utf8'));
              if (Number.isSafeInteger(error?.code)) code = error.code;
            } catch { /* Keep the HTTP status if Feishu did not return a valid error body. */ }
          } else {
            void response.body?.cancel().catch(() => {});
          }
          throw imageError(`飞书图片下载失败（${code}）。请确认图片可访问，并开通 im:message:readonly 权限后发布应用版本。`);
        }
        bytes = await readImageResponse(response);
        downloadSignal.throwIfAborted();
      } catch (error) {
        if (signal?.aborted) throw imageError('飞书图片下载已取消。');
        if (timeout.aborted) throw imageError('下载飞书图片超时，请稍后重试。');
        if (error?.code === 'FEISHU_IMAGE_DOWNLOAD') throw error;
        throw imageError('无法获取飞书图片。请检查网络或飞书应用配置。');
      }

      if (!bytes.length) throw imageError('飞书返回了空图片，请重新发送。');
      const extension = imageExtension(bytes);
      if (!extension) throw imageError('图片格式不受支持，请使用 PNG、JPEG、WebP 或 GIF。');
      const filePath = resolve(directory, randomUUID() + extension);
      try {
        await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600, signal: downloadSignal });
        downloadSignal.throwIfAborted();
      } catch {
        if (signal?.aborted) throw imageError('飞书图片下载已取消。');
        if (timeout.aborted) throw imageError('下载飞书图片超时，请稍后重试。');
        throw imageError('本机无法保存图片，请检查临时目录权限和磁盘空间。');
      }
      return filePath;
    },
    async reply(messageId, text) {
      const chars = Array.from(text.trim());
      if (!chars.length) return;
      const accessToken = await token();
      const chunkSize = 6000;
      const total = Math.ceil(chars.length / chunkSize);
      for (let part = 0; part < total; part++) {
        const prefix = total === 1 ? '' : '[' + (part + 1) + '/' + total + '] ';
        await request('/im/v1/messages/' + encodeURIComponent(messageId) + '/reply', {
          method: 'POST',
          token: accessToken,
          payload: {
            msg_type: 'text',
            content: JSON.stringify({ text: prefix + chars.slice(part * chunkSize, (part + 1) * chunkSize).join('') }),
            uuid: randomUUID(),
          },
        });
      }
    },
  };
}

import { randomUUID } from 'node:crypto';

const API = 'https://open.feishu.cn/open-apis';
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

async function post(path, payload, token) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = 'Bearer ' + token;

  let response;
  try {
    response = await fetch(API + path, {
      method: 'POST',
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

export function makeMessenger(config) {
  let cachedToken;
  let pendingToken;
  async function token() {
    if (cachedToken?.expiresAt > Date.now()) return cachedToken.value;
    pendingToken ??= post('/auth/v3/tenant_access_token/internal', {
      app_id: config.appId,
      app_secret: config.appSecret,
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

  return {
    async check() { await token(); },
    async reply(messageId, text) {
      const chars = Array.from(text.trim());
      if (!chars.length) return;
      const accessToken = await token();
      const chunkSize = 6000;
      const total = Math.ceil(chars.length / chunkSize);
      for (let part = 0; part < total; part++) {
        const prefix = total === 1 ? '' : '[' + (part + 1) + '/' + total + '] ';
        await post('/im/v1/messages/' + encodeURIComponent(messageId) + '/reply', {
          msg_type: 'text',
          content: JSON.stringify({ text: prefix + chars.slice(part * chunkSize, (part + 1) * chunkSize).join('') }),
          uuid: randomUUID(),
        }, accessToken);
      }
    },
  };
}

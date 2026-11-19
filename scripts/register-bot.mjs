import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const usage = `用法：node scripts/register-bot.mjs --name '机器人名称' [--description '应用说明']
在飞书授权后，将新应用凭证保存到本机临时目录。`;

class RegistrationError extends Error {}

async function main() {
  let options;
  try {
    ({ values: options } = parseArgs({
      options: {
        name: { type: 'string' },
        description: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch {
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage);
    return;
  }

  const name = options.name?.trim();
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) {
    console.error('请用 --name 指定 1–60 个可显示字符的机器人名称。');
    process.exitCode = 2;
    return;
  }

  const controller = new AbortController();
  const { signal } = controller;
  const cancel = (receivedSignal) => controller.abort(receivedSignal);
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let directory;
  let credentialsWritten = false;

  try {
    const permissions = new URL('../feishu-permissions.json', import.meta.url);
    const { scopes } = JSON.parse(readFileSync(permissions, 'utf8'));
    if (!Array.isArray(scopes?.tenant) || !scopes.tenant.length) {
      throw new RegistrationError('feishu-permissions.json 缺少应用身份权限。');
    }

    const { default: sdk } = await import('@larksuiteoapi/node-sdk');
    if (typeof sdk.registerApp !== 'function') {
      throw new RegistrationError('当前飞书 SDK 不支持注册，请运行 npm ci --ignore-scripts 安装仓库依赖。');
    }
    directory = mkdtempSync(join(tmpdir(), 'feishu-codex-registration-'));
    chmodSync(directory, 0o700);

    const desc = options.description?.trim();
    signal.throwIfAborted();
    const result = await sdk.registerApp({
      source: 'feishu-local-codex',
      createOnly: true,
      signal,
      appPreset: desc ? { name, desc } : { name },
      addons: { preset: false, scopes, events: { items: { tenant: ['im.message.receive_v1'] } } },
      onQRCodeReady({ url, expireIn }) {
        signal.throwIfAborted();
        const authorization = new URL(url);
        if (authorization.protocol !== 'https:' || authorization.username || authorization.password) {
          throw new RegistrationError('飞书返回了无效的授权链接。');
        }
        console.log('请在浏览器打开链接，并在飞书确认应用与权限。');
        console.log(authorization.href);
        if (Number.isFinite(expireIn)) console.log(`授权链接有效期 ${expireIn} 秒。`);
      },
    });

    signal.throwIfAborted();
    const { client_id: appId, client_secret: appSecret } = result ?? {};
    if (typeof appId !== 'string' || !/^cli_[\da-f]{16}$/i.test(appId) ||
        typeof appSecret !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(appSecret)) {
      throw new RegistrationError('飞书返回了无效的应用凭证，请到开发者后台检查应用。');
    }

    const credentialsFile = join(directory, 'credentials.json');
    try {
      writeFileSync(credentialsFile, JSON.stringify({ appId, appSecret }) + '\n', { mode: 0o600, flag: 'wx' });
    } catch {
      throw new RegistrationError('应用已注册，但凭证保存失败。请到飞书开发者后台检查应用凭证。');
    }
    credentialsWritten = true;
    console.log('注册完成。凭证文件 ' + credentialsFile);
  } catch (error) {
    process.exitCode = 1;
    if (signal.aborted) {
      console.error('注册已取消。');
      process.exitCode = signal.reason === 'SIGINT' ? 130 : 143;
    } else if (error instanceof RegistrationError) {
      console.error(error.message);
    } else if (error?.code === 'access_denied') {
      console.error('飞书授权未通过。');
    } else if (error?.code === 'expired_token') {
      console.error('飞书授权链接已过期，请重新运行注册脚本。');
    } else if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('无法加载飞书 SDK，请运行 npm ci --ignore-scripts 安装仓库依赖。');
    } else {
      console.error('注册失败，请检查本机权限、网络和飞书组织的应用创建权限。');
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (directory && !credentialsWritten) {
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  }
}

await main();

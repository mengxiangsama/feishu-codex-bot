import { execFileSync } from 'node:child_process';
import {
  accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, rmSync, rmdirSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeMessenger } from '../src/feishu.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const appIdPattern = /^cli_[0-9a-f]{16}$/i;
const usage = `用法
  node scripts/install-bot.mjs --credentials 文件 --name 名称 --model 模型 --reasoning-effort 强度
  可选参数  --sandbox read-only|workspace-write  --service-tier priority
  --model 和 --reasoning-effort 可分别用 - 选择 Codex 默认值。`;

function readCredentials(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) {
      throw new Error('invalid credentials file');
    }
    const { appId, appSecret } = JSON.parse(readFileSync(fd, 'utf8'));
    if (typeof appId !== 'string' || !appIdPattern.test(appId) ||
        typeof appSecret !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(appSecret)) {
      throw new Error('invalid credentials');
    }
    return { appId, appSecret };
  } catch {
    throw new Error('凭证文件无效。请使用注册脚本生成的私有文件。');
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateDir(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('机器人数据目录需由当前用户拥有，且仅当前用户可访问。');
  }
}

function checkPrimaryConfig(root, appId) {
  let data;
  try { data = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('无法读取主桥接配置。');
  }
  if (data?.version !== 1 || !Array.isArray(data.bots)) throw new Error('主桥接配置格式无效。');
  if (data.bots.some((bot) => typeof bot?.appId === 'string' && bot.appId.toLowerCase() === appId.toLowerCase())) {
    throw new Error('该飞书应用已加入主桥接。请为独立服务使用另一个应用。');
  }
}

const xmlString = (value) => `<string>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`;
function servicePlist({ label, appId, dataDir, codexBin, log }) {
  const args = [process.execPath, join(projectDir, 'src/main.mjs'), 'start', appId].map(xmlString).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${xmlString(label)}
  <key>ProgramArguments</key><array>${args}</array>
  <key>WorkingDirectory</key>${xmlString(projectDir)}
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key>${xmlString(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')}
    <key>FEISHU_BRIDGE_DATA_DIR</key>${xmlString(dataDir)}
    <key>FEISHU_CODEX_BIN</key>${xmlString(codexBin)}
  </dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key>${xmlString(log)}
  <key>StandardErrorPath</key>${xmlString(log)}
</dict>
</plist>
`;
}

function findCodex(codexExecutable) {
  try {
    const configured = codexExecutable();
    const path = configured === 'codex'
      ? execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      : configured;
    if (!statSync(path).isFile()) throw new Error();
    accessSync(path, constants.X_OK);
    return resolve(path);
  } catch {
    throw new Error('未找到可执行的 Codex CLI。请安装 CLI 或设置 FEISHU_CODEX_BIN。');
  }
}

async function install(values) {
  if (process.platform !== 'darwin') throw new Error('此脚本需要 macOS。');
  const { appId, appSecret } = readCredentials(values.credentials);
  const root = resolve(process.env.FEISHU_BRIDGE_DATA_DIR || join(projectDir, '.local'));
  const instances = join(root, 'new-bots');
  const dataDir = join(instances, appId.toLowerCase());
  const workspaces = join(projectDir, 'workspaces');
  const workspace = join(workspaces, appId.toLowerCase());
  const launchAgents = join(homedir(), 'Library', 'LaunchAgents');
  const label = 'local.feishu.codex-bridge.' + appId.toLowerCase();
  const plist = join(launchAgents, label + '.plist');
  const log = join(dataDir, 'bridge.log');

  process.env.FEISHU_BRIDGE_DATA_DIR = dataDir;
  const { codexExecutable, saveMappings, validateMapping } = await import('../src/config.mjs');
  const codexCli = findCodex(codexExecutable);
  ensurePrivateDir(root);
  checkPrimaryConfig(root, appId);
  await makeMessenger({ appId, appSecret }).check();
  ensurePrivateDir(instances);
  mkdirSync(workspaces, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { mode: 0o700 });
  let createdWorkspace = false;
  let createdPlist = false;
  try {
    mkdirSync(workspace, { mode: 0o700 });
    createdWorkspace = true;
    const mapping = validateMapping({
      appId, appSecret, workspace, name: values.name.trim(), persona: '', sandbox: values.sandbox,
      model: values.model === '-' ? '' : values.model,
      reasoningEffort: values['reasoning-effort'] === '-' ? '' : values['reasoning-effort'],
    });
    saveMappings([mapping]);

    let codexBin = codexCli;
    if (values['service-tier'] === 'priority') {
      codexBin = join(dataDir, 'codex-priority');
      const quotedCli = "'" + codexCli.replaceAll("'", "'\\''") + "'";
      writeFileSync(codexBin, `#!/bin/sh\nexec ${quotedCli} -c 'service_tier="priority"' "$@"\n`, { mode: 0o700, flag: 'wx' });
    }
    writeFileSync(log, '', { mode: 0o600, flag: 'wx' });
    const fd = openSync(plist, 'wx', 0o600);
    createdPlist = true;
    try { writeFileSync(fd, servicePlist({ label, appId, dataDir, codexBin, log })); } finally { closeSync(fd); }
    execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'ignore', timeout: 10000 });
  } catch (error) {
    if (createdPlist) rmSync(plist, { force: true });
    rmSync(dataDir, { recursive: true, force: true });
    if (createdWorkspace) rmdirSync(workspace);
    throw error;
  }

  const domain = `gui/${process.getuid()}`;
  console.log(`服务 ${label}\n配置 ${plist}\n私有日志 ${log}`);
  try {
    execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'ignore', timeout: 20000 });
  } catch {
    throw new Error('launchd 启动未确认。已保留服务配置，请检查服务状态后再加载。');
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (readFileSync(log, 'utf8').includes('飞书长连接在线。')) {
      console.log('飞书长连接已上线。请到飞书后台核对事件配置和发布状态。');
      return;
    }
    await setTimeout(1000);
  }
  console.log('launchd 已加载服务，30 秒内未确认飞书长连接。请检查私有日志。');
}

try {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, credentials: { type: 'string' }, name: { type: 'string' },
    model: { type: 'string' }, 'reasoning-effort': { type: 'string' },
    sandbox: { type: 'string', default: 'read-only' }, 'service-tier': { type: 'string' },
  } });
  if (values.help) console.log(usage);
  else if (!values.credentials || !values.name?.trim() || !values.model || !values['reasoning-effort'] ||
      !['read-only', 'workspace-write'].includes(values.sandbox) ||
      (values['service-tier'] !== undefined && values['service-tier'] !== 'priority')) {
    console.error(usage);
    process.exitCode = 1;
  } else await install(values);
} catch (error) {
  if (error.code === 'EEXIST') console.error('目标配置、工作目录或服务文件已存在。请检查已有安装。');
  else if (error.code) console.error('安装失败。请检查参数、本机路径、目录权限及 launchd 配置。');
  else console.error(error.message);
  process.exitCode = 1;
}

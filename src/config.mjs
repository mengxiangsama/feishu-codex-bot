import { accessSync, chmodSync, constants, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASONING_EFFORTS } from './codex-runner.mjs';

export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export const localDir = resolve(process.env.FEISHU_BRIDGE_DATA_DIR || join(projectDir, '.local'));
const configPath = join(localDir, 'config.json');
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

export function ensureLocalDir() {
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  chmodSync(localDir, 0o700);
}

export function codexExecutable() {
  if (process.env.FEISHU_CODEX_BIN) return resolve(process.env.FEISHU_CODEX_BIN);
  try {
    accessSync(bundledCodex, constants.X_OK);
    return bundledCodex;
  } catch {
    return 'codex';
  }
}

export function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') throw new Error('机器人配置格式有误。');
  if (typeof mapping.name !== 'string' || !mapping.name.trim() || mapping.name.length > 60 ||
      /[\x00-\x1f\x7f]/.test(mapping.name)) throw new Error('名称须为 1–60 个可显示字符。');
  if (typeof mapping.appId !== 'string' || !/^cli_[\da-f]{16}$/i.test(mapping.appId)) {
    throw new Error('App ID 格式有误，应为 cli_ 加 16 位十六进制字符。');
  }
  if (typeof mapping.appSecret !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(mapping.appSecret)) {
    throw new Error('App Secret 缺失或格式有误。');
  }
  if (typeof mapping.persona !== 'string' || mapping.persona.length > 4000) {
    throw new Error('角色说明最长 4000 字符。');
  }
  if (typeof mapping.model !== 'string' || !/^[a-zA-Z0-9._-]{0,100}$/.test(mapping.model)) {
    throw new Error('模型 ID 格式有误。可输入 - 使用 Codex 默认模型。');
  }
  const reasoningEffort = mapping.reasoningEffort ?? '';
  if (reasoningEffort !== '' && !REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error('推理强度须为 ' + REASONING_EFFORTS.join('、') + ' 之一，也可输入 - 使用 Codex 默认值。');
  }
  if (!['read-only', 'workspace-write'].includes(mapping.sandbox)) throw new Error('请选只读或允许修改工作目录。');
  if (typeof mapping.workspace !== 'string' || !mapping.workspace.length) throw new Error('请填写工作目录。');
  let workspace;
  try {
    workspace = realpathSync(mapping.workspace);
    if (!statSync(workspace).isDirectory()) throw new Error();
    const data = realpathSync(localDir);
    if (workspace === data || workspace.startsWith(data + '/') ||
        data.startsWith(workspace + '/') || dirname(workspace) === workspace) {
      throw new Error();
    }
  } catch {
    throw new Error('工作目录必须存在，且不能包含本工具的密钥目录或位于其内部。');
  }
  return { ...mapping, reasoningEffort, workspace };
}

export function loadMappings() {
  let content;
  try {
    content = readFileSync(configPath, 'utf8');
    chmodSync(configPath, 0o600);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('无法读取本机配置文件。');
  }

  let config;
  try { config = JSON.parse(content); } catch { throw new Error('本机配置文件不是有效 JSON。'); }
  if (config?.version !== 1 || !Array.isArray(config.bots)) throw new Error('本机配置版本有误。');
  const bots = config.bots.map(validateMapping);
  if (new Set(bots.map(({ appId }) => appId)).size !== bots.length) {
    throw new Error('同一飞书应用只能配置一个机器人。');
  }
  return bots;
}

export function saveMappings(bots) {
  ensureLocalDir();
  const temp = configPath + '.' + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, bots }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, configPath);
  } finally {
    rmSync(temp, { force: true });
  }
}

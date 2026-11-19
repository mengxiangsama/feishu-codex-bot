import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Bot } from './bot.mjs';
import { codexExecutable, ensureLocalDir, loadMappings, localDir, projectDir, saveMappings, validateMapping } from './config.mjs';
import { connectFeishu, makeMessenger } from './feishu.mjs';
import { CodexRunner, REASONING_EFFORTS } from './codex-runner.mjs';
import { reserveTeamWorker, TeamRunner } from './team-runner.mjs';

const [, , command = 'help', selector] = process.argv;

async function setup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('请在本机终端运行 npm run setup。');
  }

  const mappings = loadMappings();
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (muted) done();
      else process.stdout.write(chunk, done);
    },
  });
  output.isTTY = true;
  output.columns = process.stdout.columns;
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  const cancelled = new AbortController();
  terminal.on('SIGINT', () => cancelled.abort());
  async function ask(label, hide = false) {
    process.stdout.write(label + (hide ? '（输入和粘贴内容不会显示）' : '') + ' ');
    muted = hide;
    try {
      return (await terminal.question('', { signal: cancelled.signal })).trim();
    } finally {
      muted = false;
      if (hide) process.stdout.write('\n');
    }
  }

  async function askCodexSetting(label, currentValue, updating) {
    const hint = updating
      ? '，直接回车保留当前设置（' + (currentValue || 'Codex 默认值') + '），输入 - 使用 Codex 默认值'
      : '，输入 - 使用 Codex 默认值';
    let input;
    do {
      input = await ask(label + hint);
    } while (!input && !updating);
    return input === '-' ? '' : input || currentValue || '';
  }

  try {
    console.log('创建或更新机器人。每个机器人使用一个飞书自建应用。');
    const appId = await ask('飞书 App ID');
    if (!/^cli_[\da-f]{16}$/i.test(appId)) throw new Error('App ID 格式有误，应为 cli_ 加 16 位十六进制字符。');
    const current = mappings.find((entry) => entry.appId === appId);
    const appSecret = await ask('飞书 App Secret' + (current ? '，留空保留当前密钥' : ''), true) || current?.appSecret;
    const name = await ask('机器人名称 [' + (current?.name || '本机 Codex') + ']') || current?.name || '本机 Codex';
    const personaInput = await ask('角色说明，例如「Java 项目助手，优先用中文回复」' + (current ? '，留空保留，填 - 清空' : '，可留空'));
    const persona = personaInput === '-' ? '' : personaInput || current?.persona || '';
    const model = await askCodexSetting('Codex 模型 ID', current?.model, Boolean(current));
    const reasoningEffort = await askCodexSetting(
      'Codex 推理强度 [' + REASONING_EFFORTS.join('/') + ']', current?.reasoningEffort, Boolean(current),
    );
    const defaultWorkspace = current?.workspace || join(projectDir, 'workspaces', appId);
    const workspaceInput = await ask('工作目录，留空使用 ' + defaultWorkspace);
    const workspace = workspaceInput ? resolve(workspaceInput.replace(/^~(?=\/|$)/, homedir())) : defaultWorkspace;
    const access = await ask('权限 [1 只读，2 允许修改工作目录]，留空使用' + (current?.sandbox === 'workspace-write' ? ' 2' : ' 1'));
    if (access && access !== '1' && access !== '2') throw new Error('权限请输入 1 或 2。');
    const sandbox = access === '2' ? 'workspace-write' : access === '1' ? 'read-only' : current?.sandbox || 'read-only';
    if (!workspaceInput && !current) mkdirSync(workspace, { recursive: true, mode: 0o700 });
    ensureLocalDir();
    const mapping = validateMapping({ name, appId, appSecret, persona, model, reasoningEffort, sandbox, workspace });
    const others = mappings.filter((entry) => entry.appId !== appId);
    if (others.some((entry) => entry.name === name)) throw new Error('该名称已用于另一条连接。请用其他名称。');
    saveMappings([...others, mapping]);
    console.log('已保存在本机。运行 npm run check 检查，再用 npm start 连接。已运行的桥接需要重启以加载更改。');
  } finally {
    terminal.close();
  }
}

function selectedMappings() {
  const mappings = loadMappings().filter((entry) =>
    !selector || entry.name === selector || entry.appId === selector);
  if (!mappings.length) throw new Error(selector ? '找不到这条连接。运行 npm run list 查看。' : '请先运行 npm run setup 添加一条连接。');
  return mappings;
}

async function check() {
  const auth = spawnSync(codexExecutable(), ['login', 'status'], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failed = false;
  if (auth.status === 0) console.log('通过  本机 Codex 已登录。');
  else {
    failed = true;
    console.error(auth.error?.code === 'ENOENT' ? '未找到 Codex CLI。请安装 Codex CLI。' : 'Codex 未通过登录检查。请在终端运行 codex login。');
  }
  for (const config of selectedMappings()) {
    console.log('[' + config.name + ']');
    try {
      await makeMessenger(config).check();
      console.log('  通过  飞书应用凭证。');
    } catch (error) {
      failed = true;
      console.error('  失败  飞书应用凭证。' + error.message);
    }
  }
  if (failed) process.exitCode = 1;
}

function acquireLock() {
  ensureLocalDir();
  const path = join(localDir, 'running.pid');
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = readFileSync(path, 'utf8').trim();
    throw new Error('程序已有启动记录（PID ' + (/^\d+$/.test(pid) ? pid : '未知') + '）。请先关闭已有窗口。如确认进程已结束，可删除本机 .local/running.pid 后重试。');
  }
  process.once('exit', () => rmSync(path, { force: true }));
}

function loadTeam(mappings, bots) {
  try {
    const team = JSON.parse(readFileSync(join(localDir, 'team.json'), 'utf8'));
    const leader = mappings.find(({ appId }) => appId === team.leaderAppId);
    const workerIds = team.workerAppIds ?? [team.workerAppId];
    if (team.version !== 1 || typeof team.chatId !== 'string' || !/^oc_[A-Za-z0-9]+$/.test(team.chatId) ||
        !leader || !Array.isArray(workerIds) || !workerIds.length ||
        new Set(workerIds).size !== workerIds.length || workerIds.includes(leader.appId)) {
      throw new Error('invalid team');
    }
    const workers = workerIds.map((id) => mappings.find(({ appId }) => appId === id));
    if (workers.some((worker) => !worker)) throw new Error('invalid team worker');
    const makeRunner = (bot, sandbox, workspace) => new CodexRunner({
      codexBin: codexExecutable(),
      workspace,
      sandbox,
      model: bot.model || undefined,
      reasoningEffort: bot.reasoningEffort,
    });
    const teamRunner = new TeamRunner({
      workspaceRoot: leader.workspace,
      leaderName: leader.name,
      workerSandbox: leader.sandbox,
      makeLeader: ({ workspace }) => makeRunner(leader, 'read-only', workspace),
      acquireWorker: async ({ workspace, signal, onWait }) => {
        const { worker, release } = await reserveTeamWorker(
          () => workers.map((worker) => ({ worker, bot: bots.get(worker.appId) })), signal, onWait,
        );
        try {
          signal.throwIfAborted();
          return { name: worker.name, runner: makeRunner(worker, leader.sandbox, workspace), release };
        } catch (error) {
          release();
          throw error;
        }
      },
    });
    console.log(`协作模式已启用：${leader.name} 负责，执行者：${workers.map(({ name }) => name).join('、')}。`);
    return { leaderAppId: leader.appId, chatId: team.chatId, runner: teamRunner };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('协作模式未启用。请检查本机 team.json，并启动配置的负责人和执行者。');
    return null;
  }
}

async function start() {
  const mappings = selectedMappings();
  acquireLock();
  const bots = new Map();
  const team = loadTeam(mappings, bots);

  const connections = [];
  let stopping = false;
  let timer;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    for (const { ws } of connections) ws?.close({ force: true });
    await Promise.allSettled(connections.map(({ bot }) => bot.close()));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown);

  for (const config of mappings) {
    if (stopping) break;
    const logPrefix = '[' + config.name + '] ';
    const fingerprints = [config.workspace, config.sandbox, config.model];
    const fingerprint = createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex').slice(0, 12);
    try {
      const bot = new Bot({
        stateFile: join(localDir, config.appId + '-' + fingerprint + '.json'),
        runner: new CodexRunner({
          codexBin: codexExecutable(),
          workspace: config.workspace,
          sandbox: config.sandbox,
          model: config.model || undefined,
          reasoningEffort: config.reasoningEffort,
        }),
        messenger: makeMessenger(config),
        botName: config.name,
        persona: config.persona,
        ...(team?.leaderAppId === config.appId && {
          teamRunner: team.runner,
          teamChatId: team.chatId,
        }),
        logger: {
          info: (message) => console.log(logPrefix + message),
          warn: (message) => console.warn(logPrefix + message),
          error: (message) => console.error(logPrefix + message),
        },
      });
      bots.set(config.appId, bot);
      connections.push({ config, bot, code: bot.pairingCode, label: logPrefix });
    } catch (error) {
      console.error(logPrefix + '启动失败。' + error.message);
    }
  }

  for (const connection of connections) {
    if (stopping) break;
    const { config, bot, label } = connection;
    try {
      connection.ws = await connectFeishu(config, (event) => bot.handleEvent(event));
      if (stopping) connection.ws.close({ force: true });
      else console.log(label + '正在连接飞书…');
    } catch (error) {
      console.error(label + '启动失败。' + error.message);
    }
  }

  if (stopping) return;
  if (!connections.some(({ ws }) => ws)) {
    await shutdown();
    process.exitCode = 1;
    return;
  }

  timer = setInterval(() => {
    for (const connection of connections) {
      const state = connection.ws?.getConnectionStatus().state;
      if (state !== connection.status) {
        connection.status = state;
        if (state === 'connected') {
          console.log(connection.label + '飞书长连接在线。现在可在后台保存长连接配置。');
          if (connection.bot.pairingCode) {
            console.log(connection.label + '应用发布后，请私聊机器人并发送 /pair ' + connection.bot.pairingCode);
          }
        } else if (state === 'failed' || state === 'reconnecting') {
          console.warn(connection.label + '长连接' + (state === 'failed' ? '失败。运行 npm run check 检查凭证。' : '中断，正在重连…'));
        }
      }
      if (connection.code && connection.bot.ownerOpenId) {
        console.log(connection.label + '已绑定飞书账号。');
        connection.code = undefined;
      }
    }
  }, 1000);
}

try {
  if (command === 'setup') await setup();
  else if (command === 'start') await start();
  else if (command === 'check') await check();
  else if (command === 'list') {
    const mappings = loadMappings();
    if (!mappings.length) console.log('暂未配置。运行 npm run setup 添加连接。');
    else mappings.forEach(({ name, appId, workspace, model, reasoningEffort, sandbox }) => {
      console.log(name + '  ' + appId + '  ' + (model || '默认模型') + '  ' +
        (reasoningEffort || '默认推理强度') + '  ' + sandbox + '\n  ' + workspace);
    });
  } else {
    console.log('飞书 Codex 机器人\n\nnpm run setup    新建或更新机器人\nnpm run list     查看机器人\nnpm run check    检查凭证\nnpm start        启动机器人');
    if (command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  if (error.name === 'AbortError') console.log('已取消。');
  else {
    console.error(error.message);
    process.exitCode = 1;
  }
}

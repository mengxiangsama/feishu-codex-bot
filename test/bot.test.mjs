import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.mjs';

let messageCounter = 0;
function event(text, options = {}) {
  return {
    sender: { sender_type: options.senderType ?? 'user', sender_id: { open_id: options.sender ?? 'ou_owner' } },
    message: {
      message_id: options.id ?? `om_${++messageCounter}`,
      chat_id: options.chat ?? 'oc_private',
      chat_type: options.chatType ?? 'p2p',
      message_type: options.type ?? 'text',
      content: options.content ?? JSON.stringify({ text }),
      mentions: options.mentions ?? [],
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-bot-test-'));
  const replies = [];
  const calls = [];
  const logs = [];
  const runner = options.runner ?? {
    async run(input) {
      calls.push(input);
      const sessionId = input.sessionId ?? `opaque-chat-${calls.length}`;
      input.onThread(sessionId);
      return { text: `answer:${input.prompt}`, sessionId };
    },
    cancel() { return false; },
  };
  const messenger = options.messenger ?? {
    async reply(messageId, text) { replies.push({ messageId, text }); },
  };
  const stateFile = join(directory, 'data', 'state.json');
  const bot = new Bot({
    stateFile, runner, messenger, workspace: '/test/workspace',
    logger: { error(message) { logs.push(message); } },
    ...options,
  });
  t.after(async () => {
    await bot.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { bot, runner, messenger, replies, calls, logs, directory, stateFile };
}

async function bind(bot) {
  bot.handleEvent(event(`/pair ${bot.pairingCode}`));
  await bot.idle();
}

test('binding requires private chat and correct code; only the owner can execute', async t => {
  const { bot, calls, replies, stateFile } = fixture(t);
  const code = bot.pairingCode;
  assert.match(code, /^[a-f0-9]{12}$/);
  bot.handleEvent(event(`@_user_1 /pair ${code}`, {
    chatType: 'group', mentions: [{ key: '@_user_1' }],
  }));
  await bot.idle();
  assert.equal(bot.ownerOpenId, null);
  assert.match(replies.at(-1).text, /私聊/);
  assert.ok(!replies.at(-1).text.includes(code));
  bot.handleEvent(event('/pair abcdefabcdef', { sender: 'ou_stranger' }));
  await bot.idle();
  assert.equal(bot.ownerOpenId, null);
  await bind(bot);
  assert.equal(bot.ownerOpenId, 'ou_owner');
  assert.equal(bot.pairingCode, undefined);
  const previousCount = replies.length;
  bot.handleEvent(event('do something', { sender: 'ou_stranger' }));
  bot.handleEvent(event(`/pair ${code}`, { sender: 'ou_stranger' }));
  bot.handleEvent(event('do something', { senderType: 'app' }));
  await bot.idle();
  assert.equal(calls.length, 0);
  assert.equal(replies.length, previousCount);
  bot.handleEvent(event('owner task'));
  await bot.idle();
  assert.equal(calls[0].prompt, 'owner task');
  assert.ok(!readFileSync(stateFile, 'utf8').includes('owner task'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(stateFile, '..')).mode & 0o777, 0o700);
  }
});

test('event handler returns synchronously while a long task runs, and status stays responsive', async t => {
  const started = deferred();
  const task = deferred();
  let runCount = 0;
  const runner = {
    async run(input) {
      runCount++;
      input.onThread('codex-test-session');
      started.resolve();
      return task.promise;
    },
    cancel() { task.reject(new Error('cancelled')); return true; },
  };
  const { bot, replies, stateFile } = fixture(t, { runner, botName: 'DevBot' });
  await bind(bot);
  const taskEvent = event('long task');
  assert.equal(bot.handleEvent(taskEvent), undefined);
  assert.equal(runCount, 0);
  await started.promise;
  assert.equal(Object.values(JSON.parse(readFileSync(stateFile)).sessions)[0], 'codex-test-session');
  const statusEvent = event('/status');
  bot.handleEvent(statusEvent);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(replies.find(reply => reply.messageId === statusEvent.message.message_id).text, /DevBot/);
  assert.ok(!replies.find(reply => reply.messageId === statusEvent.message.message_id).text.includes('/test/workspace'));
  task.resolve({ text: 'complete', sessionId: 'codex-test-session' });
  await bot.idle();
  assert.equal(replies.at(-1).text, 'complete');
});

test('FIFO preserves continuation and isolates group and private chat sessions', async t => {
  const { bot, calls } = fixture(t);
  await bind(bot);
  bot.handleEvent(event('first'));
  bot.handleEvent(event('second'));
  bot.handleEvent(event('ignored unmentioned group', { chat: 'oc_group', chatType: 'group' }));
  bot.handleEvent({ event: event('@_user_1 group first', {
    chat: 'oc_group', chatType: 'group', mentions: [{ key: '@_user_1' }],
  }) });
  bot.handleEvent(event('third'));
  await bot.idle();
  assert.deepEqual(calls.map(call => call.prompt), ['first', 'second', 'group first', 'third']);
  assert.deepEqual(calls.map(call => call.sessionId), [undefined, 'opaque-chat-1', undefined, 'opaque-chat-1']);
});

test('deduplication and exact conversation survive process restart', async t => {
  const first = fixture(t);
  await bind(first.bot);
  const original = event('only once', { id: 'om_replayed' });
  first.bot.handleEvent(original);
  first.bot.handleEvent(original);
  await first.bot.idle();
  assert.equal(first.calls.length, 1);
  await first.bot.close();
  const calls = [];
  const second = new Bot({
    stateFile: first.stateFile,
    runner: {
      async run(input) { calls.push(input); return { text: 'continued', sessionId: input.sessionId }; },
      cancel() { return false; },
    },
    messenger: { async reply() {} },
  });
  t.after(() => second.close());
  second.handleEvent(original);
  second.handleEvent(event('continue'));
  await second.idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'opaque-chat-1');
});

test('/new is ordered between tasks and creates a fresh exact session', async t => {
  const { bot, calls, replies } = fixture(t, { botName: 'NoteBot' });
  await bind(bot);
  bot.handleEvent(event('first'));
  bot.handleEvent(event('/new'));
  bot.handleEvent(event('after reset'));
  await bot.idle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionId, undefined);
  assert.ok(replies.some(reply => /新的 NoteBot 会话/.test(reply.text)));
});

test('/stop cancels the local worker and clears only this chat queue', async t => {
  const active = deferred();
  const started = deferred();
  const calls = [];
  let cancelled = 0;
  const runner = {
    async run(input) {
      calls.push(input);
      input.onThread(input.sessionId ?? `chat-${calls.length}`);
      if (calls.length === 1) { started.resolve(); return active.promise; }
      return { text: 'other done', sessionId: `chat-${calls.length}` };
    },
    cancel() { cancelled++; active.reject(new Error('stopped')); return true; },
  };
  const { bot, replies } = fixture(t, { runner, botName: 'DevBot' });
  await bind(bot);
  bot.handleEvent(event('active'));
  await started.promise;
  bot.handleEvent(event('remove queued'));
  bot.handleEvent(event('other chat', { chat: 'oc_other' }));
  const stop = event('/stop');
  bot.handleEvent(stop);
  await bot.idle();
  assert.equal(cancelled, 1);
  assert.deepEqual(calls.map(call => call.prompt), ['active', 'other chat']);
  assert.match(replies.find(reply => reply.messageId === stop.message.message_id).text, /已停止当前会话的本机 Codex 进程/);
  assert.ok(!replies.some(reply => /执行失败/.test(reply.text)));
});

test('queue is bounded, text-only inputs are enforced, and failed replies do not block execution', async t => {
  const started = deferred();
  const active = deferred();
  let calls = 0;
  const messages = [];
  const { bot, logs } = fixture(t, {
    maxQueue: 1,
    runner: {
      async run(input) { calls++; input.onThread('opaque'); started.resolve(); return active.promise; },
      cancel() { active.reject(new Error('cancelled')); return true; },
    },
    messenger: { async reply(id, text) { messages.push({ id, text }); if (text.startsWith('已收到')) throw new Error('SECRET raw failure'); } },
  });
  await bind(bot);
  bot.handleEvent(event('run'));
  await started.promise;
  bot.handleEvent(event('overflow'));
  bot.handleEvent(event('', { type: 'image' }));
  bot.handleEvent(event('x'.repeat(12001)));
  active.resolve({ text: 'done', sessionId: 'opaque' });
  await bot.idle();
  assert.equal(calls, 1);
  assert.ok(messages.some(message => /队列已满/.test(message.text)));
  assert.ok(messages.some(message => /文字消息/.test(message.text)));
  assert.ok(messages.some(message => /消息过长/.test(message.text)));
  assert.equal(messages.at(-1).text, 'done');
  assert.ok(logs.length > 0);
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
});

test('corrupt state fails closed without overwriting the file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-bot-corrupt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'state.json');
  writeFileSync(stateFile, '{broken');
  assert.throws(() => new Bot({ stateFile, runner: { run() {}, cancel() {} }, messenger: { reply() {} } }), /损坏/);
  assert.equal(readFileSync(stateFile, 'utf8'), '{broken');
});

test('state failure before execution blocks local work and hides raw filesystem errors', async t => {
  const { bot, calls, replies, stateFile } = fixture(t);
  await bind(bot);
  // Replacing the target file with a directory deterministically makes atomic rename fail.
  rmSync(stateFile);
  mkdirSync(stateFile);
  bot.handleEvent(event('must not execute'));
  await bot.idle();
  assert.equal(calls.length, 0);
  assert.match(replies.at(-1).text, /状态保存失败/);
  assert.ok(!replies.at(-1).text.includes('EISDIR'));
});

test('failed backend turns preserve the existing thread and are never retried automatically', async t => {
  const calls = [];
  const { bot } = fixture(t, {
    runner: {
      async run(input) {
        calls.push(input);
        if (calls.length === 1) { input.onThread('existing-codex-thread'); return { text: 'first', sessionId: 'existing-codex-thread' }; }
        if (calls.length === 2) throw new Error('HTTP 409 raw secret');
        return { text: 'third', sessionId: input.sessionId };
      },
      cancel() { return false; },
    },
  });
  await bind(bot);
  bot.handleEvent(event('first'));
  bot.handleEvent(event('second fails'));
  bot.handleEvent(event('third explicit'));
  await bot.idle();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].sessionId, 'existing-codex-thread');
  assert.equal(calls[2].sessionId, 'existing-codex-thread');
});

test('onThread persistence failure cancels waiting and discards the remaining queue', async t => {
  let calls = 0;
  let cancellations = 0;
  let stateFile;
  const { bot, replies, stateFile: state } = fixture(t, {
    runner: {
      async run(input) {
        calls++;
        rmSync(stateFile);
        mkdirSync(stateFile);
        input.onThread('must-persist-before-continuing');
        return { text: 'must not deliver after persistence failed', sessionId: 'must-persist-before-continuing' };
      },
      cancel() { cancellations++; return true; },
    },
  });
  stateFile = state;
  await bind(bot);
  bot.handleEvent(event('first'));
  bot.handleEvent(event('must never start'));
  await bot.idle();
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
  assert.ok(replies.some(reply => /状态保存失败/.test(reply.text)));
  assert.ok(!replies.some(reply => reply.text.includes('must not deliver')));
});

test('configured persona is included on each turn while preserving the exact local session', async t => {
  const { bot, calls, replies } = fixture(t, { botName: 'DevBot', persona: '你是擅长 Java 的开发助手。' });
  await bind(bot);
  bot.handleEvent(event('first'));
  bot.handleEvent(event('second'));
  await bot.idle();
  assert.equal(calls[0].prompt, '机器人角色配置：\n你是擅长 Java 的开发助手。\n\n飞书用户消息：\nfirst');
  assert.equal(calls[1].prompt, '机器人角色配置：\n你是擅长 Java 的开发助手。\n\n飞书用户消息：\nsecond');
  assert.equal(calls[1].sessionId, 'opaque-chat-1');
  assert.ok(replies.some(reply => reply.text.includes('DevBot')));
});

const teamGroup = { chat: 'oc_team_group', chatType: 'group', mentions: [{ key: '@_user_1' }] };
function teamEvent(task, overrides = {}) {
  return event(`@_user_1 /协作 ${task}`, { ...teamGroup, ...overrides });
}

test('team jobs require the paired owner and configured mentioned group, and preserve ordinary sessions', async t => {
  const tasks = [];
  const info = [];
  const { bot, calls, replies, stateFile } = fixture(t, {
    botName: 'Leader',
    logger: { info(message) { info.push(message); } },
    teamChatId: teamGroup.chat,
    teamWorkerLabel: 'Worker',
    teamRunner: {
      async run({ prompt, onStage }) {
        tasks.push(prompt);
        await onStage('plan');
        await onStage('execute');
        await onStage('review');
        return { text: '团队结果' };
      },
      cancel() { return false; },
    },
  });
  bot.handleEvent(teamEvent('未配对'));
  await bot.idle();
  await bind(bot);
  bot.handleEvent(event('@_user_1 普通问题', teamGroup));
  bot.handleEvent(teamEvent('其他用户', { sender: 'ou_other' }));
  bot.handleEvent(teamEvent('机器人发来的消息', { senderType: 'app' }));
  bot.handleEvent(teamEvent('其他群', { chat: 'oc_other_group' }));
  bot.handleEvent(teamEvent('未 @', { mentions: [] }));
  bot.handleEvent(event('/协作 私聊任务'));
  bot.handleEvent(teamEvent(''));
  const accepted = teamEvent('写使用说明\n写清楚步骤');
  assert.equal(bot.handleEvent(accepted), undefined);
  assert.deepEqual(tasks, []);
  bot.handleEvent(accepted);
  bot.handleEvent(event('@_user_1 普通续问', teamGroup));
  await bot.idle();

  assert.deepEqual(tasks, ['写使用说明\n写清楚步骤']);
  assert.deepEqual(calls.map(call => [call.prompt, call.sessionId]), [
    ['普通问题', undefined],
    ['普通续问', 'opaque-chat-1'],
  ]);
  assert.deepEqual(Object.values(JSON.parse(readFileSync(stateFile)).sessions), ['opaque-chat-1']);
  assert.ok(replies.some(reply => reply.text.includes('请在 /协作 后写任务')));
  const acceptedReplies = replies.filter(reply => reply.messageId === accepted.message.message_id);
  assert.deepEqual(acceptedReplies.map(reply => reply.text), [
    '已收到协作任务。Leader 正在规划，随后由 Worker 执行。',
    '规划已完成，Worker 正在执行。',
    '执行已完成，Leader 正在审查结果。',
    '协作汇报\n团队结果',
  ]);
  assert.deepEqual(info, ['协作开始：规划/执行/审查。', '协作完成，结果已回复飞书。']);
});

test('a bot without team routing never interprets /协作 as a regular Codex prompt', async t => {
  const { bot, replies, calls } = fixture(t);
  await bind(bot);
  bot.handleEvent(teamEvent('不能走普通执行'));
  await bot.idle();
  assert.equal(calls.length, 0);
  assert.match(replies.at(-1).text, /@ 负责人/);
});

test('/stop cancels the team runner, discards the rest of this chat, and suppresses late replies', async t => {
  const started = deferred();
  const teamResult = deferred();
  const tasks = [];
  let teamCancelled = 0;
  const { bot, calls, replies } = fixture(t, {
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run({ prompt, onStage }) {
        tasks.push(prompt);
        started.resolve();
        const result = await teamResult.promise;
        await onStage('review');
        return result;
      },
      cancel() {
        teamCancelled++;
        teamResult.resolve({ text: '晚到结果' });
        return true;
      },
    },
  });
  await bind(bot);
  bot.handleEvent(teamEvent('正在执行'));
  await started.promise;
  bot.handleEvent(teamEvent('排队任务'));
  bot.handleEvent(event('保留私聊'));
  bot.handleEvent(event('@_user_1 /stop', teamGroup));
  await bot.idle();

  assert.equal(teamCancelled, 1);
  assert.deepEqual(tasks, ['正在执行']);
  assert.deepEqual(calls.map(call => call.prompt), ['保留私聊']);
  assert.ok(!replies.some(reply => /晚到结果|审查结果/.test(reply.text)));
  assert.ok(replies.some(reply => /取消 1 条等待任务/.test(reply.text)));
});

for (const trigger of ['close', 'state failure']) {
  test(`${trigger} cancels active team work and prevents late replies`, async t => {
    const started = deferred();
    const teamResult = deferred();
    let teamCancelled = 0;
    const { bot, replies, stateFile } = fixture(t, {
      teamChatId: teamGroup.chat,
      teamRunner: {
        async run() {
          started.resolve();
          return teamResult.promise;
        },
        cancel() {
          teamCancelled++;
          teamResult.resolve({ text: '晚到结果' });
          return true;
        },
      },
    });
    await bind(bot);
    bot.handleEvent(teamEvent('正在执行'));
    await started.promise;
    if (trigger === 'close') {
      await bot.close();
    } else {
      rmSync(stateFile);
      mkdirSync(stateFile);
      bot.handleEvent(teamEvent('不能写入去重文件'));
      await bot.idle();
      assert.ok(replies.some(reply => /状态保存失败/.test(reply.text)));
    }
    assert.equal(teamCancelled, 1);
    assert.ok(!replies.some(reply => /晚到结果/.test(reply.text)));
  });
}

test('team failure reports a safe stage and does not forward raw errors', async t => {
  const { bot, replies, logs } = fixture(t, {
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run() {
        throw Object.assign(new Error('SECRET raw failure'), { code: 'TEAM_EXECUTE_FAILED' });
      },
      cancel() { return false; },
    },
  });
  await bind(bot);
  bot.handleEvent(teamEvent('任务失败'));
  await bot.idle();
  assert.match(replies.at(-1).text, /协作未完成：执行者未完成任务/);
  assert.ok(!replies.some(reply => reply.text.includes('SECRET')));
  assert.ok(!logs.some(message => message.includes('SECRET')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Bot } from '../src/bot.mjs';

let messageCounter = 0;
const fixtureMention = { key: '@_user_1', id: { open_id: 'ou_fixture' } };

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

function imageEvent(imageKey, options) {
  return event('', { ...options, type: 'image', content: JSON.stringify({ image_key: imageKey }) });
}

function postEvent(post, options) {
  return event('', { ...options, type: 'post', content: JSON.stringify(post) });
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
    stateFile, runner, messenger, botOpenId: 'ou_fixture', workspace: '/test/workspace',
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
    chatType: 'group', mentions: [fixtureMention],
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
    chat: 'oc_group', chatType: 'group', mentions: [fixtureMention],
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

test('a collaboration reservation blocks direct execution and leaves unrelated stop commands responsive', async t => {
  const { bot, runner, calls, replies } = fixture(t, { botName: 'Worker' });
  await bind(bot);
  let cancelled = 0;
  runner.cancel = () => { cancelled++; };
  const release = bot.reserveForTeam();
  assert.equal(typeof release, 'function');
  try {
    assert.equal(bot.reserveForTeam(), undefined);
    const abort = new AbortController();
    const waiting = bot.idle(abort.signal);
    assert.equal(bot.idleWaiters.size, 1);
    abort.abort();
    await waiting;
    assert.equal(bot.idleWaiters.size, 0);

    bot.handleEvent(event('cancel queued'));
    bot.handleEvent(event('keep queued', { chat: 'oc_other' }));
    bot.handleEvent(event('/status'));
    bot.handleEvent(event('/stop'));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, []);
    assert.equal(cancelled, 0);
    assert.ok(replies.some(reply => /正在执行协作任务/.test(reply.text)));
    assert.equal(replies.at(-1).text, '已取消 1 条等待任务。');
  } finally {
    release();
    release();
  }
  const queuedReservation = bot.reserveForTeam();
  queuedReservation?.();
  assert.equal(queuedReservation, undefined);
  await bot.idle();
  assert.deepEqual(calls.map(call => call.prompt), ['keep queued']);
  await bot.close();
  assert.equal(bot.canAcceptTeamWork, false);
  assert.equal(bot.reserveForTeam(), undefined);
});

test('queue is bounded, invalid messages are rejected, and failed replies do not block execution', async t => {
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

test('private images reach a new Codex turn and the same conversation can receive a fresh image', async t => {
  const downloads = [];
  const { bot, messenger, stateFile, replies } = fixture(t, {
    runner: {
      async run({ prompt, sessionId, images, onThread }) {
        assert.equal(images.length, 1);
        const text = readFileSync(images[0], 'utf8');
        turns.push({ prompt, sessionId, text });
        onThread('image-thread');
        return { text, sessionId: 'image-thread' };
      },
      cancel() { return false; },
    },
  });
  const turns = [];
  messenger.downloadImage = async (messageId, key, directory) => {
    downloads.push({ messageId, key, directory });
    if (process.platform !== 'win32') assert.equal(statSync(directory).mode & 0o777, 0o700);
    const path = join(directory, 'attachment.png');
    writeFileSync(path, key === 'img_first' ? 'A6K4Q' : 'T9M2V');
    return path;
  };
  await bind(bot);
  const first = imageEvent('img_first');
  assert.equal(bot.handleEvent(first), undefined);
  assert.equal(downloads.length, 0);
  await bot.idle();
  assert.equal(replies.at(-1).text, 'A6K4Q');
  const second = postEvent({ zh_cn: {
    title: '下一张',
    content: [[{ tag: 'img', image_key: 'img_second' }]],
    content_v2: [[{ tag: 'md', text: '这张图里的短码是什么？' }], [{ tag: 'img', image_key: 'img_second' }]],
  } });
  bot.handleEvent(second);
  await bot.idle();

  assert.deepEqual(turns, [
    { prompt: '请描述这条消息中的图片。', sessionId: undefined, text: 'A6K4Q' },
    { prompt: '下一张\n这张图里的短码是什么？', sessionId: 'image-thread', text: 'T9M2V' },
  ]);
  assert.equal(replies.at(-1).text, 'T9M2V');
  assert.deepEqual(downloads.map(({ messageId, key }) => [messageId, key]), [
    [first.message.message_id, 'img_first'], [second.message.message_id, 'img_second'],
  ]);
  assert.notEqual(downloads[0].directory, downloads[1].directory);
  const state = readFileSync(stateFile, 'utf8');
  for (const { directory, key } of downloads) {
    assert.equal(existsSync(directory), false);
    assert.ok(!state.includes(directory) && !state.includes(key));
  }
});

test('an image download failure prevents execution and cleans already downloaded attachments', async t => {
  const { bot, calls, messenger, replies } = fixture(t);
  let partial;
  messenger.downloadImage = async (_messageId, key, directory) => {
    if (key === 'img_denied') {
      throw Object.assign(new Error('飞书没有授予读取图片的权限。'), { code: 'FEISHU_IMAGE_DOWNLOAD' });
    }
    partial = join(directory, 'partial.png');
    writeFileSync(partial, 'first image');
    return partial;
  };
  await bind(bot);
  bot.handleEvent(postEvent({ content: [
    [{ tag: 'text', text: '比较两张图' }],
    [{ tag: 'img', image_key: 'img_ok' }],
    [{ tag: 'img', image_key: 'img_denied' }],
  ] }));
  await bot.idle();
  assert.deepEqual(calls, []);
  assert.match(replies.at(-1).text, /读取图片的权限/);
  assert.equal(existsSync(dirname(partial)), false);
});

test('/stop aborts an active image download and discards queued images before downloading them', async t => {
  const started = deferred();
  const { bot, calls, messenger, replies } = fixture(t);
  const downloads = [];
  let temporary;
  messenger.downloadImage = async (_messageId, key, directory, { signal }) => {
    downloads.push(key);
    temporary = directory;
    writeFileSync(join(directory, 'partial.png'), 'partial image');
    started.resolve();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  await bind(bot);
  bot.handleEvent(imageEvent('img_active'));
  await started.promise;
  bot.handleEvent(imageEvent('img_queued'));
  bot.handleEvent(event('/stop'));
  await bot.idle();
  assert.deepEqual(downloads, ['img_active']);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(temporary), false);
  assert.match(replies.at(-1).text, /已停止当前会话的图片下载。已取消 1 条等待任务。/);
  assert.ok(!replies.some(reply => /无法处理图片/.test(reply.text)));
});

test('staged images stay available until a cancelled Codex turn settles', async t => {
  const started = deferred();
  const stopped = deferred();
  const result = deferred();
  const { bot, messenger, replies } = fixture(t, {
    runner: {
      async run({ images }) { started.resolve(images[0]); return result.promise; },
      cancel() { stopped.resolve(); return true; },
    },
  });
  messenger.downloadImage = async (_messageId, _key, directory) => {
    const path = join(directory, 'attachment.png');
    writeFileSync(path, 'image data');
    return path;
  };
  await bind(bot);
  bot.handleEvent(imageEvent('img_running'));
  const path = await started.promise;
  bot.handleEvent(event('/stop'));
  await stopped.promise;
  assert.equal(existsSync(path), true);
  result.resolve({ text: '晚到结果' });
  await bot.idle();
  assert.equal(existsSync(dirname(path)), false);
  assert.ok(!replies.some(reply => /晚到结果/.test(reply.text)));
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

const teamGroup = { chat: 'oc_team_group', chatType: 'group', mentions: [fixtureMention] };
function teamEvent(task, overrides = {}) {
  return event(`@_user_1 /协作 ${task}`, { ...teamGroup, ...overrides });
}

test('only a bound, mentioned, unique group post downloads and routes its original images to teamwork', async t => {
  const taskCalls = [];
  const downloads = [];
  const { bot, calls, messenger } = fixture(t, {
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run({ prompt, images }) {
        taskCalls.push({ prompt, images, contents: images.map(path => readFileSync(path, 'utf8')) });
        return { text: '团队结果' };
      },
      cancel() { return false; },
    },
  });
  messenger.downloadImage = async (messageId, key, directory) => {
    downloads.push({ messageId, key, directory });
    const path = join(directory, `${key}.png`);
    writeFileSync(path, key);
    return path;
  };
  const post = { title: '', content: [
    [{ tag: 'at', user_id: '@_user_1', user_name: 'Leader' }, { tag: 'text', text: ' 比较这两张截图。' }],
    [{ tag: 'img', image_key: 'img_left' }],
    [{ tag: 'img', image_key: 'img_right' }],
  ] };
  bot.handleEvent(postEvent(post, teamGroup));
  await bot.idle();
  assert.deepEqual(downloads, []);
  await bind(bot);
  bot.handleEvent(postEvent(post, { ...teamGroup, sender: 'ou_other' }));
  bot.handleEvent(postEvent(post, { ...teamGroup, mentions: [] }));
  const accepted = postEvent(post, teamGroup);
  bot.handleEvent(accepted);
  bot.handleEvent(accepted);
  await bot.idle();

  assert.deepEqual(calls, []);
  assert.equal(taskCalls.length, 1);
  assert.equal(taskCalls[0].prompt, '比较这两张截图。');
  assert.deepEqual(taskCalls[0].contents, ['img_left', 'img_right']);
  assert.deepEqual(downloads.map(({ messageId, key }) => [messageId, key]), [
    [accepted.message.message_id, 'img_left'], [accepted.message.message_id, 'img_right'],
  ]);
  assert.equal(downloads[0].directory, downloads[1].directory);
  assert.equal(existsSync(downloads[0].directory), false);
});

test('team conversation saves its leader session and reuses it for the next request until reset', async t => {
  const seen = [];
  const { bot, stateFile } = fixture(t, {
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run({ prompt, sessionId, onThread }) {
        seen.push({ prompt, sessionId });
        onThread('team-session-1');
        return { text: '完成' };
      },
      cancel() { return false; },
    },
  });
  await bind(bot);
  bot.handleEvent(teamEvent('修改 README'));
  await bot.idle();
  assert.ok(Object.values(JSON.parse(readFileSync(stateFile)).sessions).includes('team-session-1'));
  bot.handleEvent(teamEvent('发布上次修改'));
  await bot.idle();
  assert.deepEqual(seen, [
    { prompt: '修改 README', sessionId: undefined },
    { prompt: '发布上次修改', sessionId: 'team-session-1' },
  ]);
  bot.handleEvent(event('@_user_1 /new', teamGroup));
  await bot.idle();
  bot.handleEvent(teamEvent('新任务'));
  await bot.idle();
  assert.equal(seen[2].sessionId, undefined);
});

test('ordinary mentions default to teamwork only for the paired owner in the configured group', async t => {
  const tasks = [];
  const info = [];
  const { bot, calls, replies, stateFile } = fixture(t, {
    botName: 'Leader',
    logger: { info(message) { info.push(message); } },
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run({ prompt, onStage }) {
        tasks.push(prompt);
        const index = tasks.length;
        await onStage('plan');
        if (index === 1) await onStage('waiting');
        await onStage('execute', index === 1 ? 'Worker 2' : 'Worker 1');
        await onStage('review');
        return { text: '团队结果' };
      },
      cancel() { return false; },
    },
  });
  bot.handleEvent(event('@_user_1 未配对', teamGroup));
  await bot.idle();
  await bind(bot);
  bot.handleEvent(event('私聊问题'));
  bot.handleEvent(event('@_user_1 其他群的问题', { ...teamGroup, chat: 'oc_other_group' }));
  bot.handleEvent(event('@_user_1 其他用户的问题', { ...teamGroup, sender: 'ou_other' }));
  bot.handleEvent(event('没有提及的群消息', { ...teamGroup, mentions: [] }));
  bot.handleEvent(teamEvent('其他用户', { sender: 'ou_other' }));
  bot.handleEvent(teamEvent('机器人发来的消息', { senderType: 'app' }));
  bot.handleEvent(teamEvent('其他群', { chat: 'oc_other_group' }));
  bot.handleEvent(teamEvent('未 @', { mentions: [] }));
  bot.handleEvent(event('/协作 私聊任务'));
  bot.handleEvent(teamEvent(''));
  const accepted = event('@_user_1 写使用说明\n写清楚步骤', teamGroup);
  assert.equal(bot.handleEvent(accepted), undefined);
  assert.deepEqual(tasks, []);
  bot.handleEvent(accepted);
  bot.handleEvent(teamEvent('显式协作任务'));
  bot.handleEvent(event('私聊续问'));
  await bot.idle();

  assert.deepEqual(tasks, ['写使用说明\n写清楚步骤', '显式协作任务']);
  assert.deepEqual(calls.map(call => [call.prompt, call.sessionId]), [
    ['私聊问题', undefined],
    ['其他群的问题', undefined],
    ['私聊续问', 'opaque-chat-1'],
  ]);
  assert.deepEqual(Object.values(JSON.parse(readFileSync(stateFile)).sessions), ['opaque-chat-1', 'opaque-chat-2']);
  assert.ok(replies.some(reply => reply.text.includes('请在 /协作 后写任务')));
  const acceptedReplies = replies.filter(reply => reply.messageId === accepted.message.message_id);
  assert.deepEqual(acceptedReplies.map(reply => reply.text), [
    '已收到，Leader 正在处理。',
    '规划已完成，执行机器人都在忙，正在等待空闲。',
    '规划已完成，Worker 2 正在执行。',
    '执行已完成，Leader 正在审查结果。',
    '协作汇报\n团队结果',
  ]);
  const completed = ['协作开始：规划/执行/审查。', '协作完成，结果已回复飞书。'];
  assert.deepEqual(info.filter(line => line === completed[0]), [completed[0], completed[0]]);
  assert.deepEqual(info.filter(line => line === completed[1]), [completed[1], completed[1]]);
});

test('the leader keeps control commands out of the default team workflow', async t => {
  const tasks = [];
  const { bot, calls, replies } = fixture(t, {
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run({ prompt }) { tasks.push(prompt); return { text: '团队结果' }; },
      cancel() { return false; },
    },
  });
  await bind(bot);

  for (const [command, expected] of [
    ['/help', /查看帮助/],
    ['/status', /当前会话/],
    ['/stop', /没有正在执行或等待的任务/],
    ['/new', /已开始新对话/],
  ]) {
    const message = event(`@_user_1 ${command}`, teamGroup);
    bot.handleEvent(message);
    await bot.idle();
    assert.match(replies.find(reply => reply.messageId === message.message.message_id).text, expected);
  }
  assert.deepEqual(tasks, []);
  assert.deepEqual(calls, []);
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

test('a busy team task does not block a follow-up and a second task', async t => {
  const started = deferred();
  const finish = deferred();
  const seen = [];
  const { bot, replies } = fixture(t, {
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run({ prompt }) {
        seen.push(prompt);
        if (prompt === '第一个任务') { started.resolve(); await finish.promise; }
        return { text: `完成：${prompt}` };
      },
      cancel() { finish.resolve(); return true; },
    },
  });
  await bind(bot);
  bot.handleEvent(event('@_user_1 第一个任务', teamGroup));
  await started.promise;
  bot.handleEvent(event('@_user_1 找到问题了吗', teamGroup));
  bot.handleEvent(event('@_user_1 第二个任务', teamGroup));
  for (let i = 0; i < 20 && seen.length < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['第一个任务', '找到问题了吗', '第二个任务']);
  assert.ok(replies.some(reply => reply.text.includes('找到问题了吗')));
  finish.resolve();
  await bot.idle();
});

test('a new session is refused when collaboration is queued or running', async t => {
  const finish = deferred();
  const { bot, replies } = fixture(t, {
    teamChatId: teamGroup.chat,
    teamRunner: { async run() { await finish.promise; return { text: '完成' }; }, cancel() { finish.resolve(); } },
  });
  await bind(bot);
  bot.handleEvent(event('@_user_1 开始任务', teamGroup));
  const reset = event('@_user_1 /new', teamGroup);
  bot.handleEvent(reset);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(replies.find(reply => reply.messageId === reset.message.message_id).text, /仍有协作任务/);
  finish.resolve();
  await bot.idle();
});

const plainTeamGroup = { chat: teamGroup.chat, chatType: 'group' };

test('a failed startup Open ID lookup retries and resumes exact mention routing', async t => {
  const initial = deferred();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const warnings = [];
  const { bot, calls, messenger, replies, stateFile } = fixture(t, {
    botOpenId: null,
    logger: { warn(message) { warnings.push(message); } },
  });
  const getBotOpenId = t.mock.fn(() => initial.promise);
  messenger.getBotOpenId = getBotOpenId;
  const startup = bot.refreshBotOpenId();
  await bot.refreshBotOpenId();
  assert.equal(getBotOpenId.mock.callCount(), 1);
  initial.reject(new Error('network unavailable'));
  await startup;
  assert.equal(warnings.length, 1);

  await bind(bot);
  const self = event('@_user_1 给机器人', { ...plainTeamGroup, mentions: [fixtureMention] });
  const other = event('@_user_1 给其他人', {
    ...plainTeamGroup, mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' } }],
  });
  bot.handleEvent(self);
  bot.handleEvent(other);
  bot.handleEvent(event('私聊正常'));
  await bot.idle();
  assert.deepEqual(calls.map(call => call.prompt), ['私聊正常']);
  assert.ok(!JSON.parse(readFileSync(stateFile, 'utf8')).processed.includes(self.message.message_id));

  getBotOpenId.mock.mockImplementation(async () => fixtureMention.id.open_id);
  await bot.refreshBotOpenId();
  assert.equal(getBotOpenId.mock.callCount(), 1);
  now += 5000;
  await bot.refreshBotOpenId();
  await bot.refreshBotOpenId();
  assert.equal(getBotOpenId.mock.callCount(), 2);

  bot.handleEvent(other);
  bot.handleEvent(self);
  bot.handleEvent(self);
  await bot.idle();
  assert.deepEqual(calls.map(call => call.prompt), ['私聊正常', '给机器人']);
  assert.ok(!replies.some(reply => reply.messageId === other.message.message_id));
  assert.ok(!JSON.parse(readFileSync(stateFile, 'utf8')).processed.includes(other.message.message_id));
});

test('no-mention teamwork routes a first message and follow-up only to the leader, once per message', async t => {
  const tasks = [];
  const leader = fixture(t, {
    botName: 'Leader',
    botOpenId: 'ou_leader',
    teamChatId: teamGroup.chat,
    teamNoMention: true,
    teamRunner: {
      async run({ prompt, sessionId, onThread }) {
        tasks.push({ prompt, sessionId });
        onThread('leader-session');
        return { text: '团队结果' };
      },
      cancel() { return false; },
    },
  });
  const worker = fixture(t, { botName: 'Worker', botOpenId: 'ou_worker' });
  leader.bot.handleEvent(event('绑定前的群消息', plainTeamGroup));
  await leader.bot.idle();
  assert.deepEqual(leader.replies, []);
  await bind(leader.bot);
  await bind(worker.bot);

  const first = event('写使用说明', plainTeamGroup);
  delete first.message.mentions;
  leader.bot.handleEvent({ header: { event_id: 'evt_first' }, event: first });
  leader.bot.handleEvent({ header: { event_id: 'evt_retry' }, event: first });
  worker.bot.handleEvent(first);
  await leader.bot.idle();

  const followUp = event('补上安装步骤', plainTeamGroup);
  followUp.message.root_id = first.message.message_id;
  leader.bot.handleEvent(followUp);
  worker.bot.handleEvent(followUp);
  await Promise.all([leader.bot.idle(), worker.bot.idle()]);

  assert.deepEqual(tasks, [
    { prompt: '写使用说明', sessionId: undefined },
    { prompt: '补上安装步骤', sessionId: 'leader-session' },
  ]);
  assert.deepEqual(leader.calls, []);
  assert.deepEqual(worker.calls, []);
  assert.equal(worker.replies.length, 1);
  for (const message of [first, followUp]) {
    assert.deepEqual(leader.replies.filter(reply => reply.messageId === message.message.message_id).map(reply => reply.text), [
      '已收到，Leader 正在处理。', '协作汇报\n团队结果',
    ]);
  }
});

test('no-mention teamwork filters other senders, open IDs and groups while keeping explicit routing', async t => {
  const tasks = [];
  const leader = fixture(t, {
    botName: 'Leader',
    botOpenId: 'ou_leader',
    teamChatId: teamGroup.chat,
    teamNoMention: true,
    teamRunner: {
      async run({ prompt }) { tasks.push(prompt); return { text: '团队结果' }; },
      cancel() { return false; },
    },
  });
  const worker = fixture(t, { botOpenId: 'ou_worker' });
  await bind(leader.bot);
  await bind(worker.bot);

  const otherGroup = { ...plainTeamGroup, chat: 'oc_other_group' };
  const mentionLeader = [{ key: '@_user_1', id: { open_id: 'ou_leader' } }];
  const mentionOther = [{ key: '@_user_1', name: 'Leader', id: { open_id: 'ou_other' } }];
  const directedToWorker = event('@_user_1 执行者单独处理', {
    ...plainTeamGroup, mentions: [{ key: '@_user_1', id: { open_id: 'ou_worker' } }],
  });
  const ignored = [
    event('其他成员', { ...plainTeamGroup, sender: 'ou_other' }),
    event('其他机器人', { ...plainTeamGroup, senderType: 'app' }),
    event('其他群普通消息', otherGroup),
    event('@_user_1 同名成员', { ...plainTeamGroup, mentions: mentionOther }),
    event('@_user_1 其他群里的其他成员', { ...otherGroup, mentions: mentionOther }),
    event('@_all 全体成员', { ...plainTeamGroup, mentions: [{ key: '@_all', id: { open_id: 'all' } }] }),
    directedToWorker,
  ];
  for (const message of ignored) {
    leader.bot.handleEvent(message);
    worker.bot.handleEvent(message);
  }
  leader.bot.handleEvent(event('负责人私聊'));
  leader.bot.handleEvent(event('@_user_1 其他群单独处理', { ...otherGroup, mentions: mentionLeader }));
  leader.bot.handleEvent(event('@_user_1 协作继续', { ...plainTeamGroup, mentions: mentionLeader }));
  await Promise.all([leader.bot.idle(), worker.bot.idle()]);

  assert.deepEqual(tasks, ['协作继续']);
  assert.deepEqual(leader.calls.map(call => call.prompt), ['负责人私聊', '其他群单独处理']);
  assert.deepEqual(worker.calls.map(call => call.prompt), ['执行者单独处理']);
  const processed = JSON.parse(readFileSync(leader.stateFile, 'utf8')).processed;
  for (const { message } of ignored) {
    assert.ok(!processed.includes(message.message_id));
    assert.ok(!leader.replies.some(reply => reply.messageId === message.message_id));
  }
});

test('turning off no-mention teamwork restores mention-only routing for the same bound leader', async t => {
  const tasks = [];
  const options = {
    botOpenId: 'ou_leader',
    teamChatId: teamGroup.chat,
    teamRunner: {
      async run({ prompt }) { tasks.push(prompt); return { text: '团队结果' }; },
      cancel() { return false; },
    },
  };
  const first = fixture(t, { ...options, teamNoMention: true });
  await bind(first.bot);
  first.bot.handleEvent(event('开启时普通发言', plainTeamGroup));
  await first.bot.idle();
  await first.bot.close();

  const restarted = new Bot({
    ...options, teamNoMention: false, stateFile: first.stateFile, runner: first.runner, messenger: first.messenger,
    logger: {},
  });
  t.after(() => restarted.close());
  const ignored = [
    event('关闭后普通发言', plainTeamGroup),
    event('@_user_1 关闭后提及其他人', { ...plainTeamGroup, mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' } }] }),
  ];
  for (const message of ignored) restarted.handleEvent(message);
  restarted.handleEvent(event('@_user_1 关闭后直接提及负责人', {
    ...plainTeamGroup, mentions: [{ key: '@_user_1', id: { open_id: 'ou_leader' } }],
  }));
  await restarted.idle();

  assert.deepEqual(tasks, ['开启时普通发言', '关闭后直接提及负责人']);
  for (const { message } of ignored) assert.ok(!first.replies.some(reply => reply.messageId === message.message_id));
});

test('no-mention teamwork downloads images from standalone and rich-text messages', async t => {
  const tasks = [];
  const downloads = [];
  const { bot, calls, messenger } = fixture(t, {
    botOpenId: 'ou_leader',
    teamChatId: teamGroup.chat,
    teamNoMention: true,
    teamRunner: {
      async run({ prompt, images }) {
        tasks.push({ prompt, contents: images.map(path => readFileSync(path, 'utf8')) });
        return { text: '团队结果' };
      },
      cancel() { return false; },
    },
  });
  messenger.downloadImage = async (messageId, key, directory) => {
    downloads.push({ messageId, key, directory });
    const path = join(directory, `${key}.png`);
    writeFileSync(path, key);
    return path;
  };
  await bind(bot);
  const image = imageEvent('img_only', plainTeamGroup);
  bot.handleEvent(image);
  await bot.idle();
  const post = postEvent({ content: [[{ tag: 'text', text: '读取短码' }, { tag: 'img', image_key: 'img_code' }]] }, plainTeamGroup);
  bot.handleEvent(post);
  bot.handleEvent(post);
  await bot.idle();

  assert.deepEqual(calls, []);
  assert.deepEqual(tasks, [
    { prompt: '请描述这条消息中的图片。', contents: ['img_only'] },
    { prompt: '读取短码', contents: ['img_code'] },
  ]);
  assert.deepEqual(downloads.map(({ messageId, key }) => [messageId, key]), [
    [image.message.message_id, 'img_only'], [post.message.message_id, 'img_code'],
  ]);
  assert.ok(downloads.every(({ directory }) => !existsSync(directory)));
});

test('a no-mention /stop cancels active teamwork and clears queued work only for the bound owner', async t => {
  const teamResult = deferred();
  const tasks = [];
  const cancellations = [];
  const { bot, calls, replies } = fixture(t, {
    botOpenId: 'ou_leader',
    teamChatId: teamGroup.chat,
    teamNoMention: true,
    teamRunner: {
      async run({ prompt, onStage }) {
        tasks.push(prompt);
        const result = await teamResult.promise;
        await onStage('review');
        return result;
      },
      cancel(jobId) {
        cancellations.push(jobId);
        teamResult.resolve({ text: '晚到结果' });
        return true;
      },
    },
  });
  await bind(bot);
  const active = event('正在执行', plainTeamGroup);
  bot.handleEvent(active);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tasks, ['正在执行']);

  bot.handleEvent(event('/stop', { ...plainTeamGroup, sender: 'ou_other' }));
  bot.handleEvent(event('/stop', { ...plainTeamGroup, chat: 'oc_other_group' }));
  assert.deepEqual(cancellations, []);
  bot.handleEvent(event('排队任务', plainTeamGroup));
  bot.handleEvent(event('保留私聊'));
  const stop = event('/stop', plainTeamGroup);
  bot.handleEvent(stop);
  await bot.idle();

  assert.deepEqual(cancellations, [active.message.message_id]);
  assert.deepEqual(tasks, ['正在执行']);
  assert.deepEqual(calls.map(call => call.prompt), ['保留私聊']);
  assert.ok(!replies.some(reply => /晚到结果|审查结果/.test(reply.text)));
  assert.match(replies.find(reply => reply.messageId === stop.message.message_id).text, /已停止.*取消 1 条等待任务/);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { TeamRunner } from '../src/team-runner.mjs';

async function fixture(t, { leaderRun, workerRun, workerCancel } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'feishu-team-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const setup = role => ({ workspace }) => ({
    async run(args) {
      calls.push({ role, workspace, ...args });
      if (role === 'worker') {
        if (workerRun) return workerRun(args);
        return { text: 'Sol 输出：完成了用户任务。', sessionId: 'worker-session' };
      }
      if (leaderRun) return leaderRun(args);
      return args.sessionId
        ? { text: 'Astra 汇报：已核查。', sessionId: 'leader-session' }
        : { text: 'Astra 方案：先执行，再核验。', sessionId: 'leader-session' };
    },
    cancel() {
      return role === 'worker' && workerCancel ? workerCancel() : false;
    },
  });
  const runner = new TeamRunner({
    workspaceRoot: root,
    leaderName: 'Codex Astra',
    workerName: 'Codex Sol',
    makeLeader: setup('leader'),
    makeWorker: setup('worker'),
  });
  return { root, calls, runner };
}

test('plans, executes, and reviews in the same isolated directory using the leader planning session', async t => {
  const { root, calls, runner } = await fixture(t);
  const stages = [];
  const prompt = '准备一份使用说明。\n请附两个例子。';

  assert.deepEqual(await runner.run({ prompt, onStage: stage => stages.push(stage) }), {
    text: 'Astra 汇报：已核查。',
  });
  assert.deepEqual(stages, ['plan', 'execute', 'review']);
  assert.deepEqual(calls.map(call => [call.role, call.sessionId]), [
    ['leader', undefined],
    ['worker', undefined],
    ['leader', 'leader-session'],
  ]);
  assert.equal(dirname(calls[0].workspace), root);
  assert.ok(calls.every(call => call.workspace === calls[0].workspace));
  assert.ok((await stat(calls[0].workspace)).isDirectory());
  assert.ok(calls[0].prompt.includes('Codex Astra'));
  assert.ok(calls[1].prompt.includes('Codex Sol'));
  assert.ok(calls.every(call => call.prompt.includes(JSON.stringify(prompt))));
  assert.match(calls[1].prompt, /负责人的方案.*Astra 方案/);
  assert.match(calls[2].prompt, /执行者的交付报告.*Sol 输出/);

  await runner.run({ prompt: '新的协作任务' });
  assert.notEqual(calls[3].workspace, calls[0].workspace);
  assert.equal(calls[3].sessionId, undefined);
});

test('failed execution does not start review or expose its original error', async t => {
  const { calls, runner } = await fixture(t, {
    workerRun: async () => { throw new Error('raw subprocess diagnostic'); },
  });
  const stages = [];
  await assert.rejects(runner.run({ prompt: '测试任务', onStage: stage => stages.push(stage) }), error => {
    assert.equal(error.code, 'TEAM_EXECUTE_FAILED');
    assert.doesNotMatch(error.message, /raw subprocess diagnostic/);
    return true;
  });
  assert.deepEqual(stages, ['plan', 'execute']);
  assert.deepEqual(calls.map(call => call.role), ['leader', 'worker']);
});

test('missing planning session stops before delegating to the worker', async t => {
  const { runner, calls } = await fixture(t, {
    leaderRun: async () => ({ text: '没有提供结果所属会话。' }),
  });
  await assert.rejects(runner.run({ prompt: '测试任务' }), { code: 'TEAM_PLAN_FAILED' });
  assert.deepEqual(calls.map(call => call.role), ['leader']);
});

test('cancel stops the active worker, skips review and allows a subsequent task', async t => {
  let workerStarted;
  let releaseWorker;
  const started = new Promise(resolve => { workerStarted = resolve; });
  let first = true;
  let cancellations = 0;
  const { calls, runner } = await fixture(t, {
    workerRun: async () => {
      if (!first) return { text: '第二次任务的执行结果。' };
      first = false;
      workerStarted();
      return new Promise(resolve => { releaseWorker = resolve; });
    },
    workerCancel: () => {
      cancellations++;
      releaseWorker({ text: '停止时已有的中间结果。' });
      return true;
    },
  });

  const result = runner.run({ prompt: '测试任务' });
  await started;
  await assert.rejects(runner.run({ prompt: '同时启动的任务' }), { code: 'TEAM_BUSY' });
  assert.equal(runner.cancel(), true);
  assert.equal(runner.cancel(), false);
  await assert.rejects(result, { code: 'TEAM_CANCELLED' });
  assert.equal(cancellations, 1);
  assert.deepEqual(calls.map(call => call.role), ['leader', 'worker']);
  assert.match((await runner.run({ prompt: '可以开始下一项任务' })).text, /Astra/);
});

test('cancel while awaiting a stage notification does not start a model turn', async t => {
  let notifyStage;
  const notified = new Promise(resolve => { notifyStage = resolve; });
  const { runner, calls } = await fixture(t);
  const result = runner.run({
    prompt: '测试任务',
    onStage: () => {
      notifyStage();
      return new Promise(() => {});
    },
  });
  await notified;
  assert.equal(runner.cancel(), true);
  await assert.rejects(result, { code: 'TEAM_CANCELLED' });
  assert.equal(calls.length, 0);
});

test('long execution reports are bounded while retaining the beginning and end', async t => {
  const { calls, runner } = await fixture(t, {
    workerRun: async () => ({ text: '首部' + 'x'.repeat(30000) + '末尾' }),
  });
  await runner.run({ prompt: '生成长文本' });
  assert.match(calls[2].prompt, /首部/);
  assert.match(calls[2].prompt, /末尾/);
  assert.match(calls[2].prompt, /中间已省略/);
  assert.ok(calls[2].prompt.length < 17000);
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexRunner } from '../src/codex-runner.mjs';

const ID = '019a1234-5678-7000-8000-123456789abc';
const SECRET = 'test-secret-never-forward';
const fixture = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let prompt = '';
for await (const data of process.stdin) prompt += data;
writeFileSync(process.env.RUNNER_CAPTURE, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
const out = (data) => process.stdout.write(JSON.stringify(data) + '\\n');
const scenario = process.env.RUNNER_SCENARIO;
out({type:'thread.started',thread_id:'${ID}'});
if (scenario === 'hang') { setInterval(() => {}, 1000); }
else if (scenario === 'error') { process.stderr.write('${SECRET}'); out({type:'error',message:'${SECRET}'}); out({type:'turn.failed',error:{message:'${SECRET}'}}); process.exitCode=1; }
else if (scenario === 'malformed') { process.stdout.write('not-json\\n'); }
else if (scenario === 'null-event') { process.stdout.write('null\\n'); }
else if (scenario === 'oversized') { process.stdout.write('x'.repeat(8*1024*1024+1)); }
else if (scenario === 'empty') { out({type:'turn.completed'}); }
else if (scenario === 'incomplete') { out({type:'item.completed',item:{type:'agent_message',text:'partial'}}); }
else { out({type:'item.completed',item:{type:'reasoning',text:'${SECRET}'}}); out({type:'item.completed',item:{type:'command_execution',aggregated_output:'${SECRET}'}}); out({type:'item.completed',item:{type:'agent_message',text:'commentary',phase:'commentary'}}); out({type:'item.completed',item:{type:'agent_message',text:'最终结果：中文\\n第二行',phase:'final_answer'}}); process.stdout.write(JSON.stringify({type:'turn.completed'})); }
`;

async function setup(t, scenario = 'success', extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'mock-codex.mjs');
  const capture = join(dir, 'call.json');
  await writeFile(bin, fixture);
  await chmod(bin, 0o700);
  return { dir, capture, runner: new CodexRunner({ codexBin: bin, workspace: dir,
    timeoutMs: 3_000, env: { ...process.env, RUNNER_CAPTURE: capture, RUNNER_SCENARIO: scenario }, ...extra }) };
}

test('new task uses stdin, exact workspace and user MCP configuration without forwarding tool output', async (t) => {
  const { runner, capture, dir } = await setup(t);
  const saved = [];
  const prompt = '请分析 `echo secret` 和 $(touch injected) 原样文字';
  assert.deepEqual(await runner.run({ prompt, onThread: (id) => saved.push(id) }),
    { text: '最终结果：中文\n第二行', sessionId: ID });
  assert.deepEqual(saved, [ID]);
  const call = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(call.prompt, prompt);
  assert.equal(call.cwd, await realpath(dir));
  assert.ok(!call.args.includes(prompt));
  assert.ok(!call.args.includes('--image'));
  assert.ok(!call.args.includes('--ignore-user-config'));
  assert.equal(call.args[call.args.indexOf('--cd') + 1], dir);
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(call.args.includes('approval_policy="on-request"'));
  assert.ok(call.args.includes('approvals_reviewer="auto_review"'));
  assert.ok(!call.args.some((arg) => arg.startsWith('model_reasoning_effort=')));
  assert.ok(!call.args.some((arg) => arg.includes('bypass')));
  assert.equal(runner.cancel(), false);
});

test('new and resumed tasks keep the model and reasoning effort, with explicit session on resume', async (t) => {
  const { runner, capture, dir } = await setup(t, 'success', {
    sandbox: 'read-only', model: 'test-model', reasoningEffort: 'ultra',
  });
  const newTask = await runner.run({ prompt: '开始' });
  const first = JSON.parse(await readFile(capture, 'utf8')).args;
  assert.equal(first[first.indexOf('--model') + 1], 'test-model');
  assert.ok(first.includes('model_reasoning_effort="ultra"'));
  assert.equal(newTask.sessionId, ID);
  assert.equal((await runner.run({ prompt: '继续', sessionId: ID })).sessionId, ID);
  const { args } = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('resume')), ['resume', '--json', '--skip-git-repo-check', ID, '-']);
  assert.ok(!args.includes('--ignore-user-config'));
  assert.ok(!args.includes('--last'));
  assert.equal(args[args.indexOf('--cd') + 1], dir);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  assert.ok(args.slice(0, args.indexOf('resume')).includes('model_reasoning_effort="ultra"'));
});

test('new and resumed tasks attach only their current images and keep the prompt on stdin', async (t) => {
  const { runner, capture, dir } = await setup(t);
  const first = join(dir, '第一张 图片.png');
  const second = join(dir, 'second image.jpg');
  const latest = join(dir, 'new screenshot.png');

  await runner.run({ prompt: '比较两张图。', images: [first, second] });
  const initialCall = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(initialCall.args.slice(0, 6), ['exec', '--image', first, '--image', second, '--json']);
  assert.equal(initialCall.args.at(-1), '-');
  assert.equal(initialCall.prompt, '比较两张图。');

  await runner.run({ prompt: '读出这张图的短码。', sessionId: ID, images: [latest] });
  const resumedCall = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(resumedCall.args.slice(resumedCall.args.indexOf('resume')),
    ['resume', '--image', latest, '--json', '--skip-git-repo-check', ID, '-']);
  assert.ok(!resumedCall.args.includes(first));
  assert.ok(!resumedCall.args.includes(second));
  assert.equal(resumedCall.prompt, '读出这张图的短码。');
});

test('CLI failures do not expose raw event errors or stderr and retain their session', async (t) => {
  const { runner } = await setup(t, 'error');
  await assert.rejects(runner.run({ prompt: '测试' }), (error) => {
    assert.equal(error.code, 'CODEX_FAILED');
    assert.equal(error.sessionId, ID);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
});

test('cancel stops an active process and concurrent work is refused', async (t) => {
  const { runner } = await setup(t, 'hang');
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const running = runner.run({ prompt: '等待', onThread: ready });
  await started;
  await assert.rejects(runner.run({ prompt: '第二个' }), { code: 'CODEX_BUSY' });
  assert.equal(runner.cancel(), true);
  await assert.rejects(running, (error) => {
    assert.equal(error.code, 'CODEX_CANCELLED');
    assert.equal(error.sessionId, ID);
    return true;
  });
  assert.equal(runner.cancel(), false);
});

test('timeout terminates the process and releases the runner', async (t) => {
  const { runner } = await setup(t, 'hang', { timeoutMs: 100 });
  await assert.rejects(runner.run({ prompt: '等待' }), { code: 'CODEX_TIMEOUT' });
  assert.equal(runner.cancel(), false);
});

test('protocol and output limits reject incomplete, malformed or excessive stdout', async (t) => {
  for (const [scenario, code] of [['empty', 'CODEX_NO_OUTPUT'], ['incomplete', 'CODEX_PROTOCOL'],
    ['malformed', 'CODEX_PROTOCOL'], ['null-event', 'CODEX_PROTOCOL'], ['oversized', 'CODEX_OUTPUT_LIMIT']]) {
    const { runner } = await setup(t, scenario);
    await assert.rejects(runner.run({ prompt: '测试' }), { code });
  }
});

test('session persistence failure stops the task without forwarding the callback error', async (t) => {
  const { runner } = await setup(t);
  await assert.rejects(runner.run({ prompt: '测试', onThread: () => { throw new Error(SECRET); } }), (error) => {
    assert.equal(error.code, 'CODEX_CALLBACK');
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
});

test('missing CLI and invalid session identifiers or image paths fail before running user work', async (t) => {
  const { runner, dir } = await setup(t, 'success', { codexBin: '/nonexistent/feishu-codex-cli' });
  await assert.rejects(runner.run({ prompt: '测试' }), { code: 'CODEX_NOT_FOUND' });
  await assert.rejects(runner.run({ prompt: '测试', sessionId: '--last' }), { code: 'CODEX_CONFIGURATION' });
  await assert.rejects(runner.run({ prompt: '测试', images: ['relative.png'] }), { code: 'CODEX_CONFIGURATION' });
  await assert.rejects(runner.run({ prompt: '测试', images: [join(dir, 'a,b.png')] }), { code: 'CODEX_CONFIGURATION' });
});

test('an unresponsive asynchronous persistence callback still respects timeout', async (t) => {
  const { runner } = await setup(t, 'success', { timeoutMs: 300 });
  await assert.rejects(runner.run({ prompt: '测试', onThread: () => new Promise(() => {}) }), { code: 'CODEX_TIMEOUT' });
});

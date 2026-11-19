import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

export const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** One local Codex task per instance. Authentication stays in the existing CLI. */
export class CodexRunner {
  #active = null;

  constructor({ codexBin = 'codex', workspace, sandbox = 'workspace-write', model, reasoningEffort,
    timeoutMs = 900_000, env = process.env } = {}) {
    if (!workspace || !['read-only', 'workspace-write'].includes(sandbox)
      || typeof codexBin !== 'string' || !codexBin
      || (model != null && (typeof model !== 'string' || !model))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw fail('CODEX_CONFIGURATION', 'Codex 工作目录、模型、权限或超时配置无效。');
    }
    if (reasoningEffort != null && reasoningEffort !== '' && !REASONING_EFFORTS.includes(reasoningEffort)) {
      throw fail('CODEX_CONFIGURATION', 'Codex 推理强度配置无效。');
    }
    this.workspace = resolve(workspace);
    try {
      if (!statSync(this.workspace).isDirectory()) throw new Error();
    } catch {
      throw fail('CODEX_CONFIGURATION', 'Codex 工作目录不存在，请先完成本机配置。');
    }
    this.codexBin = codexBin;
    this.sandbox = sandbox;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs;
    this.env = env;
  }

  async run({ prompt, sessionId, onThread } = {}) {
    if (this.#active) throw fail('CODEX_BUSY', 'Codex 正在处理另一个任务，请稍后再试。');
    if (typeof prompt !== 'string' || !prompt.trim()) throw fail('CODEX_CONFIGURATION', '请发送非空的文字任务。');
    if (sessionId != null && (typeof sessionId !== 'string' || !UUID.test(sessionId))) {
      throw fail('CODEX_CONFIGURATION', '保存的 Codex 会话编号无效，请使用 /new 新建会话。');
    }
    // Explicit exec-level cwd/permission overrides also apply to resumed sessions.
    // Load the user's Codex configuration, including its configured MCP servers.
    const args = ['exec', '--json', '--skip-git-repo-check',
      '--color', 'never', '--cd', this.workspace, '--sandbox', this.sandbox,
      '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"',
      '-c', `sandbox_mode="${this.sandbox}"`];
    if (this.model) args.push('--model', this.model);
    if (this.reasoningEffort) args.push('-c', `model_reasoning_effort="${this.reasoningEffort}"`);
    if (sessionId) args.push('resume', '--json', '--skip-git-repo-check', sessionId, '-');
    else args.push('-');

    return new Promise((resolveRun, rejectRun) => {
      let child;
      try {
        child = spawn(this.codexBin, args, { cwd: this.workspace, env: this.env,
          shell: false, detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        rejectRun(fail('CODEX_START_FAILED', '无法启动本机 Codex，请检查可执行文件与工作目录。'));
        return;
      }
      let buffer = '';
      let outputBytes = 0;
      let threadId = sessionId;
      let notifiedThread = false;
      let finalText = '';
      let turnCompleted = false;
      let turnFailed = false;
      let sawError = false;
      let finished = false;
      let killTimer;
      let drainTimer;
      let notifyStopped;
      const stopped = new Promise((resolveStopped) => { notifyStopped = resolveStopped; });
      const callbackTasks = [];
      const active = { stopError: null, stop: null };
      this.#active = active;

      const signalGroup = (signal) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (error.code !== 'ESRCH') {
            try { child.kill(signal); } catch { /* Already stopped. */ }
          }
        }
      };
      const stop = (error) => {
        if (finished || active.stopError) return;
        active.stopError = error;
        notifyStopped();
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), 1_000);
        killTimer.unref();
      };
      active.stop = stop;
      const timer = setTimeout(() => stop(fail('CODEX_TIMEOUT', 'Codex 处理超时，任务已停止。可以缩小任务后重试。')), this.timeoutMs);
      const settle = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(drainTimer);
        if (this.#active === active) this.#active = null;
        if (error) {
          if (threadId) error.sessionId = threadId;
          rejectRun(error);
        } else resolveRun(result);
      };
      const parseLine = (line) => {
        if (active.stopError || !line.trim()) return;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          stop(fail('CODEX_OUTPUT_LIMIT', 'Codex 输出过大，任务已停止。请缩小任务范围。'));
          return;
        }
        let event;
        try { event = JSON.parse(line); } catch {
          stop(fail('CODEX_PROTOCOL', 'Codex 返回了无法识别的数据，请检查 CLI 版本。'));
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          stop(fail('CODEX_PROTOCOL', 'Codex 返回了无法识别的数据，请检查 CLI 版本。'));
          return;
        }
        if (event.type === 'thread.started') {
          if (typeof event.thread_id !== 'string' || !UUID.test(event.thread_id)
            || (sessionId && event.thread_id !== sessionId)) {
            stop(fail('CODEX_PROTOCOL', 'Codex 没有返回有效的会话编号。'));
            return;
          }
          threadId = event.thread_id;
          if (!notifiedThread && onThread) {
            notifiedThread = true;
            try {
              const task = Promise.resolve(onThread(threadId));
              callbackTasks.push(task);
              task.catch(() => stop(fail('CODEX_CALLBACK', '保存 Codex 会话失败，任务已停止。')));
            } catch {
              stop(fail('CODEX_CALLBACK', '保存 Codex 会话失败，任务已停止。'));
            }
          }
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          // Discard reasoning, tool output and commentary. Forward only the last
          // final agent message after its turn has completed successfully.
          if ((!event.item.phase || event.item.phase === 'final_answer') && typeof event.item.text === 'string') finalText = event.item.text;
        } else if (event.type === 'turn.completed') turnCompleted = true;
        else if (event.type === 'turn.failed') turnFailed = true;
        else if (event.type === 'error') sawError = true;
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (active.stopError || finished) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          stop(fail('CODEX_OUTPUT_LIMIT', 'Codex 输出过大，任务已停止。请缩小任务范围。'));
          return;
        }
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          parseLine(line);
          if (active.stopError) { buffer = ''; return; }
        }
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
          buffer = '';
          stop(fail('CODEX_OUTPUT_LIMIT', 'Codex 输出过大，任务已停止。请缩小任务范围。'));
        }
      });
      // Never retain or forward stderr: it may include credentials or local data.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', (error) => settle(fail(error.code === 'ENOENT' ? 'CODEX_NOT_FOUND' : 'CODEX_START_FAILED',
        error.code === 'ENOENT' ? '找不到本机 Codex，请检查 CODEX_BIN 或重新安装 CLI。'
          : '无法启动本机 Codex，请检查可执行文件与工作目录。')));
      child.on('exit', () => {
        // Inherited stdout pipes must not let surviving command children hang us.
        drainTimer = setTimeout(() => signalGroup('SIGKILL'), 1_000);
        drainTimer.unref();
      });
      child.on('close', async (code) => {
        if (finished) return;
        signalGroup('SIGKILL');
        if (buffer.trim() && !active.stopError) parseLine(buffer);
        try { await Promise.race([Promise.all(callbackTasks), stopped]); } catch {
          active.stopError ??= fail('CODEX_CALLBACK', '保存 Codex 会话失败，任务已停止。');
        }
        if (active.stopError) settle(active.stopError);
        else if (code !== 0 || turnFailed || (sawError && !turnCompleted)) settle(fail('CODEX_FAILED', 'Codex 执行失败，请在本机检查登录、模型与配置。'));
        else if (!turnCompleted || !threadId) settle(fail('CODEX_PROTOCOL', 'Codex 未正常完成任务，请检查 CLI 版本与会话状态。'));
        else if (!finalText.trim()) settle(fail('CODEX_NO_OUTPUT', 'Codex 本次没有返回文字结果，请补充任务说明后重试。'));
        else settle(null, { text: finalText, sessionId: threadId });
      });
      child.stdin.end(prompt);
    });
  }

  cancel() {
    if (!this.#active) return false;
    this.#active.stop(fail('CODEX_CANCELLED', '本次 Codex 任务已停止。'));
    return true;
  }
}

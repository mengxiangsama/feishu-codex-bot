import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAX_PROCESSED = 2000;
const MAX_TEXT = 12000;
const HELP = '直接发送文字任务即可连续对话。\n/new — 开始新对话\n/status — 查看状态\n/help — 查看帮助\n电脑和本地程序需要保持运行。';

function freshState() {
  return { version: 1, ownerOpenId: null, pairingCode: randomBytes(6).toString('hex'), sessions: {}, processed: [] };
}

function validateState(value) {
  if (!value || value.version !== 1 ||
      !(value.ownerOpenId === null || (typeof value.ownerOpenId === 'string' && value.ownerOpenId.length > 0)) ||
      typeof value.pairingCode !== 'string' || !/^[a-f0-9]{12}$/.test(value.pairingCode) ||
      !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) ||
      Object.values(value.sessions).some(id => typeof id !== 'string' || !id || id.length > 200) ||
      !Array.isArray(value.processed) || value.processed.some(id => typeof id !== 'string' || !id)) {
    throw new Error('INVALID_STATE');
  }
  return {
    version: 1,
    ownerOpenId: value.ownerOpenId,
    pairingCode: value.pairingCode,
    sessions: { ...value.sessions },
    processed: [...new Set(value.processed)].slice(-MAX_PROCESSED),
  };
}

/** Routes Feishu events to one local Codex worker. No message text is persisted. */
export class Bot {
  constructor({ stateFile, runner, messenger, botName, persona, logger = console, maxQueue = 8 }) {
    if (!stateFile || !runner?.run || !runner?.cancel || !messenger?.reply ||
        !Number.isInteger(maxQueue) || maxQueue < 1) {
      throw new Error('机器人配置不完整。');
    }
    this.stateFile = resolve(stateFile);
    this.runner = runner;
    this.messenger = messenger;
    this.botName = typeof botName === 'string' ? botName.trim() : '';
    this.persona = typeof persona === 'string' ? persona.trim() : '';
    this.workerLabel = this.botName || '本机 Codex';
    const stopHelp = '/stop — 停止当前会话的本机 Codex 进程，并清空其等待队列。';
    this.helpText = `你正在与 ${this.workerLabel} 对话，任务由本机 Codex 处理。${HELP}\n${stopHelp}`;
    this.logger = logger;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.current = null;
    this.pendingReplies = new Set();
    this.idleWaiters = new Set();
    this.closed = false;
    this.failed = false;
    this.draining = false;
    this.scheduled = false;

    try {
      mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      chmodSync(dirname(this.stateFile), 0o700);
      this.state = existsSync(this.stateFile)
        ? validateState(JSON.parse(readFileSync(this.stateFile, 'utf8')))
        : freshState();
      this.seen = new Set(this.state.processed);
      this.persist();
    } catch {
      throw new Error('无法读取或保存本地机器人状态。请检查状态文件和目录权限；损坏的文件不会被自动覆盖。');
    }
  }

  get pairingCode() { return this.state.ownerOpenId ? undefined : this.state.pairingCode; }
  get ownerOpenId() { return this.state.ownerOpenId; }

  persist() {
    const temporary = `${this.stateFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.stateFile);
      chmodSync(this.stateFile, 0o600);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Keep the original failure. */ }
      throw error;
    }
  }

  log(message) {
    try { this.logger?.error?.(message); } catch { /* Logging must not break event acknowledgement. */ }
  }

  reply(messageId, text) {
    const pending = Promise.resolve()
      .then(() => this.messenger.reply(messageId, text))
      .then(() => true, () => { this.log('飞书回复发送失败，请检查本机连接和应用权限。'); return false; });
    this.pendingReplies.add(pending);
    void pending.then(() => {
      this.pendingReplies.delete(pending);
      this.notifyIdle();
    });
    return pending;
  }

  failState(messageId) {
    this.failed = true;
    this.queue = [];
    if (this.current) this.current.cancelled = true;
    try { this.runner.cancel(); } catch { /* The worker may already have exited. */ }
    this.log('本地状态保存失败，已停止接受本机 Codex 任务。');
    if (messageId) void this.reply(messageId, '本地状态保存失败，任务已停止。请在电脑上检查状态文件权限后重启程序。');
    this.notifyIdle();
  }

  /** Intentionally returns immediately: SDK event acknowledgement must not await a task. */
  handleEvent(envelope) {
    if (this.closed) return;
    const event = envelope?.event ?? envelope;
    const sender = event?.sender;
    const message = event?.message;
    const senderId = sender?.sender_id?.open_id;
    const messageId = message?.message_id;
    if (sender?.sender_type !== 'user' || typeof senderId !== 'string' || !senderId ||
        typeof messageId !== 'string' || !messageId || typeof message?.chat_id !== 'string' || !message.chat_id) return;
    if (message.chat_type !== 'p2p' && message.chat_type !== 'group') return;
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (message.chat_type === 'group' && mentions.length === 0) return;
    if (this.state.ownerOpenId && senderId !== this.state.ownerOpenId) return;
    if (this.seen.has(messageId)) return;
    if (this.failed) {
      void this.reply(messageId, '本地状态不可用，请在电脑上检查后重启程序。');
      return;
    }

    try {
      this.state.processed.push(messageId);
      if (this.state.processed.length > MAX_PROCESSED) this.state.processed.splice(0, this.state.processed.length - MAX_PROCESSED);
      this.persist();
      this.seen = new Set(this.state.processed);
    } catch {
      this.failState(messageId);
      return;
    }

    let text;
    if (message.message_type === 'text') {
      try { text = JSON.parse(message.content).text; } catch { /* Reply with the text-only guidance below. */ }
    }
    if (typeof text !== 'string') {
      void this.reply(messageId, this.state.ownerOpenId
        ? '目前支持文字消息，请把任务描述以文字发送给我。'
        : '请先在飞书私聊中绑定机器人。绑定码可在运行程序的本机终端查看。');
      return;
    }
    for (const mention of mentions) {
      if (typeof mention?.key === 'string' && mention.key) text = text.split(mention.key).join('');
    }
    text = text.trim();

    if (!this.state.ownerOpenId) {
      // Never accept a pairing secret in a group, even when it is correct.
      if (message.chat_type !== 'p2p') {
        void this.reply(messageId, '请在与机器人的私聊中完成绑定。绑定码仅在本机终端查看，请勿发送到群聊。');
        return;
      }
      const match = /^\/pair\s+([a-f0-9]{12})$/i.exec(text);
      if (!match || match[1].toLowerCase() !== this.state.pairingCode) {
        void this.reply(messageId, '机器人尚未绑定。请在运行程序的本机终端查看绑定码，再在此私聊发送 /pair 加空格和绑定码。');
        return;
      }
      try {
        this.state.ownerOpenId = senderId;
        this.persist();
      } catch {
        this.state.ownerOpenId = null;
        this.failState(messageId);
        return;
      }
      void this.reply(messageId, `绑定成功，今后仅接受你的指令。\n${this.helpText}`);
      return;
    }

    const key = JSON.stringify([message.chat_id, senderId]);
    if (/^\/pair(?:\s|$)/i.test(text)) {
      void this.reply(messageId, '你已完成绑定，无需重复绑定。');
    } else if (text === '/help') {
      void this.reply(messageId, this.helpText);
    } else if (text === '/status') {
      const current = this.current ? '正在处理任务' : '空闲';
      const context = this.state.sessions[key] ? '已有连续对话' : '新对话';
      void this.reply(messageId, `机器人：${this.workerLabel}\n状态：${current}\n等待任务：${this.queue.length}\n当前会话：${context}`);
    } else if (text === '/stop') {
      const before = this.queue.length;
      this.queue = this.queue.filter(job => job.key !== key);
      const removed = before - this.queue.length;
      const active = this.current?.key === key;
      if (active) {
        this.current.cancelled = true;
        try { this.runner.cancel(); } catch { /* The worker may already have exited. */ }
      }
      const stopped = `已停止当前会话的本机 Codex 进程，并取消 ${removed} 条等待任务。`;
      void this.reply(messageId, active || removed ? stopped : '当前会话没有正在执行或等待的任务。');
      this.notifyIdle();
    } else if (!text) {
      void this.reply(messageId, '请发送文字任务，或发送 /help 查看命令。');
    } else if (text.length > MAX_TEXT) {
      void this.reply(messageId, `消息过长，请分成不超过 ${MAX_TEXT} 字符的文字发送。`);
    } else if (this.queue.length + (this.current ? 1 : 0) >= this.maxQueue) {
      void this.reply(messageId, '等待队列已满，请稍后再发送任务。');
    } else {
      this.queue.push({ messageId, key, text, reset: text === '/new', cancelled: false });
      this.scheduleDrain();
    }
  }

  scheduleDrain() {
    if (this.scheduled || this.draining || this.closed || this.failed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed || this.failed) { this.notifyIdle(); return; }
      void this.drain();
    });
  }

  async drain() {
    this.draining = true;
    try {
      while (this.queue.length && !this.closed && !this.failed) {
        const job = this.queue.shift();
        this.current = job;
        try { await this.processJob(job); }
        catch { this.log('任务处理异常，已结束此任务。'); }
        finally { this.current = null; }
      }
    } finally {
      this.draining = false;
      this.notifyIdle();
    }
  }

  async processJob(job) {
    if (job.cancelled || this.closed || this.failed) return;
    if (job.reset) {
      try { delete this.state.sessions[job.key]; this.persist(); }
      catch { this.failState(job.messageId); return; }
      await this.reply(job.messageId, `已开始新对话。接下来发送的任务会使用新的 ${this.workerLabel} 会话。`);
      return;
    }
    await this.reply(job.messageId, `已收到，正在由${this.workerLabel}处理。`);
    if (job.cancelled || this.closed || this.failed) return;
    // Confirm persistence is still writable immediately before submitting a task.
    try { this.persist(); } catch { this.failState(job.messageId); return; }
    try {
      const result = await this.runner.run({
        prompt: this.persona ? `机器人角色配置：\n${this.persona}\n\n飞书用户消息：\n${job.text}` : job.text,
        sessionId: this.state.sessions[job.key],
        onThread: id => {
          if (job.cancelled || this.closed || this.failed) return;
          if (typeof id !== 'string' || !id || id.length > 200) {
            this.failState(job.messageId);
            return;
          }
          try { this.state.sessions[job.key] = id; this.persist(); }
          catch { this.failState(job.messageId); }
        },
      });
      if (job.cancelled || this.closed || this.failed) return;
      if (result?.sessionId && this.state.sessions[job.key] !== result.sessionId) {
        try {
          if (typeof result.sessionId !== 'string' || result.sessionId.length > 200) throw new Error('INVALID_SESSION');
          this.state.sessions[job.key] = result.sessionId;
          this.persist();
        } catch { this.failState(job.messageId); return; }
      }
      await this.reply(job.messageId, typeof result?.text === 'string' && result.text.trim()
        ? result.text
        : `任务已结束，${this.workerLabel} 未返回文字结果。`);
    } catch {
      if (job.cancelled || this.closed || this.failed) return;
      this.log('机器人执行失败，请在本机检查登录、连接和运行环境。');
      await this.reply(job.messageId, `${this.workerLabel} 执行失败。请在电脑上检查登录、连接和运行环境；发送 /new 可以开始新对话。`);
    }
  }

  notifyIdle() {
    if (this.draining || this.scheduled || this.queue.length || this.pendingReplies.size) return;
    for (const resolveIdle of this.idleWaiters) resolveIdle();
    this.idleWaiters.clear();
  }

  async idle() {
    if (!this.draining && !this.scheduled && !this.queue.length && !this.pendingReplies.size) return;
    await new Promise(resolveIdle => this.idleWaiters.add(resolveIdle));
  }

  async close() {
    this.closed = true;
    this.queue = [];
    if (this.current) this.current.cancelled = true;
    try { this.runner.cancel(); } catch { /* The worker may already have exited. */ }
    this.notifyIdle();
    await this.idle();
  }
}

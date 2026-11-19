import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const MAX_PROCESSED = 2000;
const MAX_TEXT = 12000;
const BOT_OPEN_ID_RETRY_MS = 5000;
const HELP = '发送文字、图片或图文消息即可连续对话。\n/new — 开始新对话\n/status — 查看状态\n/help — 查看帮助\n电脑和本地程序需要保持运行。';
const IMAGE_PROMPT = '请描述这条消息中的图片。';
const TEAM_COMMAND = /^\/协作(?:\s+([\s\S]*))?$/;
const TEAM_FAILURES = new Map([
  ['TEAM_PLAN_FAILED', '负责人规划未完成'],
  ['TEAM_WORKER_UNAVAILABLE', '没有可用的执行机器人'],
  ['TEAM_EXECUTE_FAILED', '执行者未完成任务'],
  ['TEAM_REVIEW_FAILED', '负责人审查未完成'],
]);

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

function parseParagraphs(paragraphs) {
  const lines = [];
  const imageKeys = [];
  for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
    if (!Array.isArray(paragraph)) continue;
    let line = '';
    for (const node of paragraph) {
      if (node?.tag === 'img' && typeof node.image_key === 'string' && node.image_key.trim()) {
        imageKeys.push(node.image_key);
      } else if (node?.tag !== 'at' && typeof node?.text === 'string') {
        line += node.text;
      }
    }
    if (line.trim()) lines.push(line);
  }
  return { lines, imageKeys };
}

function parseMessage(message) {
  let body;
  try { body = JSON.parse(message.content); } catch { return; }
  if (message.message_type === 'text' && typeof body?.text === 'string') {
    return { text: body.text, imageKeys: [] };
  }
  if (message.message_type === 'image' && typeof body?.image_key === 'string' && body.image_key.trim()) {
    return { text: '', imageKeys: [body.image_key] };
  }
  if (message.message_type !== 'post' || !body || typeof body !== 'object') return;

  const post = [body, body.zh_cn, body.en_us, ...Object.values(body)]
    .find(locale => Array.isArray(locale?.content) || Array.isArray(locale?.content_v2));
  if (!post) return;
  const current = parseParagraphs(post.content_v2);
  const legacy = parseParagraphs(post.content);
  const title = typeof post.title === 'string' ? post.title.trim() : '';
  return {
    text: [title, ...(current.lines.length ? current.lines : legacy.lines)].filter(Boolean).join('\n'),
    imageKeys: [...new Set([...legacy.imageKeys, ...current.imageKeys])],
  };
}

/** Routes Feishu events to one local Codex worker, with images staged only for active jobs. */
export class Bot {
  #teamReservation;
  #nextBotOpenIdAttemptAt = 0;

  constructor({ stateFile, runner, messenger, botName, botOpenId = null, persona, teamRunner, teamChatId, teamNoMention = false,
    logger = console, maxQueue = 8 }) {
    if (!stateFile || !runner?.run || !runner?.cancel || !messenger?.reply ||
        !Number.isInteger(maxQueue) || maxQueue < 1) {
      throw new Error('机器人配置不完整。');
    }
    if (teamRunner != null && (typeof teamRunner.run !== 'function' || typeof teamRunner.cancel !== 'function' ||
        typeof teamChatId !== 'string' || !teamChatId.trim())) {
      throw new Error('协作配置不完整。');
    }
    this.stateFile = resolve(stateFile);
    this.runner = runner;
    this.messenger = messenger;
    this.botName = typeof botName === 'string' ? botName.trim() : '';
    this.botOpenId = botOpenId;
    this.persona = typeof persona === 'string' ? persona.trim() : '';
    this.workerLabel = this.botName || '本机 Codex';
    this.teamRunner = teamRunner;
    this.teamChatId = teamChatId;
    this.teamNoMention = teamNoMention;
    const stopHelp = '/stop — 停止当前会话的本机 Codex 进程，并清空其等待队列。';
    let teamHelp = '';
    if (teamRunner) {
      teamHelp = teamNoMention
        ? '\n在指定协作群直接发任务或追问即可，无需 @。'
        : '\n在指定群 @ 我并直接发任务，即会启动协作。';
    }
    this.helpText = `你正在与 ${this.workerLabel} 对话，任务由本机 Codex 处理。${HELP}\n${stopHelp}${teamHelp}`;
    this.logger = logger;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.current = null;
    this.teamJobs = new Set();
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
  get canAcceptTeamWork() { return !this.closed && !this.failed; }

  async refreshBotOpenId() {
    if (this.closed || this.botOpenId || Date.now() < this.#nextBotOpenIdAttemptAt) return;
    const firstAttempt = this.#nextBotOpenIdAttemptAt === 0;
    this.#nextBotOpenIdAttemptAt = Infinity;
    try {
      this.botOpenId = await this.messenger.getBotOpenId();
    } catch {
      this.#nextBotOpenIdAttemptAt = Date.now() + BOT_OPEN_ID_RETRY_MS;
      if (firstAttempt && !this.closed) {
        this.log('无法获取机器人 Open ID，将自动重试。期间暂不处理群里的 @ 消息。', 'warn');
      }
    }
  }

  get #isIdle() {
    return !this.draining && !this.scheduled && !this.queue.length && !this.teamJobs.size && !this.pendingReplies.size && !this.#teamReservation;
  }

  reserveForTeam() {
    if (!this.canAcceptTeamWork || !this.#isIdle) return undefined;
    const release = () => {
      if (this.#teamReservation !== release) return;
      this.#teamReservation = undefined;
      if (this.queue.length) this.scheduleDrain();
      this.notifyIdle();
    };
    this.#teamReservation = release;
    return release;
  }

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

  log(message, level = 'error') {
    try { this.logger?.[level]?.(message); } catch { /* Logging must not break event acknowledgement. */ }
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
    this.cancelCurrentJob();
    this.log('本地状态保存失败，已停止接受本机 Codex 任务。');
    if (messageId) void this.reply(messageId, '本地状态保存失败，任务已停止。请在电脑上检查状态文件权限后重启程序。');
    this.notifyIdle();
  }

  cancelCurrentJob() {
    if (this.current) {
      this.current.cancelled = true;
      if (this.current.downloadController) this.current.downloadController.abort();
      else try { this.runner.cancel(); } catch { /* Already stopped. */ }
    }
    for (const job of this.teamJobs) this.cancelTeamJob(job);
  }

  cancelTeamJob(job) {
    job.cancelled = true;
    if (job.downloadController) job.downloadController.abort();
    else try { this.teamRunner.cancel(job.messageId); } catch { /* Already stopped. */ }
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
    const isGroup = message.chat_type === 'group';
    if (message.chat_type !== 'p2p' && !isGroup) return;
    if (this.state.ownerOpenId && senderId !== this.state.ownerOpenId) return;
    const inTeamGroup = Boolean(this.teamRunner && isGroup && message.chat_id === this.teamChatId);
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (isGroup && mentions.length === 0 && !(inTeamGroup && this.teamNoMention && this.state.ownerOpenId)) return;
    // With all-group delivery, a mention can target a different user or bot.
    if (isGroup && mentions.length &&
        !(this.botOpenId && mentions.some(mention => mention?.id?.open_id === this.botOpenId))) return;
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

    const parsed = this.state.ownerOpenId || message.message_type === 'text' ? parseMessage(message) : undefined;
    if (!parsed) {
      void this.reply(messageId, this.state.ownerOpenId
        ? '请发送文字消息、图片或图文消息。'
        : '请先在飞书私聊中绑定机器人。绑定码可在运行程序的本机终端查看。');
      return;
    }
    let { text } = parsed;
    const { imageKeys } = parsed;
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
    const teamCommand = TEAM_COMMAND.exec(text);
    const teamTask = teamCommand?.[1]?.trim();
    if (/^\/pair(?:\s|$)/i.test(text)) {
      void this.reply(messageId, '你已完成绑定，无需重复绑定。');
    } else if (text === '/help') {
      void this.reply(messageId, this.helpText);
    } else if (text === '/status') {
      const current = this.teamJobs.size ? `正在处理 ${this.teamJobs.size} 项协作任务` : this.#teamReservation ? '正在执行协作任务' : this.current ? '正在处理任务' : '空闲';
      const context = this.state.sessions[key] ? '已有连续对话' : '新对话';
      void this.reply(messageId, `机器人：${this.workerLabel}\n状态：${current}\n等待任务：${this.queue.length}\n当前会话：${context}`);
    } else if (text === '/stop') {
      const before = this.queue.length;
      this.queue = this.queue.filter(job => job.key !== key);
      const removed = before - this.queue.length;
      const active = this.current?.key === key;
      const downloading = active && this.current.downloadController;
      if (active) {
        this.current.cancelled = true;
        if (downloading) downloading.abort();
        else try { this.runner.cancel(); } catch { /* Already stopped. */ }
      }
      const activeTeam = [...this.teamJobs].filter(job => job.key === key);
      for (const job of activeTeam) this.cancelTeamJob(job);
      const cancelled = `已取消 ${removed} 条等待任务。`;
      if (downloading && !activeTeam.length) void this.reply(messageId, '已停止当前会话的图片下载。' + cancelled);
      else if (active || activeTeam.length) void this.reply(messageId, '已停止当前会话的本机 Codex 进程。' + cancelled);
      else void this.reply(messageId, removed ? cancelled : '当前会话没有正在执行或等待的任务。');
      this.notifyIdle();
    } else if (teamCommand && !this.teamRunner) {
      void this.reply(messageId, '请在指定群 @ 负责人并直接发任务。');
    } else if (teamCommand && !inTeamGroup) {
      void this.reply(messageId, '协作仅在配置的群聊中可用，请在该群 @ 我。');
    } else if (teamCommand && !teamTask && !imageKeys.length) {
      void this.reply(messageId, `请在 /协作 后写任务，例如：@${this.workerLabel} /协作 写一份机器人使用说明。`);
    } else if (!text && !imageKeys.length) {
      void this.reply(messageId, '请发送文字或图片，或发送 /help 查看命令。');
    } else if (text.length > MAX_TEXT) {
      void this.reply(messageId, `消息过长，请分成不超过 ${MAX_TEXT} 字符的文字发送。`);
    } else if (text === '/new' && ([...this.teamJobs].some(job => job.key === key) || this.queue.some(job => job.team && job.key === key))) {
      void this.reply(messageId, '当前会话仍有协作任务，请等任务完成或发送 /stop 后再开始新对话。');
    } else if (this.queue.length + this.teamJobs.size + (this.current ? 1 : 0) >= this.maxQueue) {
      void this.reply(messageId, '等待队列已满，请稍后再发送任务。');
    } else {
      const reset = text === '/new';
      this.queue.push({
        messageId, key, text: (teamCommand ? teamTask : text) || IMAGE_PROMPT, imageKeys,
        team: inTeamGroup && !reset, reset, cancelled: false,
      });
      this.scheduleDrain();
    }
  }

  scheduleDrain() {
    if (this.scheduled || this.draining || this.closed || this.failed || this.#teamReservation) return;
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
        if (job.team) {
          this.teamJobs.add(job);
          void this.processJob(job).catch(() => this.log('任务处理异常，已结束此任务。')).finally(() => {
            this.teamJobs.delete(job);
            this.notifyIdle();
          });
          continue;
        }
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
    await this.reply(job.messageId, job.team
      ? `已收到，${this.workerLabel} 正在处理。`
      : `已收到，正在由${this.workerLabel}处理。`);
    if (job.cancelled || this.closed || this.failed) return;
    // Confirm persistence is still writable immediately before submitting a task.
    try { this.persist(); } catch { this.failState(job.messageId); return; }

    let directory;
    let images;
    try {
      if (job.imageKeys.length) {
        const controller = new AbortController();
        job.downloadController = controller;
        try {
          directory = await mkdtemp(resolve(tmpdir(), 'feishu-codex-images-'));
          images = [];
          for (const key of job.imageKeys) {
            controller.signal.throwIfAborted();
            images.push(await this.messenger.downloadImage(job.messageId, key, directory, { signal: controller.signal }));
          }
        } catch (error) {
          if (job.cancelled || this.closed || this.failed) return;
          const reason = error?.code === 'FEISHU_IMAGE_DOWNLOAD' ? error.message : '本机无法准备图片，请检查运行环境。';
          await this.reply(job.messageId, `无法处理图片。${reason}`);
          return;
        } finally {
          job.downloadController = undefined;
        }
      }
      if (job.cancelled || this.closed || this.failed) return;
      if (job.team) await this.processTeamJob(job, images);
      else await this.processCodexJob(job, images);
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => {
          this.log('无法清理本次任务的临时图片。');
        });
      }
    }
  }

  async processCodexJob(job, images) {
    try {
      const result = await this.runner.run({
        prompt: this.persona ? `机器人角色配置：\n${this.persona}\n\n飞书用户消息：\n${job.text}` : job.text,
        sessionId: this.state.sessions[job.key],
        ...(images && { images }),
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

  async processTeamJob(job, images) {
    const stageMessages = new Map([
      ['waiting', '规划已完成，执行机器人都在忙，正在等待空闲。'],
      ['review', `执行已完成，${this.workerLabel} 正在审查结果。`],
    ]);
    this.log('协作开始：规划/执行/审查。', 'info');
    try {
      const result = await this.teamRunner.run({
        prompt: job.text,
        jobId: job.messageId,
        sessionId: this.state.sessions[job.key],
        ...(images && { images }),
        getSession: () => this.state.sessions[job.key],
        onThread: id => {
          if (job.cancelled || this.closed || this.failed) return;
          if (typeof id !== 'string' || !id || id.length > 200) {
            this.failState(job.messageId);
            return;
          }
          try { this.state.sessions[job.key] = id; this.persist(); }
          catch { this.failState(job.messageId); }
        },
        onStage: async (stage, workerName) => {
          if (job.cancelled || this.closed || this.failed) return;
          const message = stage === 'execute'
            ? `规划已完成，${workerName || '执行机器人'} 正在执行。`
            : stageMessages.get(stage);
          if (message) await this.reply(job.messageId, message);
        },
      });
      if (job.cancelled || this.closed || this.failed) return;
      if (typeof result?.text !== 'string' || !result.text.trim()) {
        await this.reply(job.messageId, '协作任务已结束，负责人未返回文字结果。');
        return;
      }
      if (await this.reply(job.messageId, `协作汇报\n${result.text}`)) {
        this.log('协作完成，结果已回复飞书。', 'info');
      }
    } catch (error) {
      if (job.cancelled || this.closed || this.failed) return;
      if (error?.code === 'TEAM_CANCELLED') {
        await this.reply(job.messageId, '协作任务已取消。');
        return;
      }
      this.log('协作执行失败，请在本机检查 Codex 运行状态。');
      const reason = TEAM_FAILURES.get(error?.code);
      await this.reply(job.messageId, reason
        ? `协作未完成：${reason}。请检查本机运行状态，或稍后重新发送。`
        : '协作未完成。请检查本机运行状态，或稍后重新发送。');
    }
  }

  notifyIdle() {
    if (!this.#isIdle) return;
    for (const resolveIdle of this.idleWaiters) resolveIdle();
  }

  async idle(signal) {
    if (signal?.aborted || this.#isIdle) return;
    await new Promise(resolveIdle => {
      const finish = () => {
        this.idleWaiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolveIdle();
      };
      this.idleWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  async close() {
    this.closed = true;
    this.queue = [];
    this.cancelCurrentJob();
    this.notifyIdle();
    await this.idle();
  }
}

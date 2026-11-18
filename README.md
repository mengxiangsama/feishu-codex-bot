# 飞书 Codex 机器人

在飞书里私聊或 @ 机器人，消息由这台 Mac 上的 Codex CLI 处理，结果回到飞书。可以只建一个机器人，也可以给不同项目建多个。每个机器人有自己的角色、模型、工作目录和对话状态。

工具会优先使用 ChatGPT 桌面应用附带的 Codex CLI，沿用本机 CLI 已保存的登录状态。飞书通过长连接传消息，因此这台电脑保持开机联网、工具保持运行即可，无需公网回调地址。

## 安装

需要 macOS、Node.js 22 或更新版本，以及已通过 ChatGPT 账号登录的 Codex CLI。

```sh
git clone https://github.com/mengxiangsama/feishu-codex-bot.git
cd feishu-codex-bot
./Start.command
```

也可以在访达中双击 `Start.command`。它会按需安装依赖并打开配置菜单。

## 新建第一个机器人

1. 打开[飞书开发者后台](https://open.feishu.cn/app)，选择要使用的飞书组织，然后点**创建企业自建应用**。应用名称会作为飞书里显示的机器人名称。进入**应用能力 → 添加应用能力 → 机器人**并启用。
2. 在**权限管理**开通下列应用身份权限。支持批量导入的后台可以使用 [feishu-permissions.json](feishu-permissions.json)。
   - `im:message.p2p_msg:readonly` 接收用户发给机器人的私聊。
   - `im:message.group_at_msg:readonly` 接收群里 @ 机器人的消息。只需要私聊可以不加这一项。
   - `im:message:send_as_bot` 以机器人身份回复。
3. 在**凭证与基础信息**找到 App ID 和 App Secret。双击 [Start.command](Start.command)，选 **2. 新建或更新机器人**。在本机终端填入凭证，接着设置角色和工作目录。App Secret 输入时不显示。角色、模型和目录可以先留空。
4. 再打开启动工具，选 **1. 启动桥接**。保持窗口打开，等终端显示**飞书长连接在线**。
5. 回到后台，进入**事件与回调 → 事件配置**，订阅方式选**使用长连接接收事件**并保存，然后添加**接收消息**事件 `im.message.receive_v1`。保存长连接配置时需要本机客户端已在线。[飞书长连接文档](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)
6. 进入**版本管理与发布**并创建版本。可用范围先选自己，提交发布。如果租户要求审批，等管理员通过。
7. 在飞书搜索你的机器人并私聊。按本机终端提示发 `/pair 绑定码` 完成首次绑定，然后发送“请用一句话介绍你能做什么”。绑定后只有这个飞书账号能让机器人执行任务。需要群聊时，把已发布的机器人加到群里再 @ 它。[飞书机器人文档](https://open.feishu.cn/document/client-docs/bot-v3/bot-overview?lang=zh-CN)

## 再建一个机器人

再创建一个飞书自建应用，重复设置机器人能力、权限和事件。启动工具选 **2**，输入另一个 App ID，就会新增一条配置。使用同一个 App ID 会更新原配置。重启桥接后可同时运行多个机器人。各飞书机器人用各自的配对码，群聊和私聊也各自保存上下文。

本机配置的名称用于终端及机器人回复。要改飞书里显示的名字，请在飞书应用后台改名称并按后台提示发布。

## 终端命令

需要 Node.js 22 或更新版本。在工具所在目录执行下列命令。双击启动工具时会按需安装依赖。

```sh
npm ci --ignore-scripts
npm run setup
npm run check
npm start
```

- `npm run list` 查看已配置的机器人。
- `npm start -- "机器人名称"` 只启动一个已配置的机器人。
- `npm run check` 检查 Codex 是否已登录和飞书应用凭证是否有效。飞书的发布、可用范围和收发消息权限仍需以实际私聊测试为准。
- `/status` 查看状态，`/new` 开新会话，`/stop` 停止当前会话的任务并清空它的排队请求，`/help` 查看帮助。

## 工作目录和权限

默认给每个机器人创建独立目录，Codex 以只读模式运行。需要让它修改项目时，在向导里选定项目目录，并选择允许修改工作目录。只读限制文件修改，可读取的范围由 Codex 沙箱决定。目录、写权限或模型变化后需要重新绑定并开始新对话。

Mac 上优先使用 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`。如果 ChatGPT 安装在其他位置，可设置 `FEISHU_CODEX_BIN` 为对应的 Codex CLI 可执行文件路径再启动。没有找到内置 CLI 时会尝试 PATH 上的 `codex`。

Codex 使用本机登录发起模型请求，电脑仍要联网。机器人的任务在本机目录里运行。这个版本支持文字消息、角色、模型、项目目录和连续对话。重启桥接后可以继续之前的会话，未执行的队列任务需要重新发送。凭证和会话对应关系保存在工具下的 `.local` 目录，请在本机保留这个目录。

## 排查连接

- 如果后台提示没有长连接，先在工具里运行 `npm run check`，再运行 `npm start`，看到长连接在线后再保存事件配置。
- 如果飞书搜不到机器人，检查是否选择了正确的飞书组织，以及应用版本是否已发布、你的账号是否在可用范围内。
- 如果机器人不回复，先私聊发送 `/help`，核对本机是否正在运行、账号是否绑定、是否已订阅接收消息事件，以及发送权限是否已发布。
- 若意外关机后工具提示已有启动记录，请确认提示中的进程已经结束，再删除 `.local/running.pid` 后重启。

[Codex CLI 非交互模式与会话恢复](https://learn.chatgpt.com/docs/non-interactive-mode)

## 测试与许可证

在项目目录运行 `npm test`。测试覆盖绑定、去重、会话恢复和 Codex 子进程，实际飞书收发需用已发布的自建应用验证。

源码采用 [MIT 许可证](LICENSE)。

# 注册飞书应用并部署独立机器人

在已经登录图形桌面的 Mac 上运行。需要 Node.js 22 或更新版本，以及已登录的 Codex CLI。在项目目录安装依赖。

```sh
npm ci --ignore-scripts
```

注册前，为这个机器人分别选定当前 Codex CLI 和账号支持的模型与推理强度。也可对任意一项明确选择 Codex 默认值。安装时会使用这两项设置，实际组合是否可用可在绑定后发消息确认。

## 注册飞书应用

```sh
node scripts/register-bot.mjs --name '项目助手' --description '从飞书使用本机 Codex'
```

在浏览器打开终端显示的限时链接，用飞书扫码并在目标组织确认创建应用。扫码页会尝试预填仓库的 [权限清单](../feishu-permissions.json) 和 `im.message.receive_v1` 接收消息事件，完成后到飞书开发者后台核对权限和事件。

脚本会在终端显示本机凭证文件的路径。文件所在临时目录权限为 `0700`，文件权限为 `0600`。请仅在本机使用该文件。

## 安装独立 LaunchAgent

把 `credentials` 替换成上一步输出的路径，并填入先前选定的模型和推理强度。示例中的两个 `-` 分别显式选择 Codex 默认值。

```sh
credentials='/替换为上一步输出的凭证路径/credentials.json'
node scripts/install-bot.mjs --credentials "$credentials" --name '项目助手' \
  --model - --reasoning-effort -
```

默认工作目录为 `workspaces/<app-id>`，Codex 以只读方式运行。需要允许修改时，安装命令可加 `--sandbox workspace-write`。需要优先服务档位且账号支持时，可加 `--service-tier priority`。指定 CLI 路径时，运行安装命令前设置 `FEISHU_CODEX_BIN`。

脚本检查飞书应用凭证，并通过 `launchd` 在当前用户的图形会话启动桥接。每个独立服务在 `.local/new-bots/<app-id>` 下保存配置、会话和日志。如果已通过 `FEISHU_BRIDGE_DATA_DIR` 指定主桥接的数据目录，`new-bots` 会建在该目录下。已加入主桥接的应用要继续用原来的启动方式，独立服务使用另一个应用。现有协作配置继续按 [README](../README.md#在一个群里配置负责人和多个执行机器人) 管理。

安装命令退出码 `0` 表示 `launchd` 已成功加载服务。终端会另行显示是否在 30 秒内看到飞书长连接上线。看到上线后，按 [README](../README.md#新建第一个机器人) 到飞书开发者后台确认机器人能力、权限和接收消息事件，保存长连接设置并发布应用。打开脚本显示的私有日志路径，查看首次绑定指令。在飞书私聊完成绑定并发送一条测试消息。确认部署成功后，可删除注册时生成的临时凭证文件。

## 查看和管理服务

用安装命令输出的服务名和 plist 路径替换示例值。

```sh
domain="gui/$(id -u)"
label='local.feishu.codex-bridge.<app-id>'
plist="$HOME/Library/LaunchAgents/$label.plist"
launchctl print "$domain/$label"
```

如果安装时 `launchd` 启动未确认，先用 `print` 查看。若服务尚未加载，可运行 `launchctl bootstrap "$domain" "$plist"`。如果服务已加载但飞书未上线，检查私有日志和后台的机器人配置。停止当前图形会话中的服务可运行 `launchctl bootout "$domain/$label"`。若要禁用下次登录时的自动启动，先停止服务，再将对应 plist 移出 `~/Library/LaunchAgents`。

如果日志提示已有启动记录，先用 `bootout` 停止该服务，并确认提示中的进程已经结束，再删除该实例数据目录中的 `running.pid`，然后用 `bootstrap` 重新加载。

安装依赖于运行安装时的项目目录、Node 和 Codex 路径。请从打算长期使用的项目目录安装。凭证、配对指令和桥接日志都应留在本机。

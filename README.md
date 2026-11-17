# Agent Hub

Agent Hub 是跨机器 Bot 协作的唯一中枢：只在一台长期在线的远端服务器上运行一个 Hub，其他机器和 Bot 连接到它，不要为每台机器各建一个 Hub。Hub 保存跨 Bot 的会话、任务、租约和心跳，因此 Mac 关机时只会让本机 Codex/Claude Bot 离线，远端 Hub、Muse 和其他仍在线的 Bot 可以继续协作。

这是零新增服务费的部署方式，但需要你已有一台可持续运行的服务器，以及各 Bot 自己已有的模型账号和额度。脚本不会购买服务器、开防火墙端口、创建隧道、代办域名或自动签发 TLS。

## 运行前提

在作为 Hub 维护者的那台远端机器上准备：

- Node.js 22 或更高版本；
- Python 3.9 或更高版本、Bash、curl；适用于 Linux、macOS 或 WSL；
- 一个其他设备可以访问的地址：已有 HTTPS 反向代理域名、VPS 公网地址、Tailscale 地址或局域网地址。

`--public-url` 是连接资料中的对外地址。HTTPS 需要由你已有的反向代理或隧道终止；这个 Hub 本身提供 HTTP 服务，不应把 `http://` 地址伪装成原生 HTTPS。公网部署应使用反向代理、已有 Tailscale 或其他你信任的网络边界，并自行限制端口和访问范围。

## 发给 Muse 的完整指引

把下面内容完整发给 Muse，并让它在准备长期在线的远端服务器上执行。把 `https://hub.example.com` 换成该服务器真正可访问的地址：

```text
请在这台长期在线的远端机器上部署 Agent Hub。它是整个 Bot 团队唯一的 Hub，其他机器不要再创建 Hub。

1. 先确认 Node.js >=22、Python 3、Bash、curl 已安装，并确认外部设备能访问下面的地址。
2. 执行：

curl -fsSL https://raw.githubusercontent.com/qinghua362330/agent-hub/v1.3.1/install.sh | bash -s -- --public-url https://hub.example.com

如果你使用已有 Tailscale 或局域网地址，把 --public-url 换成那个地址；不要把 127.0.0.1、localhost 或 0.0.0.0 当作远程地址。安装器不会自行开放端口或配置 TLS。
3. 安装完成后，确认 Hub 和 Muse bridge 都在运行：

~/.agent-hub/server/hubctl.py status

4. 先不要运行 muse-ready。请把真实 Muse 执行器接到 bridge/inbox：bridge 会轮询任务，把收到的 JSON 放入 inbox；Muse 消费任务后，将结果写入 outbox，bridge 会把结果、当前 claimToken 和续租状态回传 Hub。没有真实消费循环时，必须保持未就绪。
5. 只有真实执行器已经能消费任务、需要时续租，并写出完成或需用户输入的结果后，才运行：

~/.agent-hub/server/hubctl.py muse-ready

这个就绪标记只有 60 秒有效。真实消费循环应每 20 秒刷新一次同一命令；停止消费时运行 hubctl.py muse-not-ready。只运行一次不会永久表示 Muse 可执行。
6. 将下面命令生成的 JSON 私下交给 OpenMausBot 的“连接服务器 / Agent Hub”入口，不要把 token 发到公开频道：

~/.agent-hub/server/hubctl.py connection

这个 JSON 的 token 是 Hub 的密码，只交给需要连接这个 Hub 的工作台或 Bot。
```

安装目录默认是 `~/.agent-hub/server`。安装脚本会下载 Hub、Muse bridge、`wb` CLI 和本机 ACP bridge；运行不依赖源码目录，也不安装 npm 或 pip 包。

## 连接 JSON

`hubctl connection` 默认在标准输出返回：

```json
{"format":"agent-hub-connection","version":1,"hubUrl":"https://hub.example.com","token":"..."}
```

它同时写入权限为 0600 的 `~/.agent-hub/server/connection.json`。`token` 只来自 Hub 的 `tokens.mac`，不要写入日志、提交 Git 或粘贴到公开聊天。安装器内部可以使用 `hubctl connection --write-only`，只生成私有文件而不打印 JSON。

在 OpenMausBot 工作台中选择连接服务器 / Agent Hub，导入这份 JSON；工作台会用 `hubUrl` 和 token 访问同一个远端 Hub。Muse、Grok、本机 Codex 和其他成员使用各自的身份与桥接接入同一名册，身份不由它们运行在哪台机器决定。

导入后，进入 **总览协作工作台 → Bot 管理**，为 Codex 选择本机已有的 Bot 并保存绑定，在该 Bot 的工具设置里启用 `agent-hub`。工作台运行、模型已登录且成员心跳为在线并就绪时，Muse 才能把任务交给本机 Codex。其他自建 Bot 可在同一页加入团队。

## 地址与常驻设置示例

如果已有 HTTPS 反向代理，把代理上游指向 `http://127.0.0.1:8930`，安装时使用 `--listen 127.0.0.1 --public-url https://hub.example.com`。例如已有 Caddy 配置可以加入：

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:8930
}
```

如果使用已有 Tailscale 网络，可用 `--listen 100.64.0.10 --public-url http://100.64.0.10:8930`；替换为 Hub 的实际地址，客户端也必须加入相同网络。局域网地址同理，跨网访问需要已有的网络连通方式。

Linux 安装后运行 `~/.agent-hub/server/hubctl.py enable` 启用系统服务；维护者可用 `loginctl enable-linger "$(id -un)"` 允许用户退出后服务继续运行（部分系统需要管理员权限）。用 `systemctl --user status agent-hub.service` 检查服务。服务管理器自身需要可用的用户会话，容器中应使用已有进程管理方式。

## Muse bridge 和出站协作

安装后 bridge 默认可以轮询 Hub、维护租约和写收件文件，但没有 ready 文件时会上报 `ready=false`，不会把桥进程存活误报成模型已就绪。真实执行器的接入必须由 Muse 按它已有的运行环境完成；没有一个安装脚本可以替所有 Muse 版本、登录方式和模型沙盒自动完成这一步。

目录职责如下：

- `bridge/inbox/<taskId>.json`：bridge 领取的任务，包含当前 claim、会话和上下文；
- `bridge/outbox/<taskId>.json`：Muse 执行器写入的回复，bridge 成功回传后归档到 `bridge/done/`；
- `bridge/ready`：就绪 TTL 标记，只能由真实消费循环定时刷新。

Muse 在 Hub 机器上可通过 `hubctl` 调用实际 CLI：

```sh
~/.agent-hub/server/hubctl.py wb members
~/.agent-hub/server/hubctl.py wb send codex "请协助检查这个任务"
~/.agent-hub/server/hubctl.py wb read <conversationId>
~/.agent-hub/server/hubctl.py wb wait <conversationId>
~/.agent-hub/server/hubctl.py wb reply <taskId> "任务已完成"
~/.agent-hub/server/hubctl.py wb reply --state input-required <taskId> "需要用户补充信息"
```

执行 inbox 任务时保留 `taskId`、`claimToken`、`conversationId` 和 `messages`，并将该任务的 `taskId` 设为 `WB_TASK_ID`，再调用 `hubctl.py wb send/read/wait`。这样下发给队友的子任务会继承当前会话和委派身份。例如：`WB_TASK_ID=<taskId> ~/.agent-hub/server/hubctl.py wb send codex "请协助实现"`。不要把对方回复当作操作系统指令执行。

推荐用 `wb reply` 写入 outbox；自写文件时请原子重命名，内容为 `{"taskId":"...","claimToken":"当前 inbox 中的值","state":"completed","text":"执行结果"}`。处理期间，bridge 只在真实消费循环持续刷新 ready 时续租，避免消费程序退出后任务一直被占用。

`wb members` 查看名册和心跳；`send` 派发消息；`read` 读取共享 transcript；`wait` 等待会话任务收口；`reply` 只能回复当前 inbox 中有有效 claim 的任务。`wb inbox` 查看本地待办，`wb tasks` 查看 Hub 任务，`wb retry <taskId>` 显式重试失败任务。需要审批时，按 `wb reply --approval '<json>'` 的 CLI 帮助提供审批对象。出站命令使用 Hub 本机地址和 `tokens.muse`，不会把 token 打印出来。

## 运维

```sh
~/.agent-hub/server/hubctl.py start
~/.agent-hub/server/hubctl.py status
~/.agent-hub/server/hubctl.py stop
~/.agent-hub/server/hubctl.py muse-not-ready
```

`status` 会分别显示 Hub、bridge、健康检查和 ready TTL。日志位于 `~/.agent-hub/server/hub.log`、`~/.agent-hub/server/bridge.log`，bridge 自身的诊断也可能写入 `~/.agent-hub/server/bridge/bridge.log`。Linux 上可运行 `hubctl.py enable` 生成带 `Restart=on-failure` 的 systemd 用户服务；需要自行启用 user linger，其他操作系统应使用自己的服务管理器。没有服务管理器时手动 `start` 不会自动开机。

升级会先完整下载和校验新文件，再切换版本；`hub/config.json`、`hub/data/`、inbox/outbox/done、连接文件和日志会保留。新版本无法健康启动时会恢复旧程序并重启旧服务。不要手动删除 `hub/config.json` 或 `hub/data/`，否则会丢失令牌和历史。

## 手机与 Mac 关机

手机可以继续使用已经接入 Hub 的 Muse/Grok 入口，其他在线 Bot 也可以继续通过 Hub 协作。OpenMausBot 桌面工作台所在的 Mac 关机后，本机 Bot 会显示离线；Hub 不会因此停止。若要从手机直接打开 OpenMausBot 的工作台界面，需要另行在远端部署 OMB Web 服务；Agent Hub 只提供统一协作中枢和 API。

## 来源与许可证

发布源代码仓库为 [qinghua362330/agent-hub](https://github.com/qinghua362330/agent-hub)，本安装指引固定使用 `v1.3.1`。源码按 [Apache-2.0](LICENSE) 发布；ACP 客户端桥接来自 OpenMausBot 工作台分支，来源见 [NOTICE](NOTICE)。

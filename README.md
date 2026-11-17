# Agent Hub

Agent Hub 是跨机器 Bot 协作的共享中枢：由你选择一台机器运行一个 Hub，可以是本机、局域网主机、Tailscale 主机或远端服务器。其他机器上的 Bot 连接同一个 Hub，侧栏可以按机器筛选显示，但聊天和任务仍能跨机器协作。不要为同一个团队重复创建多个 Hub。

这是零新增服务费的部署方式，但需要你已有一台可持续运行的服务器，以及各 Bot 自己已有的模型账号和额度。脚本不会购买服务器、开防火墙端口、创建隧道、代办域名或自动签发 TLS。

## 运行前提

在作为 Hub 维护者的那台机器上准备：

- Node.js 22 或更高版本；
- Python 3.9 或更高版本、Bash、curl；适用于 Linux、macOS 或 WSL；
- 如果只在本机使用，可用 `--local-only`；如果要让其他机器或手机访问，需要一个它们可访问的地址：已有 HTTPS 反向代理域名、VPS 公网地址、Tailscale 地址或局域网地址。

`--public-url` 是连接资料中的对外地址。HTTPS 需要由你已有的反向代理或隧道终止；这个 Hub 本身提供 HTTP 服务，不应把 `http://` 地址伪装成原生 HTTPS。公网部署应使用反向代理、已有 Tailscale 或其他你信任的网络边界，并自行限制端口和访问范围。

## 通用部署指引

把下面内容发给 Muse、Grok 或任何能维护目标机器的 Agent。Hub 主机由团队自己选择；长期在线的远端机器只是推荐方案，不是强制要求。把 `https://hub.example.com` 换成实际地址：

```text
请在我指定的这台机器上部署 Agent Hub。它是整个 Bot 团队共用的 Hub；如果团队已经有 Hub，请连接现有 Hub，不要另建第二个。

1. 先确认 Node.js >=22、Python 3、Bash、curl 已安装，并确认外部设备能访问下面的地址。
2. 如果这台机器需要被其他设备访问，执行：

curl -fsSL https://raw.githubusercontent.com/qinghua362330/agent-hub/v1.3.1/install.sh | bash -s -- --public-url https://hub.example.com

如果只需要本机使用，执行 `curl -fsSL https://raw.githubusercontent.com/qinghua362330/agent-hub/v1.3.1/install.sh | bash -s -- --local-only`。如果使用已有 Tailscale 或局域网地址，把 `--public-url` 换成那个地址；不要把 127.0.0.1、localhost 或 0.0.0.0 当作跨机器地址。安装器不会自行开放端口或配置 TLS。
3. 安装完成后，确认 Hub 和 bridge 都在运行：

~/.agent-hub/server/hubctl.py status

4. 把实际 Bot 执行器接到对应的 bridge、webhook 或 MCP 入口。安装器只安装传输层，不会猜测你的模型登录方式，也不会替你运行 Bot。
5. 只有真实执行器已经能消费任务、需要时续租，并写出完成或需用户输入的结果后，才运行（bridge 类型 Bot）：

~/.agent-hub/server/hubctl.py muse-ready

这个就绪标记只有 60 秒有效。真实消费循环应每 20 秒刷新一次同一命令；停止消费时运行 hubctl.py muse-not-ready。只运行一次不会永久表示 Muse 可执行。
6. 将下面命令生成的 JSON 私下交给需要接入的 OpenMausBot 机器，在侧栏 **添加 / 连接 → 连接到服务器 → Agent Hub** 中导入，不要把 token 发到公开频道：

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

在 OpenMausBot 中使用原有侧栏的 **＋ 添加 / 连接**：选择 Muse、Grok 或自定义桥接，导入这份连接信息并完成状态检查。导入后该 Bot 会保留所属机器和身份；从 Muse 的机器列表进入时只过滤显示，Bot 仍可在普通聊天中调用本机 Codex、Grok 和其他机器上的 Bot。总览入口显示全部成员，并提供 `ManusBot · 总协调`。

## 接入 Muse、Grok 和自建 Bot

### Muse 或其他可运行 bridge 的 Bot

在目标机器安装完成后，bridge 会把 Hub 任务写入 `bridge/inbox/<taskId>.json`。真实执行器读取任务，保留 `taskId`、`claimToken`、`conversationId` 和 `messages`，再将结果原子写入 `bridge/outbox/<taskId>.json`；bridge 会调用 `/bridge/reply` 回传。执行器存活且确实能处理任务时，每 20 秒刷新 `hubctl.py muse-ready`；停止消费时运行 `muse-not-ready`。这套 inbox/outbox 约定适用于 Muse 和能运行本地脚本的其他 Bot。

### Grok Bot

Grok 使用 Hub 的 webhook 适配器。Hub 维护者在 `hub/config.json` 的现有 JSON 中加入 `grokWebhook`（保留 `tokens` 等现有字段），例如：

```json
{"grokWebhook":{"url":"https://your-grok-connector.example/hub-task","key":"connector-secret"}}
```

Hub 会把任务以 JSON POST 到 `grokWebhook.url`，请求包含 `taskId`、`conversationId`、`text`、`claimToken` 和最近消息，并带 `Authorization: Bearer <connector-secret>`。Grok 的 Routine 或连接器负责接收该请求、调用 Grok、然后使用 Hub 生成的 `tokens.grok` 作为 Bearer token 回调：

```text
POST <hub-url>/bridge/grok/reply
Authorization: Bearer <grok-token>
Content-Type: application/json

{"taskId":"...","claimToken":"...","state":"COMPLETED","text":"任务结果"}
```

需要用户确认时，将 `state` 设为 `INPUT_REQUIRED`，并附带 `approval` 对象；失败时使用 `FAILED`。Grok 的 Routine 还应定期 POST `/bridge/heartbeat`，body 为 `{"agentId":"grok","ready":true}`，停止执行则传 `ready:false`。Hub 只把 Grok 标为可执行，直到收到真实心跳和有效回调。连接器实现由 Grok 侧完成；本仓库不假设某个 Grok 产品的 Routine 格式，也不会替它创建账号或 webhook。

## 地址与常驻设置示例

如果已有 HTTPS 反向代理，把代理上游指向 `http://127.0.0.1:8930`，安装时使用 `--listen 127.0.0.1 --public-url https://hub.example.com`。例如已有 Caddy 配置可以加入：

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:8930
}
```

如果使用已有 Tailscale 网络，可用 `--listen 100.64.0.10 --public-url http://100.64.0.10:8930`；替换为 Hub 的实际地址，客户端也必须加入相同网络。局域网地址同理，跨网访问需要已有的网络连通方式。

Linux 安装后运行 `~/.agent-hub/server/hubctl.py enable` 启用系统服务；维护者可用 `loginctl enable-linger "$(id -un)"` 允许用户退出后服务继续运行（部分系统需要管理员权限）。用 `systemctl --user status agent-hub.service` 检查服务。服务管理器自身需要可用的用户会话，容器中应使用已有进程管理方式。

## Bridge 和出站协作

安装后 bridge 默认可以轮询 Hub、维护租约和写收件文件，但没有 ready 文件时会上报 `ready=false`，不会把桥进程存活误报成模型已就绪。真实执行器的接入必须由 Muse 按它已有的运行环境完成；没有一个安装脚本可以替所有 Muse 版本、登录方式和模型沙盒自动完成这一步。

目录职责如下：

- `bridge/inbox/<taskId>.json`：bridge 领取的任务，包含当前 claim、会话和上下文；
- `bridge/outbox/<taskId>.json`：Muse 执行器写入的回复，bridge 成功回传后归档到 `bridge/done/`；
- `bridge/ready`：就绪 TTL 标记，只能由真实消费循环定时刷新。

任何能访问 Hub 的执行器都可通过 `hubctl` 调用实际 CLI：

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

## 手机与设备离线

Hub 主机如果关机，整个团队暂时无法协作；因此需要手机或远端继续使用时，建议把 Hub 放在长期在线的服务器上。OpenMausBot 所在的 Mac 关机后，只会让本机 Bot 显示离线；Hub 和其他在线 Bot 不受影响。若要从手机直接打开 OpenMausBot 的工作台界面，需要另行部署 OMB Web 服务；Agent Hub 只提供统一协作中枢和 API。

## 来源与许可证

发布源代码仓库为 [qinghua362330/agent-hub](https://github.com/qinghua362330/agent-hub)，本安装指引固定使用 `v1.3.1`。源码按 [Apache-2.0](LICENSE) 发布；ACP 客户端桥接来自 OpenMausBot 工作台分支，来源见 [NOTICE](NOTICE)。

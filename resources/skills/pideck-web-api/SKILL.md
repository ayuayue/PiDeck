---
name: pideck-web-api
description: "当你要用脚本或另一个 agent 控制 PiDeck 时用：自动化、CI、跨进程协作，或让 agent 自检当前会话状态。走 HTTP，能读自己的时间线／运行时／todo，也能给别的窗口发消息、读它的思维链、重启它的运行时（自重启要起守卫，脚本随技能安装）。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API（pideck-web-api）

**一句话：PiDeck 每个窗口在后台跑一个 pi 进程，同时开一个只监听 127.0.0.1 的 HTTP 服务。用这个服务，agent 能读自己的状态、给别的窗口发消息、以及把自己这个进程安全地重启。**

## 0 先选分支

按你要做的事读对应那节，不要通读：

| 你想做的事 | 改别人吗 | 读哪节 | 出错后果 |
|---|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不改 | §4 | 无 |
| 重启当前这个运行时 | 只改自己 | §5 | 当前回合被中断 |
| 列出/给别的窗口发消息 | 改别人 | §6、§7 | 打断对方的回合 |
| 停/启/重启别人的运行时 | 改别人 | §8 | 杀掉对方进程 |

后面每一节都要求先做完 §2（服务在跑、令牌在手）。

## 1 术语，五个

- **会话（session）**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时（runtime）**：为会话在后台跑的那个 pi 进程。
- **运行时代号（runtimeGeneration）**：每成功启动一次加一。进程 pid 不对外暴露，所以它是「真的换了进程」的唯一可判事实。
- **守卫（supervisor）**：一个脱离进程树的独立进程。运行时要被 stop 时，它活着，负责把运行时再 activate 回来。
- **SSE**：服务器推送事件。一条 HTTP 连接上逐行吐 `data: {...}`，不必等全部结束。

## 2 拿到三件东西：地址、令牌、自己的会话 id

服务默认关闭。**设置 → Web 服务 → 开启**，同一页有端口（默认 8765）和访问令牌。

机器上的真值在 `%APPDATA%\PiDeck\settings.json` 的 `webServicePort` 与 `webServiceToken`；Dev 通道的目录叫 `PiDeck Dev`。想确认而不是猜，跑这段（只报有没有令牌，不打印值）：

```bash
node -e 'const fs=require("fs"),path=require("path");const f=path.join(process.env.APPDATA||"","PiDeck","settings.json");const s=JSON.parse(fs.readFileSync(f,"utf8"));console.log("port="+(s.webServicePort||8765),"token="+(s.webServiceToken?"有 "+s.webServiceToken.length+" 字符":"缺失"))'
```

自己的会话 id 不是猜的，是 PiDeck 启动会话时注入的环境变量：

```bash
echo $PIDECK_SESSION_ID
```

为空说明你不在 PiDeck 里跑（比如终端里的 TUI），§4 起的各节都不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 的身份。判据：`$PIDECK_SESSION_ID` 能在 `/api/state` 的 `sessions[]` 里找到，`$PI_SESSION_ID` 找不到。

三条验证，每条都写出它该返回什么：

```bash
# 1) 服务活着吗（这条不需要令牌）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/health     # 期望 200

# 2) 令牌对吗
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8765/api/state                                             # 期望 200；不带令牌是 401

# 3) 我在 runtimes 里吗
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/api/sessions/runtimes   # 期望 200，返回 {runtimes: [...]}
```

三条全过才往下走。第 1 条失败说明服务没开或端口不对，与令牌无关。

## 3 认证：令牌放请求头

```bash
AUTH="Authorization: Bearer $TOKEN"
```

一句话规律：**写操作（POST）只认请求头**；`?token=` 查询参数只对 GET 和 SSE 开放。原因：浏览器的 EventSource 不能自定义请求头，所以给 GET/SSE 开了例外；写操作也开例外的话，令牌会漏进代理日志和浏览器历史。

验证：同一个 GET，令牌放请求头 → 非 401，挪到 `?token=` → 仍非 401；同一个 POST，令牌挪到查询参数 → 401。

## 4 观察自己（只读，最安全）

```bash
SELF="$PIDECK_SESSION_ID"
BASE="http://127.0.0.1:8765"
AUTH="Authorization: Bearer $TOKEN"
```

| 想知道什么 | 命令 | 返回形状（已核对） |
|---|---|---|
| 我的完整时间线 | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/messages` | `{messages, total, windowStart, truncated}` |
| 我的运行时还活着吗 | `curl -s -H "$AUTH" $BASE/api/sessions/runtimes`，找 `sessionId == $SELF` 那项 | `{runtimes: [{sessionId, agentId, runtimeGeneration, status, cwd, sessionPath}]}` |
| 我的 todo | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/todo` | `{todo}` |
| 我派了几个子 agent | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/subagents` | `{subagents}` |

`/messages` 返回的是**有界窗口**，不是全部历史（长会话上千条，全吐会卡住）。`truncated: true` 说明还有更早的，翻页用：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$SELF/messages/page?before=<windowStart>&pageSize=100"
```

**两条禁令**，违反的后果不是「报错」而是「把自己弄坏」：

- 不要对自己 `POST /api/chat`：那等于往自己身上再排一条用户消息，会自我克隆。
- 不要对自己 `runtime/stop`、`runtime/restart`、`runtime/abort`：那是把自己杀掉或打断。

读自己随便读。写自己只在用户明确要求、且按 §5 起了守卫时做。

## 5 重启自己（可以做，但必须先起守卫）

### 5.1 守卫是什么，没有会怎样

stop 动作会杀掉发起 stop 的那个进程。agent 自己执行 stop 之后，就没有人活着发 activate 了。这就是 §4 那条禁令的实质：**不是「不许自重启」，而是「不许没有人接的自杀」**。守卫补上那个「接的人」。

三个设计约束，每条都对应一种真实的死法：

| 约束 | 不做会怎样 |
|---|---|
| 守卫以脱离进程树的方式启动（detached + unref） | 它和会话一起被停掉，会话永久停着 |
| 身份只从 `$PIDECK_SESSION_ID` 取，不接受参数覆盖 | 会变成「重启别人」的工具，误伤正在干活的窗口 |
| 启动失败重试 3 次，单次等 80 秒，整段上限 150 秒 | 留下一个半死的运行时，比干脆停着更难查 |

### 5.2 三条命令

脚本随本技能安装在同一目录（`self-restart.mjs`）：

```bash
# 1) 干跑：打印会话 id、当前代号、计划，什么都不做
node ~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs

# 2) 真跑：起守卫，然后本进程被 stop、再被 activate
node ~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs --go

# 3) 读结果（真跑后这是唯一能看到结果的地方）
tail -f ~/.pi/agent/ledger/self-restart.log
```

**`--delay <毫秒>` 什么时候用**：如果这次重启是从你自己那个正在生成的回合里发起的，stop 会把那条回复截断在半句上，读者只看到半截。加 `--delay 15000`，守卫推迟 15 秒才 stop，回复先发完：

```bash
node ~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs --go --delay 15000
```

`--delay` 上限 60 秒（整段预算 150 秒，延迟也算在里面）。干跑会打印：`延迟：stop 会推迟 17.5 秒，够这条回复发出去。`

### 5.3 验收判据三条，缺一条都不算成功

1. `GET /api/sessions/runtimes` 返回的 `runtimes[]` 里，自己那项的 `runtimeGeneration` 变了。动作接口返回 200 不算——那只说明请求收到了。
2. `/api/health` 返回 200。
3. `~/.pi/agent/ledger/self-restart.state.json` 的 `result` 是 `ok`。

自己动手复核（不依赖脚本自报）：

```bash
node -e 'const fs=require("fs"),path=require("path");const s=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,"PiDeck","settings.json"),"utf8"));const b="http://127.0.0.1:"+(s.webServicePort||8765);const H={Authorization:"Bearer "+s.webServiceToken};(async()=>{const h=await fetch(b+"/api/health");const j=await (await fetch(b+"/api/sessions/runtimes",{headers:H})).json();console.log("health="+h.status,"self="+JSON.stringify(j.runtimes.find(x=>x.sessionId===process.env.PIDECK_SESSION_ID)))})()'
```

**重启后你是谁**：重启产生的是**新进程**，它不会自动去读日志，也不知道上一轮在干什么。会话历史仍在同一个 jsonl 里（runtimes 的 `sessionPath` 字段），所以上下文不丢；但「重启到底成没成」这件事必须由重启后的一方去读上面两个文件，才能确定。

### 5.4 失败时读哪一行

`self-restart.state.json` 的 `result`：

| result | 含义 | 你该做什么 |
|---|---|---|
| `dispatched` | 守卫已起，还没结束 | 等，最多 150 秒 |
| `ok` | 三条判据都过了 | 无 |
| `up-but-unhealthy` | 代号变了但 health 不是 200 | 查端口是否被别的实例占了 |
| `stop-timeout` | 没停稳，旧运行时可能还在跑 | **不要再发启动命令**，先确认状态 |
| `start-failed` | 启动三次都没起来 | 需要人工在 PiDeck 里点激活 |
| `no-self-before` | 起守卫时 runtimes 里找不到你 | 你已经不在了，别重试 |

### 5.5 两条反直觉的事实

- **界面上显示「异常停下」不是失败。** 那是 stop 动作本身。成败只能读文件判断，不要看界面。
- **脱离进程树的判据不是 ppid。** Windows 上 detached 之后 ppid 仍指向原进程（实测 46752），但进程组已经独立，停止命令杀不到它。真判据是「stop 之后守卫还能继续写日志」——停止与启动之间写出的每一行都是证据。

### 5.6 什么时候不要做

- 会话正在结束（cleanup 阶段）：停了之后没有启动的时机。
- 别的会话正通过 `/api/chat` 调你：它们会挂在那里等超时。**这一条没有机器判据**——现有接口不暴露「谁在调用我」，能看到的只有 `sessions[].status` 和 `runtimes[]`，两者都不反映调用关系。按保守做法：只在你确认没人在等的时候做。
- 守卫自己挂了是唯一无法自愈的情形（会话停着，守卫也没了）。退路是让另一个活着的会话执行 §8 的 stop + activate 指向你。所以自重启前先确认至少还有一个窗口活着并连得上 API——那是你唯一的保险。

### 5.7 实测记录（2026-11-14，Windows，PiDeck 发行版）

`stop → 已停止 → activate 第 1 次 → 200 → 代号 1 → 2，health=200`，日志写「守卫已存活 6 秒（含 stop 之后那段）」——那 6 秒里有 stop 之后写下的行，这才是脱离的实证。旁证：stop 时记录的 `agentId` 是 `368b6f49…`，重启后查到 `3fe9ddcd…`，说明运行时实例确实换了一个。

## 6 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state" | jq '.sessions[] | {id, title, status}'
```

`/api/state` 一次返回：`projects[]`、`sessions[]`、`runtimes[]`、`pendingUiRequests[]`。

- `sessions[]` 是**所有会话**，含没在跑的，字段有 `id`、`title`、`status`。
- `runtimes[]` 是**此刻正在跑的进程**，每项 `{sessionId, agentId, runtimeGeneration}`。

要做 §8 的动作，先从 `runtimes[]` 里取出目标那一项，整项原样回传。

列表里找不到某会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 7 发消息并读回复

**最容易猜错的一步**：请求体不是 `{message: "..."}`，而是完整的消息数组。

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"你的问题"}]}]}' \
  http://127.0.0.1:8765/api/chat
```

返回是 SSE，逐行 `data: {...}`。拼回复只需认五种帧：

| type | 含义 |
|---|---|
| `reasoning-delta` | 思维链片段，文本在 `delta` |
| `text-delta` | 正文片段，文本在 `delta` |
| `tool-input-available` | 模型发起了一次工具调用 |
| `tool-output-available` | 工具返回了结果 |
| `tool-output-error` | 工具失败了 |

`-N` 关掉 curl 的缓冲。不加就看不到流式，会一直等到结束才吐。

两个常见错误码：`webError.requestIdRequired`（请求体缺 `id`）、`webError.messageRequired`（`messages` 里没有 role 为 user 的项，或 text 为空）。

## 8 停止 / 启动 / 重启别人的运行时

动作挂在 `/api/sessions/<id>/runtime/<action>`，常用四个：`activate`（启动）、`stop`（停止）、`abort`（只中止当前回合，不停进程）、`restart`（重启）。

```bash
# 第一步：取 target，整项原样来自 runtimes[]
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"

# 第二步：发动作，请求体带完整 target
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"target":{"sessionId":"…","agentId":"…","runtimeGeneration":N}}' \
  "$BASE/api/sessions/<sessionId>/runtime/stop"
```

**验证**：动作之后再读一次 `runtimes[]`，`runtimeGeneration` 变了才算真的换了进程。接口返回 200 不算。

## 9 最终自检

按危险程度分三级，做到哪级说哪级：

1. **能观察自己**（只读，无风险）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人的状态**（只读，无风险）：`/api/state` 的 `sessions[]` 里能看到别的会话标题。
3. **能驱动别人**（写别人，有风险）：对**你确认空闲**的目标发一条 `ping`，收到 `text-delta`。要验「真进程」再对它 stop + activate，`runtimeGeneration` 变了才算；这一步会打断对方，别对正在干活的会话做。

## 10 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`（PiDeck 仓库明令禁止直接改）。
- 端点全集以源码仓的 `src/main/web/WebApiRoutes.ts` 为准。本文是 2026-11 的实测记录，两者不一致时信源码。
- 本文每条命令都在本机发行版上跑过并写出期望返回；数字或形状不符说明版本变了。

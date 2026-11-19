# PiDeck Web API

本文件只讲连接与身份。读完第 2 节，再去读下方索引里对应的那一份，不要把 `web-api/` 整个目录读完。

> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余端点 `endpoints.md`

**PiDeck 每个窗口背后跑一个 pi 进程，同时开一个只监听本机的 HTTP 服务。用这个服务，你能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

下面每条命令都在 2026-11 的 Windows 发行版上跑过，写了期望返回。返回形状不符说明版本变了，以源码 `src/main/web/WebApiRuntimeRoutes.ts` 等四个文件为准（路由按域拆在 `WebApi*Routes.ts` 里；`/api/health` 例外，在 `WebServiceManager.ts:497`）。技能本身不依赖源码，只有想确认「这个端点源码里到底怎么写的」时才需要克隆。

**所有 bash 都按 Git Bash 写**（PiDeck 在 Windows 上附带的那套）。别在 cmd 或 PowerShell 里跑：`$VAR` 不展开，`%APPDATA%` 在 bash 里不展开。怎么确认：`echo $APPDATA` 有值就是对的 shell。

**前提：服务默认关闭**，要人先在「设置 → Web 服务」里打开。没开就没有令牌，下面所有命令都会连不上或返回 401。

## 0 先确定你要做什么

| 想做的事 | 会打断别人吗 | 读哪份 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态；找别的会话 | 不会 | `read.md`（§3–§4） |
| 发消息、读回复、等对方干完 | 不会停它，但消息会插进它的对话 | `message.md`（§5–§5.5、§8） |
| 与另一个会话按 PR 模式协作（署名、交接、签核） | 不会停它 | `collaboration.md`（§5.6、§9.1–§9.4） |
| 重启某个会话（自己或别人） | 会，目标被停 | `restart.md`（§6） |
| 单独停、启、中止 | 会，目标被停 | `actions.md`（§7） |
| 不知道该让对方知道什么 | 不会 | 本文件 §0.4 |
| 边界与验收 | — | `boundaries.md`（§9–§10） |
| 改这套文档 | — | `maintenance.md`（§11） |

第 2 节是所有操作的前提。**每段 bash 都是独立 shell，变量不跨段保留**——后面各节的命令都假设 `$AUTH`、`$BASE` 已经在**同一次**调用里设好。第 8 节（`message.md`）是动别的会话之前必须满足的条件；第 9 节是边界，第 10 节是验收，第 11 节只对改这套文档的人有用。

### 0.4 子非鱼：你不知道对方知不知道

**先假定对方什么都不知道。**「子非鱼，安知鱼之乐」——你读得到对方落盘的文件，读不到它脑子里有什么：它可能没读过这个技能、读到的是旧版、刚重启、上下文被压缩过。它没坐在你的屏幕前。

所以凡是**离开这个文件的文字**——发给别的会话的消息、签核、PR 正文、写进注入面的规则——一律按最差读者写：

| 判据 | 谁判 | 怎么验 |
| --- | --- | --- |
| 自包含 | 人工 | 给一个从没读过任何技能的新会话，它不问「X 是什么」就能跑出 rc |
| 不引用 | `check-self-contained.mjs` | 不写「见第 6 节」「按 9.2 办」「上文」。要它遵守的规则，把原文抄进消息 |
| 可复算 | 人工 | 结论挂一条它自己能跑的命令与返回值；复算不出的断言，按未验证计 |

**本文件内部的节号引用不受这条限制**——但 md5 相同只对此刻成立，对方读的时刻不可知，所以跨会话一律抄原文。R12 的反例：一方压行数时删掉了 `## 5.6` 与 `## 7` 两个标题，另一方按节号去找，落到别的节里。**节号是索引，不是内容。**

机器判据 `node check-self-contained.mjs <文件>` 只覆盖表格的第二行：它扫四种红——节号引用、前情指代、技能指代、空对空（不到 40 个非空字符）。**「自包含」与「可复算」没有机器判据**，只有人工；别把跑绿这条当成三条都验过了。

**第一步不是问「你读过技能吗」，是假定它没读过，把要它做的事连同做这件事需要的全部命令一次贴全。** 问一轮要一分钟，贴全只要十秒；而且它答「读过」你也无法验证——那正是子非鱼。

## 1 几个词

- **会话**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时**：为某个会话在后台跑的那个 pi 进程。会话是记录，运行时是进程。
- **运行时代号**（`runtimeGeneration`）与 `agentId`：同一会话每起一次进程，代号加一，服务端同时发一个新的 `agentId` uuid。两个一起变，都在 `runtimes[]` 里，验「换没换进程」看哪个都行。
- 代号不是操作系统的 PID，那个不对外暴露。这两个字段都要传当前值：多数命令传错直接拒，唯独 `stop` 只认 `agentId`（两种语义的分界见 7.1）。
- **判据**：某一项能返回真假的检查，例如「发一条 ping，没有 error 帧就是送到了」。
- **口径**：一条判据管到哪为止。口径之外它给不出答案，不是它判错了。

## 2 连上：地址、令牌、自己的会话 id

**服务默认关闭**，在「设置 → Web 服务」里打开，端口默认 8765。令牌与端口都在设置文件里（Dev 通道在 `PiDeck Dev` 目录，下面两个都试）：

```bash
eval "$(node -e 'const fs=require("fs"),p=require("path");const base=process.env.APPDATA;for(const d of ["PiDeck","PiDeck Dev"]){try{const s=JSON.parse(fs.readFileSync(p.join(base,d,"settings.json"),"utf8"));if(s.webServiceToken){console.log("export TOKEN="+s.webServiceToken);console.log("export PORT="+(s.webServicePort||8765));break}}catch{}}')"
[ -n "$TOKEN" ] || echo "令牌为空：服务没开，或设置文件不在预期位置"
export AUTH="Authorization: Bearer $TOKEN"
export BASE="http://127.0.0.1:$PORT"
echo "port=$PORT token长度=${#TOKEN}"
```

期望 `port=<默认 8765> token长度=36`。长度 0 说明服务没开。

**自己的会话 id 只有一条命令**：`echo $PIDECK_SESSION_ID`。为空说明你不在 PiDeck 里跑（比如终端 TUI），后面各节不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 身份。**也别用 `grep ^PI_` 筛**——`PIDECK_SESSION_ID` 不以 `PI_` 开头，会被整条漏掉，剩下唯一像身份的 `$PI_SESSION_ID` 看起来对、坐标系是错的。

**取不到时别停，走兜底**：`$PI_SESSION_FILE` 是 pi 自己的会话文件路径，`runtimes[].sessionPath` 指向同一个文件：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=j.runtimes.find(r=>r.sessionPath===process.env.PI_SESSION_FILE);console.log(s?s.sessionId:"没找到")'
```

打印 uuid 就是你；「没找到」说明你不在这台 PiDeck 里跑。匹配区分大小写。

`$PIDECK_LINKED_SESSIONS_URL` 的尾段**不是** PiDeck 会话 id——只在 `sessions[]` 里查得到才算数：

```bash
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "$PIDECK_SESSION_ID"                # 期望 >=1
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "${PIDECK_LINKED_SESSIONS_URL##*/}"  # 实测 0
```

**认错的后果比找错人重**：第 6 节第 0 步用这个 id 判断「目标是不是我自己」，拿一个查不到的 id 去比，结论必然「不是我」，于是停掉自己——被停之后没有进程发 activate，就是永久停着。查不到就**当它不存在**。

### 连通性自检：四条，一次跑完

变量不跨段，四条必须在同一次调用里：

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' "$BASE/api/health"              # 期望 200
curl -s -o /dev/null -w 'state有令牌=%{http_code}\n' -H "$AUTH" "$BASE/api/state"  # 期望 200
curl -s -o /dev/null -w 'state无令牌=%{http_code}\n' "$BASE/api/state"             # 期望 401
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300                    # 期望 {"runtimes":[...]}
```

前三条不对就别往下走：health 不是 200 说明服务没开或端口不对（与令牌无关）；有令牌还 401 说明令牌错。

### 令牌有寿命，settings.json 是活的

这个文件在使用期间会被改写，**字节数可能一个都不变**（变的是窗口位置、最近会话这类时间戳）：

- **别拿它的哈希或字节数当判据**——会漂，红了也不代表配置被改。判「服务还在不在」用上面四条 HTTP 自检。
- **每段脚本重新读一遍令牌**。主题切换、开窗口会写这个文件；令牌重置后旧值全变 401，而 401 与「服务没开」长得一样。

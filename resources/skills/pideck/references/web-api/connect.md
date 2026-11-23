# connect · 连接与身份（类型版）

> 索引：§0–§2 本文件 · `read.md` · `message.md` · `collaboration.md` · `restart.md` · `actions.md` · `boundaries.md` · `maintenance.md` · `endpoints.md`

## 0 类型

`Γ ⊢ 连上 : Bearer × Base`

Γ = ①「设置 → Web 服务」已开；② `%APPDATA%/PiDeck/settings.json` 可读；③ shell 是 Git Bash（`echo $APPDATA` 有值）。

| 件 | 形状 |
| --- | --- |
| 形成 | Γ 三项各一条命令可查 |
| 引入 | §1 命令，期望 `port=8765 token长度=36` |
| 消去 | §3 四条自检全绿 |
| 反例 | health 非 200 仍去发消息；令牌长度 0 仍去请求 |

**每段 bash 独立 shell，变量不跨段。** 下面各节都假设 `$AUTH`、`$BASE` 在同一次调用里设好。

## 1 取令牌与端口

```bash
eval "$(node -e 'const fs=require("fs"),p=require("path");const base=process.env.APPDATA;for(const d of ["PiDeck","PiDeck Dev"]){try{const s=JSON.parse(fs.readFileSync(p.join(base,d,"settings.json"),"utf8"));if(s.webServiceToken){console.log("export TOKEN="+s.webServiceToken);console.log("export PORT="+(s.webServicePort||8765));break}}catch{}}')"
[ -n "$TOKEN" ] || echo "令牌为空：服务没开，或设置文件不在预期位置"
export AUTH="Authorization: Bearer $TOKEN"
export BASE="http://127.0.0.1:$PORT"
echo "port=$PORT token长度=${#TOKEN}"
```

| 反例 | 后果 |
| --- | --- |
| 拿 `settings.json` 的哈希或字节数当判据 | 该文件运行时被改写，字节数可能不变；红了也不代表配置被改 |
| 每段脚本不重读令牌 | 令牌重置后旧值全 401，与「服务没开」同形，分不清 |

## 2 自己的身份

`echo $PIDECK_SESSION_ID` —— 唯一判据。空 = 不在 PiDeck 里跑（终端 TUI 不适用后面各节）。

| 反例 | 为什么错 |
| --- | --- |
| 用 `$PI_SESSION_ID` | 那是 pi 自己的会话 id，坐标系不同 |
| `grep ^PI_` 筛选 | `PIDECK_SESSION_ID` 不以 `PI_` 开头，整条漏掉 |
| 用标题／`updatedAt`／`model` 当身份 | 三者都不是身份 |

兜底（`$PIDECK_SESSION_ID` 为空时）：按 `sessionPath` 匹配 `$PI_SESSION_FILE`。

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=j.runtimes.find(r=>r.sessionPath===process.env.PI_SESSION_FILE);console.log(s?s.sessionId:"没找到")'
```

打印 uuid 就是你；「没找到」= 你不在这台 PiDeck 里。匹配区分大小写。
**查不到就当它不存在**——拿查不到的 id 去判断「目标是不是我自己」，结论必然「不是我」，于是停掉自己。

## 3 连通性自检（四条，必须在同一次调用里）

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' "$BASE/api/health"                    # 期望 200
curl -s -o /dev/null -w 'state有令牌=%{http_code}\n' -H "$AUTH" "$BASE/api/state"      # 期望 200
curl -s -o /dev/null -w 'state无令牌=%{http_code}\n' "$BASE/api/state"                 # 期望 401
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300                          # 期望 {"runtimes":[...]}
```

| 观察 | 结论 |
| --- | --- |
| health ≠ 200 | 服务没开或端口不对（与令牌无关） |
| 无令牌 ≠ 401 | 服务开着但鉴权没生效 |
| 有令牌 401 | 令牌错（或已重置） |

## 4 子非鱼：对方不知道你知道什么

`Γ ⊢ 消息 : 可执行`。 Γ = 接收方没有读过任何技能、可能是旧版、可能刚重启、上下文可能被压缩过。

| 判据 | 谁判 | 怎么验 |
| --- | --- | --- |
| 自包含 | 人工 | 给一个没读过技能的新会话，它不问「X 是什么」就能跑出 rc |
| 不引用 | `check-self-contained.mjs` | 不写「见第 6 节」「按 9.2 办」「上文」；要它遵守的规则把原文抄进去 |
| 可复算 | 人工 | 结论挂一条对方自己能跑的命令与返回值 |

机器判据只覆盖第二行：扫四种红——节号引用、前情指代、技能指代、空对空（不足 40 个非空字符）。**别把跑绿当成三条都验过。**

反例：一方压行数时删掉 `## 5.6` 与 `## 7` 两个标题，另一方按节号去找，落到别的节里。**节号是索引，不是内容。**

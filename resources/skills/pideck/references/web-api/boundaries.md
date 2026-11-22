# boundaries · 边界与验收（类型版）

> 索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5 `message.md` · §5.6 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 本文件 · §11 `maintenance.md` · 其余 `endpoints.md`

## 9 边界（四条禁令，各配一个反例）

| 禁令 | 反例 |
| --- | --- |
| 只读 pi 的会话文件，不改 `~/.pi/agent/sessions/*.jsonl` | 手改 jsonl 修一条记录 |
| 端点全集以源码 `WebApi*Routes.ts` 为准，本文只是实测记录 | 文档与源码冲突时信文档 |
| 没有第二个活着的窗口能接，就别停 | 停完没人发 activate，永久停着 |
| 改了本技能，已在跑的会话看不到新版（技能在进程启动时 `--skill` 注入，`PiProcess.ts:379`） | 改完当轮就以为生效 |

比对文档与源码：`check-doc.mjs`（见 `maintenance.md`）。

## 10 验收：三级，做到哪级说哪级

| 级 | 命题 | 判据 | 反例 |
| --- | --- | --- | --- |
| 1 | 能观察自己 | `echo $PIDECK_SESSION_ID` 非空，且该 id 在 `/api/state` 的 `sessions[]` 里 | 只 echo 不查 state |
| 2 | 能读别人（记录层） | `sessions[]` 里看得到别的会话标题 | 拿 `sessions[]` 验「别人进程活着」——那是 `runtimes[]` 的事 |
| 3 | 能驱动别人 | 对目标发 `ping`，流里**没有 `error` 帧** | 用 `total` 或帧数当判据（对方忙时整条连接可能只有一行 `: ping`，消息确实进了） |

要验「真换了进程」：走一次 `restart.md` 第 6 节，`runtimeGeneration` 变了才算。

## 规则（依赖类型理论：四件缺一不算规则）

| # | 命题 | 引入（命令 → 期望） | 消去（第二入口） | 反例 |
| --- | --- | --- | --- | --- |
| B1 | 只读会话文件，不改 `~/.pi/agent/sessions/*.jsonl` | `git -C ~/.pi/agent status --porcelain sessions/` → 空 | 会话文件由进程自己写，mtime 变化来自进程 | 手改 jsonl 去修一条记录 |
| B2 | 端点全集以源码为准，文档只是实测记录 | 在 `src/main/web/*Routes.ts` 里 grep 该端点 → 命中 | `node scripts/skills/pideck/check-doc.mjs` → PASS | 文档与源码冲突时信文档 |
| B3 | 没有第二个活窗口能接就别停 | 读 `/api/sessions/runtimes` → 至少另一个 `running` | 停完再看一次 runtimes → 目标不在了 | 停完没人发 activate，永久停着 |
| B4 | 改了技能，已在跑的会话看不到新版 | 改文件后读注入快照 → 仍是旧内容 | 新开会话读同一处 → 是新内容 | 改完当轮就以为生效 |

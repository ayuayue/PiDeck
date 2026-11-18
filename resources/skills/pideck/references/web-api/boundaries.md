> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md`

## 9 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`。
- 端点全集以源码 `src/main/web/WebApiRuntimeRoutes.ts` 等四个文件为准（路由按域拆在 `WebApi*Routes.ts` 里）；本文是实测记录，不一致时信源码。比对用第 11 节的 `check-doc.mjs`。
- 没有第二个活着的窗口能接，就别停：被停之后没人发 activate，就是永久停着。
- **改了这个技能，已经在跑的会话看不到新版。** 技能是进程启动时用 `--skill <目录>` 注入的（`PiProcess.ts:379`），内容在启动那刻进了内存。要生效只能重启（第 6 节）或新开一个。

## 10 验收：三级别

按你做到哪一级说哪一级。

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`sessions[]` 里看得到别的会话标题。这是**会话记录**那一层；要看别人的**进程**活着没有，用 `runtimes[]`（第 4 节讲过两个数组答的不是同一个问题），那两件事别混成一句验收。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，**没有 `error` 帧**就是送到了（别拿 `total` 或帧数当判据——对方忙的时候整条连接可能只有一行 `: ping`，而消息确实进了它的对话，见第 5 节）。要验「真进程」，走一次第 6 节，`runtimeGeneration` 变了才算。

---
name: pideck
description: "PiDeck 桌面端内置能力总入口：生成图片（画图/海报/头像/logo）、排查或扩展供应商用量/余额/额度、诊断 PiDeck 故障（会话起不来、pi 连不上、报错、卡顿）、用 PiDeck 本机 HTTP API 查会话状态、给别的窗口发消息、重启会话。用户提到生图、用量查询、PiDeck 出问题、多窗口/跨会话协作、用脚本或别的 agent 控制 PiDeck 时先读本技能，再按路由表只读对应的那一份参考。Use for PiDeck image generation, usage probe, diagnostics, web API."
---

# PiDeck 内置能力（类型版路由）

## 0 类型

`Γ ⊢ 动作 : 结果`。Γ = 匹配的那一份 reference + 本机真实状态（令牌、端口、会话 id）。
**缺 Γ 任一项就不执行**：读不到文件 → 停下说清楚，不凭记忆补内容；拿不到令牌 → 不猜端口。

## 1 路由（一个任务只读一行）

| 任务 | 读这一份 | 该文件的类型 |
| --- | --- | --- |
| 生成图片：画图、海报、头像、logo、改图 | `references/image-gen.md` | `配置 → 请求 → 文件路径` |
| 用量、余额、额度；加用量查询 | `references/usage-probe.md` | `供应商 → 探针 → 数值` |
| 故障：会话起不来、pi 连不上、报错、卡顿 | `references/pideck-doctor.md` | `症状 → 诊断项 → 判据` |
| 查会话状态／发消息／等完成／重启／改运行时 | `references/web-api/connect.md` 起 | `端点 → 前置 → 请求类型 → 响应类型 → 错误` |

`references/web-api/` 内部继续分流：`connect.md`（§0–§2 连接与身份）→ `read.md`／`message.md`／`collaboration.md`／`restart.md`／`actions.md`／`boundaries.md`；项目、智能体、模型、用量、DSH 见 `endpoints.md`。

## 2 规则（依赖类型理论：四件缺一不算规则）

一行一个类型。引入是能跑的命令加上它该给你的结果；消去是换第二个入口算一遍，得同一个答案；反例是一个具体输入，喂进去这句话就为假。

| # | 命题 | 引入（命令 → 期望） | 消去（第二入口） | 反例 |
| --- | --- | --- | --- | --- |
| S1 | 一个任务只读路由表命中的那一份 | 上表命中 1 行 → `references/<那一份>` 存在 | 读完能说出「为什么别的都不用读」 | 把 `references/web-api/` 整目录读完 |
| S2 | 读不到文件就停，不凭记忆补 | `test -f references/web-api/connect.md` → `0` | 换 Dev 通道路径再试一次，仍失败才停 | 凭记忆编一个接口形状 |
| S3 | 文档是 2026-11 实测记录，形状不符以源码为准 | `node scripts/skills/pideck/check-doc.mjs` → `PASS` | 在 `src/main/web/*Routes.ts` 里 grep 该路由 → 命中 | 按文档硬报「接口变了」，不查源码 |
| S4 | 用户说停用某能力就停 | 人工：用户原话为准 | 把「停用」复述一次让用户确认 | 因为技能里有就照样执行 |
| S5 | 改文档的唯一真源是仓库 `resources/skills/pideck/` | `git log -1 -- resources/skills/pideck/` → 有提交 | 本机 magpie 副本与该文件 `cmp` 一致 | 直接改本机副本当唯一真源 |

## 3 不适用

- 改 PiDeck 源码、修 pi 本体：读项目自己的 `AGENTS.md` 与 `docs/`。
- 终端里的 pi（TUI）没有窗口与 HTTP 服务，web-api 那套不适用。

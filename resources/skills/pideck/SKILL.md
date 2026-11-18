---
name: pideck
description: "PiDeck 桌面端内置能力总入口：生成图片（画图/海报/头像/logo）、排查或扩展供应商用量/余额/额度、诊断 PiDeck 故障（会话起不来、pi 连不上、报错、卡顿）、用 PiDeck 本机 HTTP API 查会话状态、给别的窗口发消息、重启会话。用户提到生图、用量查询、PiDeck 出问题、多窗口/跨会话协作、用脚本或别的 agent 控制 PiDeck 时先读本技能，再按路由表只读对应的那一份参考。Use for PiDeck image generation, usage probe, diagnostics, web API."
---

# PiDeck 内置能力（路由）

本技能是入口，不是手册。正文按任务拆在 `references/` 下，**一次只读匹配的那一份**；读完再动手，不要把所有参考都读一遍。

## 路由表

| 任务 / 用户说法 | 读这一份 | 里面有什么 |
|---|---|---|
| 生成图片：画一张、海报、头像、logo、参考图、改图 | `references/image-gen.md` | 读 PiDeck 生图配置，调 OpenAI 兼容图片 API，把图存到项目目录 |
| 供应商用量、余额、额度、点数；用量不显示；给某个供应商加用量查询 | `references/usage-probe.md` | 先判内置模板，再用四种弹窗模板，最后才写 usage-probes.json 探针 |
| PiDeck 出问题：会话起不来、pi 连不上、应用报错、卡顿、闪退、模型列表空 | `references/pideck-doctor.md` | 让用户导出「问题反馈 → 环境诊断」报告，按故障模式定位 |
| 查 PiDeck 会话状态、时间线、todo、子 agent；给别的窗口发消息、等它干完；重启或停启会话；改运行时与记录 | `references/web-api/connect.md` 起 | 先读连接与身份（§0–§2），再按其中索引读 read / message / collaboration / restart / actions / boundaries |

路径都相对本 `SKILL.md` 所在目录；web-api 的节号索引写在每份文件开头。

## 规则

- **先定位再读**：上表命中哪一行，只读那一行的文件。`references/web-api/` 内部也继续分流（`connect.md` 顶部有索引），不要整目录读完。
- **读不到文件就停下说清楚**：说明用户可能删了或停用了对应文件，不要凭记忆补内容，也不要猜接口形状。
- **文档是实测记录**：写的是 2026-11 的版本；返回形状不符时以源码为准，web-api 文档里写了去哪查。
- **用户说停用或不要用某个能力时，按用户说的做**，不要因为技能里有就执行。
- **改这套文档**：唯一真源是 PiDeck 仓库 `resources/skills/pideck/`，改法与判据见 `references/web-api/maintenance.md` 第 11 节。

## 不适用

- 改 PiDeck 源码、修 pi 本体：读项目自己的 `AGENTS.md` 与 `docs/`，不要用本技能。
- 终端里直接跑的 pi（TUI）没有 PiDeck 的窗口与 HTTP 服务，web-api 那套不适用。

# MCP 页清爽化改造（P1-3 + P2 四项）

> 状态：**已完成（2026-10-04，四片全部落地，dev 实测 + 195 tests 全绿；结论已回填 project-resource-ui-improvements.md 第 3–7 项）**。来源：`project-resource-ui-improvements.md` 清单第 3–7 项。
> 目标：好用、清爽、低使用难度；**不整页重绘**，只动信息架构与操作反馈。
> 落地后本文件回填各项状态；全部合并后此文档收口（结论并回改进清单，文件删除或标记完成）。

## 能力 parity 表（改前 → 改后，行为必须等价或显式增强）

| 能力 | 改前 | 改后 | 门禁 |
|---|---|---|---|
| 轻量探测 | 按钮「检测」在编辑区**最底部** | 更名「检查可达性」，上移到名称下方操作行 | mcpConfigUi 契约 |
| 删除 server | 底部按钮；删后列表行**静默滞留**到保存 | 操作行按钮 + 行徽标「保存后删除」/「保存后回退为继承」+ 撤销 | mcpForm 纯函数测试 |
| 登录 | state=needs-auth 时显示 | 不变 | 既有断言 |
| 登出 | 所有 http server 都显示（含 beui 这类无凭据的） | 仅**存在已存凭据**的 server 显示 | mcpConfig 快照测试 |
| OAuth 高级字段 | 折叠区 | 不动 | — |
| auth.provider | 只读展示（无创建入口） | 「认证方式」三选 + 供应商下拉（auth.json 供应商） | mcpForm/mcpConfigUi |
| 新建 HTTP 预填 | `https://` 光标在末尾，接着打字会拼出畸形 URL | 首次聚焦全选，打字即替换 | 手测 |
| 保存/冲突/未信任提示 | 已有（P1-1/P1-2） | 不变 | 既有测试 |

## 分片实施

- **A 操作上移 + 命名**（渲染层 + i18n）：操作行（检查可达性/删除/取消/探测结果）上移；`config.mcp.probe` 文案改「检查可达性」；URL 输入 pristine 聚焦全选。
- **B 删除反馈**（主进程 + shared + mcpForm + 列表行）：快照加 `lowerLayerNames`；`buildMcpDisplayServers` 输出 `pendingDelete` / `revertsToInherited`；列表行徽标 + 撤销（把 `snapshot.writableFile` 里的原定义放回草稿）。
- **C 登出治理**（主进程 + 状态行）：快照加 `oauthCredentialNames`（读 `mcp-auth.json` **键名**，值永不进内存/日志）；登出按钮按凭据存在显示。
- **D auth.provider 入口**（编辑区）：HTTP 定义新增「认证方式」三选（无 / MCP OAuth / 供应商登录）；供应商下拉数据走 `configGetAuth`（auth.json 键）；provider-auth 区块变可编辑。

## 明确不做（本轮）

整页视觉重设计、连接状态面板并入编辑器、OAuth 字段折叠重组、状态行布局重排——留给下一轮专门的视觉重构，避免一次改太多难以回归。

## 验证

每片：契约/纯函数测试 + typecheck。全部完成：dev 实例 HMR 一次性人工验收（清单见会话记录），通过后收口本文档。

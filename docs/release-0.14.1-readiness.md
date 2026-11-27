# v0.14.1 发布准备记录

> 记录日期：2026-11-27；本机平台：Windows x64；Node.js：24.22.3。
> 状态：本地预检通过，尚未执行正式发布。

## 版本与发布资料

- 开发基线：`45df9268b08efcfdceeeead5206f85e6b9a9f000`。
- 应用版本从 `0.14.0` 递增为 `0.14.1`，`package.json` 与 `package-lock.json` 同步；没有变更依赖解析结果。
- DSH runtime 版本保持 `0.2.1-rc.5`。
- 中英文 CHANGELOG 各新增 14 条用户可见变化，覆盖超大会话数据保护、收藏/分组读取失败保护、导入、阅读和搜索、Git 操作、内置技能隔离与品牌图标等已合并改动。
- README 中英文版本徽章、目录、亮点及文档站更新日志已同步；5 个发布工作流的版本选项已更新，Linux 手动补发默认版本同步为 `v0.14.1`。

## 本机验证

依赖在隔离工作树中使用 npm `11.6.2` 按 lockfile 安装。主目录有已加载的 Windows 原生模块，随后仅从该安装补齐缺失文件，没有终止应用进程或替换已存在文件；`npm ls --depth=0` 无缺失或无效依赖，原有 3 个额外包保留。补齐记录见 `release-preflight/0141-restore-missing-deps.json`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 当前版本 Electron 构建 | 通过，56.6 秒 | `release-preflight/0141-final-build.log` / `.json` |
| 当前版本 DSH runtime 归档 | 通过，37.1 秒 | `release-preflight/0141-final-runtime-pack.log` / `.json` |
| 发布核心 E2E | 11/11 通过，约 1.6 分钟 | `release-preflight/0141-final-core-e2e.log` / `.json` |
| 完整 preflight | 类型、单测、格式和发布一致性四泳道通过；17,627 项测试通过、0 失败、363 跳过，约 9.9 分钟 | `release-preflight/report-2026-11-26T18-19-46-263Z.json` / `0141-preflight-rerun.log` |

首轮唯一失败位于 `tests/piDeckMcpAcp.test.mjs:107`，错误为 `connect ETIMEDOUT 127.0.0.1:12158`。该文件单独复跑 8/8 通过，相关 MCP 文件以四并发复跑 49/49 通过，尚未确定超时原因；没有修改实现、弱化断言或跳过测试。首次失败保留在 `release-preflight/report-2026-11-26T18-05-03-369Z.json`。

使用最终 `0.14.1` 工作树重新生成 `out/` 与 `dist-runtime/dsh-runtime-win32-x64.tgz`，再运行核心 E2E：

```bash
npm run e2e -- e2e/release-core.spec.ts e2e/smoke.spec.ts e2e/session-bootstrap-tabs.spec.ts e2e/git-panel.spec.ts e2e/settings.spec.ts e2e/drawer.spec.ts e2e/file-tree-dom-budget.spec.ts
```

覆盖 pi mock CLI、ACP stdio 子进程、DSH 真 host 与离线 runtime 导入，各后端均完成首发和续发；同时覆盖启动、会话 Tab、Git 面板、设置、抽屉及文件树。模型回复来自测试进程或本机 HTTP 服务，配置与真实凭据隔离。

本机 runtime 归档 SHA-256：

```text
779384502b07baf98217ce20b25ac819f6b2d026cd3e00653b0472dea8ae2799
```

## 正式发布前仍需完成

1. 候选提交对应的 `CI / Linux unit tests (remote/SSH)` 成功结果。当前开发基线的 Dev Guard 检查通过，但其 Web 路由测试不能替代此门禁。
2. 目标平台安装包人工 smoke，包括 Windows 任务栏图标、真实供应商认证与消息往返，以及安装/升级流程；本次只生成 Electron 构建和 DSH runtime，未制作安装包。
3. 按 [时间线人工验收](timeline-manual-qa.md) 核对五条动作；按 [发版流程](release-process.md) 完成适用平台的 SSH/WSL、macOS 签名、公证、权限及网络验收。

本次没有创建 tag、GitHub Release 或触发发布工作流。正式发布仍按 [发版流程](release-process.md) 执行。

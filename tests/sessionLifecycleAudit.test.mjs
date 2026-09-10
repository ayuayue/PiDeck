// 会话全周期 + 配置 + 敏感操作审计契约（静态断言）：
// 用户「日志埋点必须覆盖会话全周期、配置变更、敏感操作」的回归保障。
// - 会话 runtime 全周期（激活/停止/重启/改名/模型/思考级别）必须留痕
// - agent 进程退出处置决策（用户停止/自动重连/重连失败）必须留痕
// - 配置变更统一在 SettingsStore.update 留痕且不记值，IPC 层不得重复
// - 会话创建/复制/导出/导入等写操作必须留痕
// - 清日志、删背景图、会话级安全级别变更必须留痕
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const coordinator = read("main/sessions/SessionRuntimeCoordinator.ts");
const agentManager = read("main/pi/AgentManager.ts");
const settingsStore = read("main/settings/SettingsStore.ts");
const systemIpc = read("main/ipc/systemIpc.ts");
const sessionIpc = read("main/ipc/sessionIpc.ts");
const appLogger = read("main/logging/AppLogger.ts");
const piProcess = read("main/pi/PiProcess.ts");
const backgroundsIpc = read("main/ipc/backgroundsIpc.ts");
const securityStore = read("main/security/SecurityStore.ts");

test("SessionRuntimeCoordinator exposes a full lifecycle logger interface", () => {
  assert.match(coordinator, /export interface SessionRuntimeLogger \{/);
  assert.match(coordinator, /info\(scope: string, message: string, detail\?: unknown\): unknown;/);
  assert.match(coordinator, /warn\(scope: string, message: string, detail\?: unknown\): unknown;/);
  assert.match(coordinator, /error\(scope: string, message: string, detail\?: unknown\): unknown;/);
  // 构造器第 4 参必须是 logger（不能再叫 perfLogger）
  assert.match(coordinator, /private readonly logger\?: SessionRuntimeLogger,/);
});

test("session runtime lifecycle events are logged", () => {
  assert.match(coordinator, /"Runtime activated", \{\s*sessionId,\s*agentId: tab\.id,\s*status: tab\.status,/);
  assert.match(coordinator, /"Runtime stopped", \{\s*sessionId: target\.sessionId,\s*agentId: target\.agentId,\s*runtimeGeneration: target\.runtimeGeneration,/);
  assert.match(coordinator, /"Runtime restarted"/);
  assert.match(coordinator, /"Runtime renamed"/);
  assert.match(coordinator, /"Runtime model changed", \{\s*sessionId: target\.sessionId,\s*agentId,\s*provider,\s*modelId,/);
  assert.match(coordinator, /"Runtime thinking changed"/);
  assert.match(coordinator, /"Anonymous runtime bound", \{\s*sessionId,\s*agentId,\s*runtimeGeneration,/);
  assert.match(coordinator, /"Focused session changed", \{ sessionId \}\)/);
  assert.match(coordinator, /"Agent stopped \(unbound\)", \{ agentId \}\)/);
});

test("agent process exit disposition decisions are logged", () => {
  assert.match(agentManager, /"Agent restart requested"/);
  assert.match(agentManager, /"Agent stopped \(user initiated\)"/);
  assert.match(agentManager, /"Agent process exit handled: user-initiated stop"/);
  assert.match(agentManager, /"Agent process exit handled: compaction in progress"/);
  assert.match(agentManager, /"Agent process exited cleanly; auto-restarting"/);
  assert.match(agentManager, /"Agent auto-restart failed"/);
});

test("settings changes are logged once, key names only, never values", () => {
  assert.match(settingsStore, /getAppLogger\(\)\?\.info\("settings", "Settings updated", \{ keys: Object\.keys\(safePatch\) \}\)/);
  // IPC 层不得重复记录（统一下沉到 SettingsStore.update，防双写噪音）
  assert.doesNotMatch(systemIpc, /"Settings updated"/);
});

test("session write operations are logged", () => {
  assert.match(sessionIpc, /"Session draft created", \{\s*sessionId: draft\.id,/);
  assert.match(sessionIpc, /"Anonymous session created", \{\s*sessionId: result\.session\.id,/);
  assert.match(sessionIpc, /"Session renamed \(file\)"/);
  assert.match(sessionIpc, /"Session copied", \{\s*sessionId,\s*targetSessionId:/);
  assert.match(sessionIpc, /"Session exported \(catalog HTML\)"/);
  assert.match(sessionIpc, /"Session exported \(runtime HTML\)"/);
  assert.match(sessionIpc, /"Codex sessions imported"/);
  assert.match(sessionIpc, /"Claude sessions imported"/);
  assert.match(sessionIpc, /"OpenCode sessions imported"/);
  assert.match(sessionIpc, /"Codex sessions scanned"/);
});

test("sensitive operations leave audit traces", () => {
  // 清日志留痕带清除前文件数
  assert.match(appLogger, /"Logs cleared", \{ files: before\.length \}\)/);
  // spawn 失败双写日志文件（pre-listener sink）
  assert.match(piProcess, /getAppLogger\(\)\?\.error\("pi-process", "Spawn error \(pre-listener sink\)"/);
  assert.match(piProcess, /getAppLogger\(\)\?\.debug\("pi-process", "Pi process spawn"/);
  // 背景图删除留痕
  assert.match(backgroundsIpc, /getAppLogger\(\)\?\.info\("backgrounds", "Background image removed", \{ name \}\)/);
  // 会话级安全级别变更留痕（含 from/to）
  assert.match(securityStore, /"Session security level changed", \{\s*sessionId,\s*from: prev,\s*to:/);
});

test("second-wave audit: proxy, single-instance, catalog, clone/fork", () => {
  const desktopProxy = read("main/settings/DesktopProxy.ts");
  const singleInstance = read("main/singleInstance.ts");
  const sessionCatalog = read("main/sessions/SessionCatalog.ts");
  const sessionScanner = read("main/sessions/SessionScanner.ts");
  const visionConfig = read("main/settings/visionBridgeConfig.ts");
  const gitIpc = read("main/ipc/gitIpc.ts");
  const index = read("main/index.ts");
  // 桌面代理：只记 mode 不记 proxyRules（URL 可能内嵌凭据）
  assert.match(desktopProxy, /"Desktop proxy applied", \{ mode: config\.mode \}\)/);
  assert.match(desktopProxy, /"Desktop proxy apply failed"/);
  // 单实例生命周期
  assert.match(singleInstance, /"Primary instance lock acquired", \{\s*version,\s*pid: process\.pid,/);
  assert.match(singleInstance, /"Secondary instance exiting; focus requested"/);
  assert.match(singleInstance, /"Focus request received from secondary instance"/);
  // catalog 主文件+备份双损坏必须 error 级留痕
  assert.match(sessionCatalog, /"Catalog and backup both failed to load"/);
  assert.match(sessionCatalog, /getAppLogger\(\)\?\.error\("session-catalog"/);
  // 损坏 catalog 不得阻断打包启动（否则窗口永不出现）
  assert.match(sessionCatalog, /this\.entries = \[\];/);
  assert.doesNotMatch(sessionCatalog, /Failed to load Session catalog or backup/);
  // SessionScanner JSONL 解析失败双写日志
  assert.match(sessionScanner, /"Skipped unparseable JSONL line", \{ filePath \}\)/);
  // 视觉桥配置写盘：只记 provider/hasApiKey，不记 key 值
  assert.match(visionConfig, /"Vision config saved", \{\s*provider:/);
  assert.match(visionConfig, /hasApiKey: Boolean/);
  // git init / web 服务回退留痕
  assert.match(gitIpc, /"Repository initialized", \{ projectId, path: project\.path \}\)/);
  assert.match(index, /"Web service disabled after apply failure"/);
});

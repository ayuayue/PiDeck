import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const runtimeInjector = readFileSync(
  "src/renderer/src/components/session/SessionRuntimeInjector.tsx",
  "utf8",
);
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");

test("session tabs mount once outside SessionView; pane keeps standalone header", () => {
  // Tab 栏统一外置；SessionView 只保留会话操作 Header（抽屉开关在共享 Tab 栏）。
  assert.doesNotMatch(sessionView, /SessionTabsBar/);
  assert.match(app, /sessionTabsBarNode/);
  assert.match(app, /SessionPaneServicesProvider/);
  // Tab 栏挂在 WorkbenchStage chrome，分屏之上（与文件 Tab 同一条）
  assert.match(app, /chrome=\{sessionTabsBarNode\}/);
  assert.doesNotMatch(app, /\{sessionTabsBarNode\}\s*\n\s*\{currentSessionId/);

  const headerStart = sessionView.indexOf("<SessionHeader");
  const contentStart = sessionView.indexOf("<ResizablePanelGroup", headerStart);
  assert.notEqual(headerStart, -1);
  assert.notEqual(contentStart, -1);
  const headerArea = sessionView.slice(headerStart, contentStart);
  assert.match(headerArea, /<SessionHeader/);
  assert.doesNotMatch(headerArea, /onToggleDrawer/);
  assert.doesNotMatch(headerArea, /embedded/);
});

test("session status and new-session controls use the shared medium radius", () => {
  // Tab 栏右侧嵌入状态徽章；运行控制（停止/重启）在 Tab 下拉，combo 控件已移除。
  const statusBlock = surfaces.slice(
    surfaces.indexOf(".session-status span"),
    surfaces.indexOf(".session-status .ctx-chip"),
  );

  assert.match(statusBlock, /border-radius:\s*var\(--radius-md\)/);
  assert.doesNotMatch(foundation, /\.session-combo-trigger/);
});

test("restart is offered for the current session, including an unbound session", () => {
  // 运行控制全状态开放：能力由 getSessionRunCapabilities 纯函数策略算出，
  // 不再由 `Boolean(currentSessionId)` 这类粗粒度布尔决定，未启动/失败/
  // 已关闭的会话同样能拿到「启动 Agent」入口。
  assert.match(
    app,
    /runControl: currentSessionId\n\s*\? \{/,
  );
  assert.match(app, /capabilities: getSessionRunCapabilities\(currentSessionId\)/);
  // 终止态 / 未启动会话的主控项在 App 分派层走 activateRuntime 或 restartRuntime。
  assert.match(app, /async function restartSessionAnyState\(sessionId: string\)/);
  assert.match(app, /await api\.sessions\.activateRuntime\(sessionId\)/);
});

test("model-picker restart must light the SessionView overlay via restartActiveAgent", () => {
  // 用户可见症状：切新模型确认重启后，时间线应出现半透明 loader +「正在重启」。
  // overlay 只认 isRestarting；该值来自 restartingAgentId === activeAgentId，
  // 而 restartingAgentId 只在 App.restartActiveAgent 里置位。
  const controller = readFileSync(
    "src/renderer/src/hooks/useSessionRuntimeController.ts",
    "utf8",
  );
  const picker = readFileSync(
    "src/renderer/src/components/session/ComposerPickerHost.tsx",
    "utf8",
  );
  const surfaceStage = readFileSync(
    "src/renderer/src/components/session/SessionSurfaceStage.tsx",
    "utf8",
  );
  assert.match(
    surfaceStage,
    /overlayVisible \? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"/,
  );
  assert.match(surfaceStage, /t\("app\.restarting"\)/);
  assert.match(runtimeInjector, /isRestarting=\{runtime\.isRestartingThisAgent\}/);
  assert.match(controller, /isRestartingThisAgent = restartingAgentId === activeAgentId/);
  assert.match(app, /setRestartingAgentId\(restartingAgent\.id\)/);
  assert.match(picker, /await restartActiveAgent\(intent\.agentId\)/);
  assert.doesNotMatch(picker, /desktopApi\.sessions\.restartRuntime/);
});

test("split panes show per-pane session title in SessionHeader", () => {
  // 共享顶栏 Tab 时，分屏各栏靠 paneTitle 对上「这栏是谁」；单栏不重复标题。
  const header = readFileSync(
    "src/renderer/src/components/session/SessionHeader.tsx",
    "utf8",
  );
  assert.match(header, /paneTitle\?:/);
  assert.match(header, /session-pane-title/);
  assert.match(sessionView, /paneTitle=\{splitPane \? sessionTitle : undefined\}/);
});

test("session header has no bottom border under pane identity row", () => {
  const header = readFileSync(
    "src/renderer/src/components/session/SessionHeader.tsx",
    "utf8",
  );
  // 身份标题下不再叠 border-b，避免分屏/单栏碎线
  assert.doesNotMatch(
    header,
    /chat-header[^"]*border-b/,
  );
});

test("split panes expose exit-split expand control on the left", () => {
  const header = readFileSync(
    "src/renderer/src/components/session/SessionHeader.tsx",
    "utf8",
  );
  assert.match(header, /onExitSplit\?:/);
  assert.match(header, /Maximize2/);
  assert.match(header, /session\.split\.exit/);
  // 面板级退出：SessionView 把本栏 sessionId 传给 exitSessionSplit（移除该会话出布局）
  assert.match(
    sessionView,
    /onExitSplit=\{\s*splitPane \? \(\) => paneServices\.exitSessionSplit\(sessionId\) : undefined\s*\}/,
  );
  assert.match(app, /exitSessionSplit:\s*workspaceChrome\.exitSplit/);
  const chrome = readFileSync(
    "src/renderer/src/hooks/useSessionWorkspaceChrome.ts",
    "utf8",
  );
  assert.match(chrome, /const exitSplit = useCallback/);
});

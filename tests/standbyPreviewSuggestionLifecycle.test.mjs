import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 草稿会话 standby 命令预览的渲染层生命周期契约（Issue #316 链路的 UI 半边）。
 *
 * 主进程侧（AgentManager.draftCommands 的 11 种失败路径）已有
 * tests/agentManagerDraftCommands.test.mjs；纯函数优先级/项目切换防护在
 * tests/draftResourceCommands.test.mjs。这里钉住 useSessionComposerController
 * 里的 effect 竞态语义与 IPC 边界校验——用源码契约（该 hook 依赖面过大，
 * 仓库惯例是 readFileSync 断言，见 abortStreamRegression/busySendDelivery）。
 *
 * 契约语义（每条对应一类真实事故）：
 * - dsh/runtime 已起/无项目三种模式必须置空快照且不发 IPC（预览只服务草稿）；
 * - fetch 前先置空：切项目的瞬间不能让上一个项目的预览残留一帧（串项目建议）；
 * - 响应必须过 current 守卫且 null 不落地：迟到的旧响应/失败响应不得覆盖新状态；
 * - 失败必须吞掉：预览是纯增强，绝不把渲染层 effect 变成未处理拒绝；
 * - 依赖数组必须含 runtime?.agentId：runtime 建立瞬间预览让位（RPC 表是唯一权威）。
 */
const CONTROLLER_PATH = "src/renderer/src/hooks/useSessionComposerController.ts";

test("standby preview effect: gated modes reset the snapshot without fetching", () => {
	const source = readFileSync(CONTROLLER_PATH, "utf8");
	assert.match(source, /if \(isDshBackend \|\| isAcpBackend \|\| runtime\?\.agentId \|\| !effectiveProjectId\) \{\s*setStandbyPreviewCommandSnapshot\(\{ projectId: effectiveProjectId, commands: \[\] \}\);\s*return;\s*\}/, "dsh/acp/runtime-started/no-project must clear the snapshot and never hit the IPC");
});

test("standby preview effect: snapshot resets before the fetch so a project switch never shows stale commands", () => {
	const source = readFileSync(CONTROLLER_PATH, "utf8");
	assert.match(source, /let current = true;\s*setStandbyPreviewCommandSnapshot\(\{ projectId: effectiveProjectId, commands: \[\] \}\);\s*void desktopApi\.sessions/, "the reset must happen synchronously before draftCommands is invoked");
});

test("standby preview effect: late or empty responses never land", () => {
	const source = readFileSync(CONTROLLER_PATH, "utf8");
	assert.match(source, /if \(current && preview\) setStandbyPreviewCommandSnapshot\(\{ projectId: effectiveProjectId, commands: preview \}\)/, "only a fresh non-null response may apply");
	assert.match(source, /\.catch\(\(\) => undefined\)/, "preview failures must be swallowed — the effect is a pure enhancement");
	assert.match(source, /return \(\) => \{\s*current = false;\s*\};/, "cleanup must invalidate in-flight responses");
});

test("standby preview effect: re-runs when the runtime starts so the RPC command table takes over", () => {
	const source = readFileSync(CONTROLLER_PATH, "utf8");
	assert.match(source, /\}, \[effectiveProjectId, isAcpBackend, isDshBackend, runtime\?\.agentId\]\);/, "deps must include runtime?.agentId and the acp backend flag");
});

test("composer wiring: preview is projected per project and feeds the priority selector in order", () => {
	const source = readFileSync(CONTROLLER_PATH, "utf8");
	assert.match(source, /standbyPreviewCommandsForProject\(standbyPreviewCommandSnapshot, effectiveProjectId\)/);
	assert.match(source, /selectComposerSuggestionCommands\(isDshBackend, Boolean\(runtime\?\.agentId\), commands, draftResourceCommands, standbyPreviewCommands\)/);
});

test("sessions:draft-commands IPC boundary: input validated before delegation, no business logic in the handler", () => {
	const source = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	assert.match(source, /ipcMain\.handle\(ipcChannels\.sessionsDraftCommands, \(_event, projectId: string\) => \{\s*if \(typeof projectId !== "string" \|\| !projectId\.trim\(\)\) return null;\s*return sessionRuntimeCoordinator\.draftCommands\(projectId\);/);
});

test("embed stubs (browser/preview) return null so suggestions fall back to local discovery", () => {
	const browserApi = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	assert.match(browserApi, /draftCommands: async \(\) => null/);
	const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	assert.match(previewApi, /draftCommands: async \(\) => null/);
});

test("preload whitelist exposes draftCommands through the single channel constant", () => {
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(preload, /draftCommands: \(projectId: string\) => ipcRenderer\.invoke\(ipcChannels\.sessionsDraftCommands, projectId\) as Promise<PiCommand\[\] \| null>/);
});

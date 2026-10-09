import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * editorsIpc 边界测试：渲染层不可信原则下，editorsOpenProject 不得信任
 * 渲染层传入的完整 editor 对象（command/args 可被篡改成任意进程启动器）。
 * 主进程必须按 editorId 从 settingsStore 取已配置的 command/args。
 */

function buildIpc({ editorsConfig, openedWith }) {
	const handlers = new Map();
	const sandbox = createTsSandbox({
		stubs: {
			electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } },
			"../../shared/ipc": {
				ipcChannels: {
					editorsList: "editors:list",
					editorsRedetect: "editors:redetect",
					editorsUpdate: "editors:update",
					editorsChooseExecutable: "editors:choose-executable",
					editorsOpenProject: "editors:open-project",
				},
			},
			"../editors/EditorDetector": {
				openProjectInEditor: async (editor, projectPath) => {
					openedWith.push({ editor, projectPath });
				},
				// 模拟已启用且可启动的编辑器列表（与真实实现同构：resolveLaunchableCommand+exists 已过滤）。
				listConfiguredExternalEditors: async () => Object.values(editorsConfig),
				mergeDetectedExternalEditors: (_cur, detected) => detected,
				detectExternalEditors: async () => [],
				validateExternalEditorCommand: async () => ({ valid: true }),
			},
		},
	});
	sandbox("src/main/ipc/editorsIpc.ts").registerEditorsIpc({
		settingsStore: {
			get: () => ({ externalEditors: editorsConfig }),
			update: async () => ({}),
		},
		appLogger: { info: () => {}, error: () => {} },
		getMainWindow: () => null,
	});
	return handlers;
}

test("editors:open-project uses the configured editor command, not the renderer-supplied object", async () => {
	const openedWith = [];
	const editorsConfig = {
		vscode: {
			id: "vscode",
			name: "VS Code",
			command: "C:/Tools/Code/bin/code.cmd",
			args: ["--wait"],
			detectedFrom: "manual",
		},
	};
	const handlers = buildIpc({ editorsConfig, openedWith });

	// 渲染层被攻破时可以伪造 editor 对象：command 换成任意程序、args 注入。
	const forged = {
		id: "vscode",
		name: "VS Code",
		command: "C:/Windows/System32/notepad.exe",
		args: ["--malicious-flag"],
	};
	await handlers.get("editors:open-project")(null, forged, "D:/project/github/pi-desktop");

	// 主进程必须使用 settingsStore 中已配置的 command/args，而非透传渲染层对象。
	assert.equal(openedWith.length, 1);
	assert.equal(openedWith[0].editor.command, "C:/Tools/Code/bin/code.cmd");
	assert.deepEqual(openedWith[0].editor.args, ["--wait"]);
});

test("editors:open-project rejects editor ids that are not configured", async () => {
	const openedWith = [];
	const handlers = buildIpc({ editorsConfig: {}, openedWith });

	const forged = { id: "unknown-editor", command: "C:/Windows/System32/notepad.exe", args: [] };
	await assert.rejects(() => handlers.get("editors:open-project")(null, forged, "D:/project/github/pi-desktop"), /not configured|Unsupported editor/);
	assert.equal(openedWith.length, 0);
});

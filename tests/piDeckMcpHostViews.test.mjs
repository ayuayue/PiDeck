import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const { buildPiDeckMcpAgentSummary, buildPiDeckMcpAutomationRun, buildPiDeckMcpAutomationTaskDetail, buildPiDeckMcpAutomationTaskSummary, buildPiDeckMcpExtensionsView, buildPiDeckMcpSettingsView } = loadTsCommonJs(resolve(REPO_ROOT, "src/main/mcp/piDeckMcpViews.ts"));
const { createDefaultAppSettings } = loadTsCommonJs(resolve(REPO_ROOT, "src/shared/types/settings.ts"));
const { listActiveBuiltInExtensionPaths } = loadTsCommonJs(resolve(REPO_ROOT, "src/main/extensions/builtInExtensions.ts"));

const plain = (value) => JSON.parse(JSON.stringify(value));
const roots = { appPath: REPO_ROOT, resourcesPath: REPO_ROOT, isDev: true };

/** 唯一标记：只要出现在投影里就说明某个字段被整份带出去了。 */
const SECRET = "must-not-leak-9f2c";

/** 把每个「凭据 / 代理 / 磁盘路径 / 用户私有文本」类字段都塞上标记，用于验证允许清单确实生效。 */
function settingsWithSecrets() {
	const settings = createDefaultAppSettings();
	const marked = {
		webServiceToken: SECRET,
		telemetryInstallId: SECRET,
		piProxyUrl: `http://user:${SECRET}@127.0.0.1:7890`,
		desktopProxyUrl: `socks5://127.0.0.1:1080#${SECRET}`,
		customPiPath: `/tmp/${SECRET}/pi`,
		piCustomPaths: [`/tmp/${SECRET}/other-pi`],
		gitExecutablePath: `/tmp/${SECRET}/git`,
		dshHomeDir: `/tmp/${SECRET}/dsh`,
		dshRunnerNodePath: `/tmp/${SECRET}/node`,
		kimiWorkShareRoot: `/tmp/${SECRET}/kimi`,
		quickMessages: [`草稿 ${SECRET}`],
		customUpdateSourceUrl: `https://${SECRET}.example.com`,
		externalEditors: [{ id: "vscode", label: "VS Code", command: `/tmp/${SECRET}/code` }],
		acpTools: [{ id: "codex", env: { OPENAI_API_KEY: SECRET } }],
	};
	// 字段名对着 AppSettings 源文件校对（正则空白容忍）：改名后测试立刻红，而不是静默退化成「标记没被读到所以通过」。
	// 不能改用 Object.hasOwn：可选字段（webServiceToken? / acpTools? 等）不在 createDefaultAppSettings 的返回值里。
	const settingsSource = readFileSync(resolve(REPO_ROOT, "src/shared/types/settings.ts"), "utf8");
	for (const key of Object.keys(marked)) {
		assert.match(settingsSource, new RegExp(`^[\\t ]*${key}\\??:`, "m"), `AppSettings 已无字段 ${key}，请更新本测试`);
		settings[key] = marked[key];
	}
	return settings;
}

test("settings_get 投影只输出允许清单，凭据/代理/路径/用户私有文本一律不出现在序列化结果里", () => {
	const settings = settingsWithSecrets();
	const view = buildPiDeckMcpSettingsView(settings);
	const serialized = JSON.stringify(view);
	assert.equal(serialized.includes(SECRET), false, `投影泄漏了标记字段：${serialized}`);
	// 递归确认没有 path/url/token 类键名混进来（防止未来「整份导出再删敏感字段」的写法回流）。
	const keys = [];
	const walk = (node) => {
		if (node === null || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			keys.push(key);
			walk(value);
		}
	};
	walk(view);
	for (const key of keys) assert.equal(/path|url|token|secret|key/i.test(key), false, `投影出现可疑键名 ${key}`);
});

test("settings_get 的值与设置快照同源，未设置的可选模型偏好退化为 null", () => {
	const settings = settingsWithSecrets();
	settings.language = "en-US";
	settings.theme = "dark";
	settings.defaultAgentBackend = "dsh";
	settings.piRpcOffline = true;
	settings.piRpcNoExtensions = true;
	settings.piRpcNoSkills = true;
	settings.favoriteModels = ["anthropic/claude-sonnet-4-5"];
	settings.lastUsedModel = "anthropic/claude-sonnet-4-5";
	settings.showThinking = true;
	settings.autoSessionTitle = false;
	settings.enableGitManagement = true;
	settings.cuaEnabled = true;
	settings.cuaAutoApprove = true;
	settings.wslEnabled = true;
	settings.wslDistro = "Ubuntu-24.04";

	assert.deepEqual(plain(buildPiDeckMcpSettingsView(settings)), {
		app: { language: "en-US", theme: "dark" },
		agent: {
			backend: "dsh",
			offline: true,
			noExtensions: true,
			noSkills: true,
			lastUsedModel: "anthropic/claude-sonnet-4-5",
			favoriteModels: ["anthropic/claude-sonnet-4-5"],
			showThinking: true,
			autoSessionTitle: false,
		},
		workspace: { gitManagement: true, cuaEnabled: true, cuaAutoApprove: true, wslEnabled: true, wslDistro: "Ubuntu-24.04" },
	});

	const cleared = createDefaultAppSettings();
	cleared.lastUsedModel = undefined;
	assert.equal(buildPiDeckMcpSettingsView(cleared).agent.lastUsedModel, null);
});

test("extensions_list 的 enabled 与实际 -e 注入判定同口径（含移除、内部适配器、历史路径形态）", () => {
	const settings = createDefaultAppSettings();
	// 历史数据里移除项可能存的是完整路径；注入侧会 basename 归一化，视图必须同口径。
	settings.removedBuiltInExtensions = ["/home/someone/pi-deck-todo.ts", " pi-deck-trash-guard.ts ", "pi-deck-shell-proxy.ts"];
	const view = buildPiDeckMcpExtensionsView({ settings, builtInVersion: "1.2.3" });

	const injected = listActiveBuiltInExtensionPaths(roots, settings.removedBuiltInExtensions).map((file) => file.split(/[\\/]/).pop());
	// 跨 vm realm 的数组原型不同，deepStrictEqual 会因 prototype 不等而失败，先落回宿主数组。
	const enabledIds = [...view.builtIn.filter((entry) => entry.enabled).map((entry) => entry.id)];
	assert.deepEqual([...enabledIds].sort(), [...injected].sort(), "视图的 enabled 必须等于真实注入集合");
	assert.equal(enabledIds.includes("pi-deck-todo.ts"), false, "完整路径形态的移除项也必须生效");
	assert.equal(enabledIds.includes("pi-deck-trash-guard.ts"), false, "带空白的移除项也必须生效");
	assert.equal(enabledIds.includes("pi-deck-shell-proxy.ts"), true, "内部适配器不受用户移除影响");
	assert.equal(view.builtInVersion, "1.2.3");
});

test("extensions_list 覆盖注入开关、用户扩展开关与内置清单，且不含磁盘路径", () => {
	const settings = createDefaultAppSettings();
	settings.piRpcNoExtensions = true;
	settings.disabledExtensions = [{ scope: "project", source: "user-extension.ts" }];
	const view = buildPiDeckMcpExtensionsView({ settings, builtInVersion: null });

	assert.equal(view.injectionDisabled, true, "piRpcNoExtensions 必须如实上报，否则客户端会把 builtIn.enabled 当生效值");
	assert.deepEqual(plain(view.disabledExtensions), [{ scope: "project", source: "user-extension.ts" }]);
	assert.equal(view.removedBuiltInExtensions.includes("pi-deck-todo.ts"), false);
	assert.equal(view.builtInVersion, null);
	assert.equal(view.builtIn.length > 0, true);
	assert.equal(JSON.stringify(view).includes(REPO_ROOT.replace(/\\/g, "/")), false, "内置清单不应带出磁盘路径");
	assert.equal(
		view.builtIn.every((entry) => !entry.id.includes("/") && !entry.id.includes("\\")),
		true,
	);
});

test("agents 投影只输出元信息允许清单：systemPrompt 与路径不泄漏", () => {
	const agent = {
		id: "a1",
		name: "翻译",
		description: "一句话说明",
		icon: "🌐",
		systemPrompt: `角色设定 ${SECRET}`,
		category: "translation",
		builtin: false,
		model: { provider: "p", modelId: "m" },
		backend: "pi",
		createdAt: 1,
		updatedAt: 2,
		usageCount: 3,
		lastUsedAt: 4,
	};
	const view = buildPiDeckMcpAgentSummary(agent);
	assert.equal("systemPrompt" in view, false, "角色设定不得进入投影");
	assert.equal(JSON.stringify(view).includes(SECRET), false, `投影泄漏了标记：${JSON.stringify(view)}`);
	assert.deepEqual(plain(view), { id: "a1", name: "翻译", description: "一句话说明", icon: "🌐", category: "translation", builtin: false, model: { provider: "p", modelId: "m" }, backend: "pi", usageCount: 3, lastUsedAt: 4, createdAt: 1, updatedAt: 2 });
	// 可选项缺省时给 null（客户端不必区分 undefined），但依旧没有角色设定。
	const bare = buildPiDeckMcpAgentSummary({ ...agent, model: undefined, backend: undefined, lastUsedAt: undefined, builtin: undefined });
	assert.equal(bare.model, null);
	assert.equal(bare.backend, null);
	assert.equal(bare.lastUsedAt, null);
	assert.equal(bare.builtin, false);
});

test("automation 投影：列表不含 prompt、详情带 prompt、run 截断 error 且不含 events", () => {
	const task = {
		id: "t1",
		name: "巡检",
		projectId: "p1",
		prompt: `任务 ${SECRET}`,
		schedule: { type: "cron", expression: "0 9 * * *" },
		enabled: true,
		backend: "pi",
		model: { provider: "p", modelId: "m" },
		thinkingLevel: "high",
		mode: "plan",
		permissionPreset: "full",
		budget: { timeoutMs: 1000 },
		createdAt: 1,
		updatedAt: 2,
		lastScheduledAt: 3,
		nextRunAt: 4,
	};
	const summary = buildPiDeckMcpAutomationTaskSummary(task);
	assert.equal("prompt" in summary, false, "列表投影不含 prompt");
	assert.equal(JSON.stringify(summary).includes(SECRET), false);
	assert.equal(summary.nextRunAt, 4);
	assert.equal(summary.mode, "plan");
	const detail = buildPiDeckMcpAutomationTaskDetail(task);
	assert.equal(detail.prompt, `任务 ${SECRET}`, "详情在项目范围内带 prompt");
	const run = { id: "r1", taskId: "t1", taskName: "巡检", projectId: "p1", trigger: "manual", status: "failed", queuedAt: 1, updatedAt: 2, inputTokens: 3, outputTokens: 4, costUsd: 0.5, stepCount: 5, error: "x".repeat(3000), events: [{ id: "e1", type: "failed", at: 2 }] };
	const runView = buildPiDeckMcpAutomationRun(run);
	assert.equal(runView.error.length, 2000, "error 截断到 2000 字符");
	assert.equal("events" in runView, false, "events 明细不进 MCP");
	assert.equal(runView.sessionId, null);
	assert.equal(runView.durationMs, null);
});

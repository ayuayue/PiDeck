import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/**
 * 安全门集成契约测试：
 * - 内置扩展清单包含安全门（否则 -e 注入会缺失）
 * - 扩展源文件自包含（不 import PiDeck 源码）
 * - 扩展声明的快照字段与主进程 buildSnapshot 输出一致（schema 契约）
 * - PIDECK_* 环境变量在 PiProcess 启动路径中注入
 */

let builtInExtensionsModule = null;

/** 统一走 loadTsCommonJs：模块已拆出 ./builtInExtensionsManifest，裸 require 解析不了无扩展名的 .ts。 */
function loadBuiltInExtensionsModule() {
	if (!builtInExtensionsModule) {
		builtInExtensionsModule = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");
	}
	return builtInExtensionsModule;
}

test("BUILT_IN_EXTENSIONS includes pi-deck-security-gate.ts", () => {
	const { BUILT_IN_EXTENSIONS, isBuiltInExtensionName } = loadBuiltInExtensionsModule();
	assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-security-gate.ts"));
	assert.ok(isBuiltInExtensionName("pi-deck-security-gate.ts"));
	assert.ok(!isBuiltInExtensionName("../pi-deck-security-gate.ts"));
});

test("security gate extension is self-contained (no PiDeck src imports)", () => {
	const source = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	assert.doesNotMatch(source, /from\s+["']\.\.?\//);
	assert.doesNotMatch(source, /from\s+["']src\//);
	// 只允许 @earendil-works 与 node 内置模块
	const imports = [...source.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
	for (const spec of imports) {
		assert.ok(spec.startsWith("@earendil-works/") || spec.startsWith("node:") || spec.startsWith("node/"), `不允许的扩展依赖: ${spec}`);
	}
});

test("extension reads the same env vars the main process injects", () => {
	const extSource = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const piProcess = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	const securityTypes = readFileSync("src/shared/types/security.ts", "utf8");
	// 三方必须引用同一对环境变量名
	assert.match(extSource, /process\.env\.PIDECK_SECURITY_CONFIG/);
	assert.match(extSource, /process\.env\.PIDECK_SESSION_ID/);
	assert.match(piProcess, /PIDECK_SECURITY_CONFIG/);
	assert.match(piProcess, /PIDECK_SESSION_ID/);
	assert.match(securityTypes, /PIDECK_SECURITY_CONFIG/);
	assert.match(securityTypes, /PIDECK_SESSION_ID/);
});

test("PIDECK_SESSION_ID is keyed on catalog session id, not sessionPath", () => {
	// 回归：SecurityLevelMenu 用 SessionRecord.id（UUID）保存会话级覆盖，
	// 否则扩展按 sessionLevels[sessionId] 永远查不到覆盖而回落到全局默认等级。
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
	const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
	assert.match(agentManager, /securitySessionId: securitySessionKey \?\? sessionPath/);
	// 运行时创建 agent 时把 catalog 会话身份透传给 AgentManager
});

test("extension snapshot field names match buildSnapshot output", () => {
	// 契约：主进程写入的字段必须被扩展读取。
	// 扩展侧无法 import 主进程模块，靠本测试锁定字段名一致，防止任一侧改名漏同步。
	const extSource = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const policySource = readFileSync("src/main/security/policy.ts", "utf8");
	for (const field of ["schemaVersion", "enabled", "defaultLevelId", "levels", "sessionLevels"]) {
		assert.match(extSource, new RegExp(`\\b${field}\\b`), `扩展未读取快照字段 ${field}`);
		assert.match(policySource, new RegExp(`\\b${field}\\b`), `主进程未输出快照字段 ${field}`);
	}
});

test("extension reads tool_call input fields that PiDeck built-in tools emit", () => {
	const extSource = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	// read/write/edit 的路径字段是 filePath（与飞书工具摘要一致，不是 path）；
	// grep/find/ls 的目录字段是 path；bash 用 command。
	assert.match(extSource, /"filePath"/);
	assert.match(extSource, /"path"/);
	assert.match(extSource, /input\.command/);
});

test("AgentManager passes security snapshot + session id to PiProcess options", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(agentManager, /securitySnapshotPath:/);
	assert.match(agentManager, /securitySessionId:/);
	assert.match(agentManager, /ensureSnapshotWritten\(\)/);
});

test("preload exposes security namespace with three IPC methods", () => {
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	assert.match(preload, /security:\s*\{/);
	assert.match(preload, /securityGetConfig/);
	assert.match(preload, /securityUpdateConfig/);
	assert.match(preload, /securitySetSessionLevel/);
	assert.match(ipc, /security:get-config/);
	assert.match(ipc, /security:update-config/);
	assert.match(ipc, /security:set-session-level/);
});

test("default settings: security gate on with off level (zero-intervention)", () => {
	const securityTypes = readFileSync("src/shared/types/security.ts", "utf8");
	// 默认工厂：总开关启用（enabled=true）+ 默认等级 off（完全放行），升级后老用户行为不变
	assert.match(securityTypes, /enabled:\s*true/);
	assert.match(securityTypes, /defaultLevelId:\s*"off"/);
	// 快照 schemaVersion 与扩展侧常量一致
	assert.match(securityTypes, /schemaVersion:\s*1/);
});

test("安全管理 tab 必须 forceMount：切 tab 不能卸载草稿（allow/ask/deny 会静默丢失）", () => {
	// 回归契约（2026-09 用户反馈「ask 的选中切个 tab 就没了」）：
	// SecuritySection 的草稿（enabled / defaultLevelId / 各等级 toolActions 等）只存在组件内部 state，
	// Radix Tabs 默认卸载非激活 TabsContent → 切走再回来草稿归零；
	// 更隐蔽的是它卸载时会上抛 onDirtyChange(false)，把父级黄点清掉，连关闭时的保存确认也不弹。
	const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	const securityTabTag = configModal.match(/<TabsContent value="security"[^>]*>/);
	assert.ok(securityTabTag, "ConfigModal 必须直接用 TabsContent 承载安全管理页");
	assert.match(securityTabTag[0], /forceMount/, "安全管理 TabsContent 必须 forceMount 常挂");
	assert.match(securityTabTag[0], /data-\[state=inactive\]:hidden/, "inactive 必须 hidden，否则会叠在别的 tab 上");

	// 面板确实带着脏状态上报（forceMount 挂的是自管草稿的面板，而不是把它接到别处）
	assert.match(configModal, /<SecuritySection ref=\{securitySectionRef\} onDirtyChange=\{handleSecurityDirtyChange\}/);
	// 脏标记必须能被保存流程消费（saveByKey 的 security 分支）
	assert.match(configModal, /case "security":\s*\n\s*return securitySectionRef\.current\?\.save\(\) \?\? false;/);
});

/**
 * 行为回归（issue #357-04）：before_agent_start 的系统提示注入只能「追加」。
 *
 * pi 的 extension 契约（docs/extensions.md:104）：返回 systemPrompt / 设 forceSystemPrompt
 * 的语义是「整体替换本轮系统提示」。旧写法 `(ctx.getSystemPrompt?.() ?? "") + "\n\n" + hint`
 * 在拿不到基准（ctx 无该方法或返回空）时，会把整条系统提示覆盖成「只剩安全提示」。
 * 修复后的验收：拿不到非空基准 → 放弃注入（返回 undefined），绝不返回空底替换。
 */
function loadSecurityGateHarness(snapshotPath, sessionId) {
	const source = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
		fileName: "pi-deck-security-gate.ts",
	}).outputText;
	const module2 = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module: module2,
			exports: module2.exports,
			// type-only import 编译后消失：运行时不需要 pi 模块，其余走真实 node 内置模块
			require: (specifier) => (specifier === "@earendil-works/pi-coding-agent" ? {} : nodeRequire(specifier)),
			process: { ...process, env: { ...process.env, PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: sessionId } },
			console,
			Buffer,
			setTimeout,
			clearTimeout,
		},
		{ filename: "pi-deck-security-gate.ts" },
	);
	const handlers = new Map();
	module2.exports.default({ on: (event, handler) => handlers.set(event, handler), appendEntry() {} });
	return handlers.get("before_agent_start");
}

function writeSnapshotFile(dir, levelDefaults = {}) {
	const snapshotPath = join(dir, "security-policy.json");
	writeFileSync(
		snapshotPath,
		JSON.stringify({
			schemaVersion: 1,
			enabled: true,
			defaultLevelId: "standard",
			levels: [
				{
					id: "standard",
					name: "标准",
					description: "",
					toolActions: {},
					denyBashPatterns: ["rm -rf"],
					pathPolicy: "workspace",
					customAllowDirs: [],
					denyDirs: [],
					protectSensitivePaths: true,
					defaultAction: "allow",
					...levelDefaults,
				},
			],
			sessionLevels: {},
		}),
	);
	return snapshotPath;
}

test("before_agent_start: 有基准时追加安全提示（不丢原文）", () => {
	const dir = mkdtempSync(join(tmpdir(), "security-gate-prompt-"));
	try {
		const handler = loadSecurityGateHarness(writeSnapshotFile(dir), "sess-1");
		const result = handler({}, { getSystemPrompt: () => "BASE PROMPT" });
		assert.ok(result && typeof result.systemPrompt === "string");
		assert.ok(result.systemPrompt.startsWith("BASE PROMPT\n\n"), "必须保留原系统提示");
		assert.match(result.systemPrompt, /当前会话启用了桌面端安全管理（等级: 标准）/);
		assert.match(result.systemPrompt, /文件读写仅限工作目录/);
		assert.match(result.systemPrompt, /rm -rf/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("before_agent_start: 写系统提示 section，而不是 force 整块替换（issue #365-08）", () => {
	const dir = mkdtempSync(join(tmpdir(), "security-gate-prompt-"));
	try {
		const handler = loadSecurityGateHarness(writeSnapshotFile(dir), "sess-1");
		const sections = { pi_deck_earlier: "keep me" };
		const result = handler({ systemPromptOptions: { sections } }, { getSystemPrompt: () => "BASE PROMPT" });

		// 返回 systemPrompt 是 force 语义：会把本轮提示定死成整块字符串，
		// 后续扩展对 sections 的写入全部丢弃。
		assert.equal(result, undefined);
		assert.match(sections.pi_deck_security, /当前会话启用了桌面端安全管理（等级: 标准）/);
		assert.match(sections.pi_deck_security, /rm -rf/);
		assert.equal(sections.pi_deck_earlier, "keep me", "前序扩展写入的 section 必须保留");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("before_agent_start: 拿不到非空基准时放弃注入（不能用空串覆盖系统提示）", () => {
	const dir = mkdtempSync(join(tmpdir(), "security-gate-prompt-"));
	try {
		const handler = loadSecurityGateHarness(writeSnapshotFile(dir), "sess-1");
		// ctx 没有 getSystemPrompt（老版本 pi / 替身实现）→ 之前会返回 systemPrompt = "\n\n" + hint
		assert.equal(handler({}, {}), undefined);
		// 返回空串同样视为「拿不到基准」（空串会整体替换掉系统提示）
		assert.equal(handler({}, { getSystemPrompt: () => "" }), undefined);
		// 有基准的正常路径不受影响（对照，避免上面两条靠「永远 undefined」蒙过）
		assert.equal(typeof handler({}, { getSystemPrompt: () => "BASE" })?.systemPrompt, "string");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

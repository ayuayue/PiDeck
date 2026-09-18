import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	shouldRetryWithoutExtensions,
	extractExtensionLoadHints,
	formatExtensionFallbackDebug,
	resolveDisabledExtensionsReason,
	resolveDisabledExtensionsCopy,
} = loadTsCommonJs("src/main/pi/extensionStartupFallback.ts");

const SAMPLE_STDERR = [
	'Error: Failed to load extension "D:\\\\app\\\\resources\\\\extensions\\\\pi-deck-ask-question.ts":',
	"Cannot find module '@earendil-works/pi-ai'",
	'Error: Failed to load extension "D:\\\\app\\\\resources\\\\extensions\\\\pi-deck-todo.ts":',
	"Cannot find module '@earendil-works/pi-ai'",
].join("\n");

test("retries when extension load kills the RPC process", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			stderr: SAMPLE_STDERR,
			errorMessage: "pi exited: code=1, signal=null",
			exitCode: 1,
		}),
		true,
	);
});

test("does not retry when user already disabled extensions", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: true,
			stderr: SAMPLE_STDERR,
			errorMessage: "pi exited: code=1, signal=null",
			exitCode: 1,
		}),
		false,
	);
});

test("does not retry while the process is still running (timeout / slow start)", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "RPC request timed out",
			processStillRunning: true,
		}),
		false,
	);
});

test("does not retry spawn ENOENT or missing WSL", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "spawn ENOENT",
			exitCode: -1,
		}),
		false,
	);
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "WSL distribution is unavailable for pi startup.",
		}),
		false,
	);
});

test("retries a non-zero exit even without explicit extension wording", () => {
	// 日志里常见的失败形态：stderr 还没刷完，只看到 pi exited / exit 1。
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "pi exited: code=1, signal=null",
			exitCode: 1,
		}),
		true,
	);
});

test("extracts unique extension load hints for the chat diagnostic card", () => {
	const hints = extractExtensionLoadHints(SAMPLE_STDERR);
	assert.ok(hints.some((line) => /Failed to load extension/.test(line)));
	assert.ok(
		hints.some((line) =>
			/Cannot find module '@earendil-works\/pi-ai'/.test(line),
		),
	);
	assert.equal(new Set(hints).size, hints.length);
});

test("formats fallback debug that users can paste to the AI", () => {
	const debug = formatExtensionFallbackDebug({
		rawMessage: "pi exited: code=1, signal=null",
		stderr: SAMPLE_STDERR,
		exitCode: 1,
	});
	assert.match(debug, /First start exit code: 1/);
	assert.match(debug, /Failed to load extension/);
	assert.match(debug, /@earendil-works\/pi-ai/);
});

test("AgentManager wires handshake fallback but never persists --no-extensions globally", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const fallbackModule = readFileSync(
		"src/main/pi/extensionStartupFallback.ts",
		"utf8",
	);
	assert.match(source, /private async handshakePiProcess\(/);
	assert.match(source, /retrying without extensions/);
	assert.match(source, /piRpcNoExtensions: true/);
	assert.match(source, /queueStartupDiagnostic\(/);
	assert.match(source, /flushStartupDiagnostics\(/);
	// 文案与 i18n key 集中在 extensionStartupFallback.ts（设置/回退两种成因都在那里），
	// AgentManager 只消费 resolveDisabledExtensionsCopy 的结果，不再写死 key 与中文文案。
	assert.match(source, /resolveDisabledExtensionsCopy\(reason\)/);
	assert.match(fallbackModule, /"diagnostic\.extensionsDisabledFallback"/);
	assert.match(fallbackModule, /"diagnostic\.extensionsDisabledBySetting"/);
	assert.match(source, /startupHandshakeAgents/);
	assert.match(source, /agent_start/);
	// 回退只针对本次运行时：--no-extensions 只以 settingsOverride 传本次 spawn
	// （spawnAndGetState 第三参），绝不写进全局设置。否则用户修复扩展后，
	// 后续所有新 agent 仍无扩展启动，必须手动改回设置才能恢复。
	assert.doesNotMatch(
		source,
		/settingsStore\.update\(\(\{ piRpcNoExtensions: true \}\)\)/,
	);
	const overrideCall = source.indexOf(
		"spawnAndGetState(agentId, options, {\n\t\t\t\t\tpiRpcNoExtensions: true,\n\t\t\t\t})",
	);
	assert.ok(
		overrideCall >= 0,
		"second spawn carries the per-runtime --no-extensions override",
	);
	// 回退说明卡不立即写时间线：等首个 agent_start（用户消息已落盘）再 flush。
	const queueCall = source.indexOf(
		"this.queueStartupDiagnostic(agentId, diagnostic)",
	);
	const firstRunMark = source.indexOf("this.agentStartedFirstRun.add(agentId)");
	const flushAt = source.indexOf("this.flushStartupDiagnostics(agentId)");
	assert.ok(
		queueCall >= 0 && firstRunMark >= 0 && flushAt >= 0,
		"startup diagnostic queued and flushed on first run",
	);
});

test("禁用扩展成因：设置开关优先于本次回退，扩展正常加载时为 null", () => {
	assert.equal(
		resolveDisabledExtensionsReason({
			settingDisabled: false,
			fallbackFromExtensions: false,
		}),
		null,
	);
	assert.equal(
		resolveDisabledExtensionsReason({
			settingDisabled: true,
			fallbackFromExtensions: false,
		}),
		"setting",
	);
	assert.equal(
		resolveDisabledExtensionsReason({
			settingDisabled: false,
			fallbackFromExtensions: true,
		}),
		"fallback",
	);
	// 设置已开时 decideExtensionFallback 不会回退，两者理论上互斥；真同时命中时归给设置，
	// 因为那才是用户能去关掉的持久成因（自动回退的开关不在用户手里）。
	assert.equal(
		resolveDisabledExtensionsReason({
			settingDisabled: true,
			fallbackFromExtensions: true,
		}),
		"setting",
	);
});

test("禁用扩展提示：只有设置成因带「去设置」动作，回退只解释本次运行", () => {
	const setting = resolveDisabledExtensionsCopy("setting");
	const fallback = resolveDisabledExtensionsCopy("fallback");
	assert.equal(setting.noticeAction, "openDevExtensionsSettings");
	assert.equal(fallback.noticeAction, undefined);
	assert.notEqual(setting.diagnosticKey, fallback.diagnosticKey);
	assert.notEqual(setting.noticeKey, fallback.noticeKey);
	// 回退文案必须点明「不写入设置」：用户会把自动回退误当成设置被改（历史反馈）
	assert.match(fallback.diagnosticFallback, /不写入设置/);
	assert.match(fallback.noticeFallback, /不会写入设置/);
	assert.match(setting.diagnosticFallback, /禁用扩展启动/);
	for (const copy of [setting, fallback]) {
		// 要读完并决定是否去设置，不能按普通瞬时反馈（2.5s）一闪而过
		assert.ok(
			copy.noticeDurationMs >= 6000,
			`notice duration too short: ${copy.noticeDurationMs}`,
		);
	}
});

test("禁用扩展文案的中英文词条齐备（缺词条时 toast 会直接显示 key）", () => {
	const mainZh = readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8");
	const rendererZh = readFileSync(
		"src/renderer/src/i18n/rendererCopy.zh-CN.ts",
		"utf8",
	);
	const rendererEn = readFileSync(
		"src/renderer/src/i18n/rendererCopy.en-US.ts",
		"utf8",
	);
	for (const reason of ["setting", "fallback"]) {
		const copy = resolveDisabledExtensionsCopy(reason);
		assert.match(
			mainZh,
			new RegExp(`"${copy.diagnosticKey.replaceAll(".", "\\.")}"`),
		);
		assert.match(
			rendererZh,
			new RegExp(`"${copy.noticeKey.replaceAll(".", "\\.")}"`),
		);
		assert.match(
			rendererEn,
			new RegExp(`"${copy.noticeKey.replaceAll(".", "\\.")}"`),
		);
	}
	for (const file of [rendererZh, rendererEn]) {
		assert.match(file, /"notice\.openDevExtensionsSettings"/);
	}
});

test("禁用扩展启动会提示用户：每次运行一次 toast + 去设置深链", () => {
	const agent = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// 提示入口统一：设置开关与本次回退走同一处，且每个成因每次运行只弹一次（自动重连/新建会话会反复走到这）
	assert.match(agent, /private notifyExtensionsDisabled\(/);
	assert.match(
		agent,
		/private readonly disabledExtensionsNoticesSent =\s*new Set<DisabledExtensionsReason>\(\)/,
	);
	assert.match(agent, /this\.disabledExtensionsNoticesSent\.has\(reason\)/);
	assert.equal(
		(agent.match(/this\.notifyExtensionsDisabled\(/g) ?? []).length,
		2,
		"创建与重连两条启动路径都要提示",
	);
	// 动作只以符号 id 下发，UI 路径留在渲染层
	assert.match(agent, /action: copy\.noticeAction/);

	const bridge = readFileSync(
		"src/renderer/src/hooks/useSessionRuntimeBridge.ts",
		"utf8",
	);
	assert.match(bridge, /notice\.action === "openDevExtensionsSettings"/);
	assert.match(
		bridge,
		/openSettingsAtom, \{ tab: "dev", section: "dev-pi-rpc" \}/,
	);

	const atoms = readFileSync("src/renderer/src/atoms/app-ui-atoms.ts", "utf8");
	// section 保持「字面量联合」而不是宽松 string：锚点拼错必须在编译期被拦住
	// （运行时找不到元素只会静默不滚动）。固定分区显式列出，细粒度设置项由清单推导。
	assert.match(atoms, /"dev-pi-rpc"/);
	assert.match(atoms, /SettingsFieldAnchorSlug/);
	// 锚点必须真实存在，否则深链滚动到空气（useSettingsFocus 2s 后静默放弃）
	const devTab = readFileSync(
		"src/renderer/src/components/app/settings/DevTab.tsx",
		"utf8",
	);
	assert.match(devTab, /id="settings-section-dev-pi-rpc"/);
});

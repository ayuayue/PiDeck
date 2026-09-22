import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { dshSendBlockReason } = loadTsCommonJs("src/shared/types/dshRuntime.ts");
// 斜杠命令分类是纯函数：注入真实实现（而不是替身），避免测试里的判定与生产漂移。
const { classifyComposerSlashCommand } = loadTsCommonJs("src/renderer/src/utils/composerSlashCommand.ts");

function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubs[specifier] ?? {};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
			crypto: { randomUUID: () => "request-id" },
			Set,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const sendSource = () => readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
const areaSource = () => readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const runtimeSource = () => readFileSync("src/renderer/src/components/session/ComposerRuntimeIntegrations.tsx", "utf8");

function loadSendHelpers() {
	return compile("src/renderer/src/hooks/useSessionSend.ts", {
		react: { useRef: (value) => ({ current: value }) },
		jotai: { useAtomValue: () => undefined, useSetAtom: () => () => undefined },
		"../components/session/composer/quoteChip": {
			expandQuoteTokens: () => null,
			stripQuoteTokens: (text) => text.trim(),
		},
		"../i18n": { translateI18nDescriptor: (_descriptor, fallback) => fallback },
		"../utils/composerSlashCommand": { classifyComposerSlashCommand },
	});
}

function loadImageHelpers() {
	return compile("src/renderer/src/utils/composerImages.ts");
}

function loadControllerHelpers() {
	return compile("src/renderer/src/hooks/useSessionComposerController.ts", {
		react: {},
		jotai: {},
	});
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createSendHarness(initial = {}) {
	const atoms = {
		sessionDraftByIdAtom: {},
		sessionAttachmentsByIdAtom: {},
		sessionQuotesByIdAtom: {},
		sessionComposerModeByIdAtom: {},
		sessionRuntimeByIdAtom: {},
		sessionRecordsAtom: {},
		setSessionDraftAtom: {},
		setSessionAttachmentsAtom: {},
		setSessionQuotesAtom: {},
		setSessionSendStateAtom: {},
		bindSessionRuntimeAtom: {},
		upsertSessionAtom: {},
		// DSH 发送拦截门读取的只读 atom（初值 installed，测试按需改写）。
		dshRuntimeStatusAtom: {},
		openSettingsAtom: {},
	};
	const state = new Map([
		[atoms.sessionDraftByIdAtom, { ...(initial.drafts ?? {}) }],
		[atoms.sessionAttachmentsByIdAtom, { ...(initial.attachments ?? {}) }],
		[atoms.sessionQuotesByIdAtom, { ...(initial.quotes ?? {}) }],
		[atoms.sessionComposerModeByIdAtom, { ...(initial.modes ?? {}) }],
		[atoms.sessionRuntimeByIdAtom, { ...(initial.runtimes ?? {}) }],
		[atoms.sessionRecordsAtom, { ...(initial.records ?? {}) }],
		[atoms.dshRuntimeStatusAtom, { state: "installed" }],
	]);
	// DSH runtime 拦截时弹的「去安装」提示（showDshRuntimeBlockHint 的替身）。
	const hints = [];
	const setAtom = (atom, input) => {
		if (atom === atoms.setSessionDraftAtom) {
			const next = { ...state.get(atoms.sessionDraftByIdAtom) };
			const current = next[input.sessionId] ?? "";
			const value = typeof input.value === "function" ? input.value(current) : input.value;
			if (value) next[input.sessionId] = value;
			else delete next[input.sessionId];
			state.set(atoms.sessionDraftByIdAtom, next);
		} else if (atom === atoms.setSessionAttachmentsAtom) {
			const next = { ...state.get(atoms.sessionAttachmentsByIdAtom) };
			const current = next[input.sessionId] ?? [];
			const value = typeof input.value === "function" ? input.value(current) : input.value;
			if (value.length) next[input.sessionId] = value;
			else delete next[input.sessionId];
			state.set(atoms.sessionAttachmentsByIdAtom, next);
		} else if (atom === atoms.setSessionQuotesAtom) {
			// 引用快照仓写入（发送清屏时随之清空）；与 draft 同构的函数式更新
			const next = { ...state.get(atoms.sessionQuotesByIdAtom) };
			const current = next[input.sessionId] ?? {};
			const value = typeof input.value === "function" ? input.value(current) : input.value;
			if (Object.keys(value).length > 0) next[input.sessionId] = value;
			else delete next[input.sessionId];
			state.set(atoms.sessionQuotesByIdAtom, next);
		} else if (atom === atoms.setSessionSendStateAtom) {
			const next = { ...state.get("sendStates") };
			if (input.state.status === "idle") delete next[input.sessionId];
			else next[input.sessionId] = input.state;
			state.set("sendStates", next);
		}
	};
	const module = compile("src/renderer/src/hooks/useSessionSend.ts", {
		react: { useRef: (value) => ({ current: value }) },
		jotai: {
			useAtomValue: (atom) => state.get(atom),
			useSetAtom: (atom) => (input) => setAtom(atom, input),
			useStore: () => ({ get: (atom) => state.get(atom), set: (atom, input) => setAtom(atom, input) }),
		},
		"../atoms": atoms,
		"../composerBehavior": {
			expandPromptTemplates: (message) => ({ message }),
			buildComposerPromptSubmission: (message) => ({ message }),
			deriveComposerAgentMode: () => "normal",
			applyDshGoalSendTransform: (submission) => submission,
		},
		// 引用展开桩：无引用场景展开返回 null（沿用原文）、剥离即 trim
		"../components/session/composer/quoteChip": {
			expandQuoteTokens: () => null,
			stripQuoteTokens: (text) => text.trim(),
		},
		"../i18n": {
			translateI18nDescriptor: (_descriptor, fallback) => fallback,
			t: (key) => key,
		},
		// DSH 发送拦截：真实纯函数 + 提示替身（记录调用，不真弹 sonner toast）。
		"../../../shared/types/dshRuntime": { dshSendBlockReason },
		// `/login` 拦截后的入口：记录调用参数，断言「没被当普通消息发出去」。
		"../utils/composerSlashCommand": { classifyComposerSlashCommand },
		"../utils/dshRuntimeHint": {
			// useSessionSend 顶部还解构了 DSH_INSTALL_SETTINGS_TARGET / maybeHintMissingDshRunnerNode
			// （后者在 DSH 会话放行后调用，探测本机 Node）；测试环境 desktopApi 不存在，桩为 no-op。
			DSH_INSTALL_SETTINGS_TARGET: { tab: "common", pane: "config", backendPane: "dsh" },
			showDshRuntimeBlockHint: (_openSettings, state, reason) => {
				hints.push({ state, reason });
			},
			maybeHintMissingDshRunnerNode: () => {},
		},
	});
	return {
		state,
		atoms,
		hints,
		send: (options) => module.useSessionSend(options),
	};
}

test("the real send state machine snapshots multiline atom text", async () => {
	const harness = createSendHarness({ drafts: { "session-a": "first\nsecond" } });
	const deferred = createDeferred();
	let submitted;
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		sendPrompt: async (input) => {
			submitted = input;
			return deferred.promise;
		},
	});
	const pending = send();
	assert.equal(submitted.message, "first\nsecond");
	deferred.resolve({ accepted: true });
	await pending;
});

test("the real send state machine preserves input typed during a rejected delivery", async () => {
	const harness = createSendHarness({ drafts: { "session-a": "first\nsecond" } });
	const deferred = createDeferred();
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		sendPrompt: async () => deferred.promise,
	});
	const pending = send();
	harness.state.set(harness.atoms.sessionDraftByIdAtom, { "session-a": "new\ninput" });
	deferred.resolve({ accepted: false, delivery: "rejected", error: "rejected" });
	await pending;
	assert.equal(harness.state.get(harness.atoms.sessionDraftByIdAtom)["session-a"], "first\nsecond\n\nnew\ninput");
	assert.equal(harness.state.get("sendStates")["session-a"].status, "error");
});

test("the real send state machine handles pure images, double clicks, and unknown delivery", async () => {
	const image = { type: "image", data: "x", mimeType: "image/png" };
	const imageHarness = createSendHarness({ attachments: { "session-a": [image] } });
	let imageCalls = 0;
	const imageSend = imageHarness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		sendPrompt: async (input) => {
			imageCalls += 1;
			assert.deepEqual(JSON.parse(JSON.stringify(input.images)), [image]);
			return { accepted: true };
		},
	});
	await imageSend();
	assert.equal(imageCalls, 1);

	const clickHarness = createSendHarness({ drafts: { "session-a": "once" } });
	const clickDeferred = createDeferred();
	let clickCalls = 0;
	const clickSend = clickHarness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		sendPrompt: async () => {
			clickCalls += 1;
			return clickDeferred.promise;
		},
	});
	const first = clickSend();
	const second = clickSend();
	assert.equal(clickCalls, 1);
	clickDeferred.resolve({ accepted: true });
	await Promise.all([first, second]);

	const unknownHarness = createSendHarness({ drafts: { "session-a": "maybe" } });
	let unknownCalls = 0;
	const unknownSend = unknownHarness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		sendPrompt: async () => {
			unknownCalls += 1;
			return { accepted: false, delivery: "unknown", error: "timeout" };
		},
	});
	await unknownSend();
	assert.equal(unknownHarness.state.get(unknownHarness.atoms.sessionDraftByIdAtom)["session-a"], undefined);
	const unknownState = unknownHarness.state.get("sendStates")["session-a"];
	assert.equal(unknownState.status, "unknown");
	assert.equal(unknownState.unknownSnapshot.message, "maybe");
	assert.equal(unknownState.unknownSnapshot.images, undefined);
	assert.equal(unknownCalls, 1, "unknown delivery must never auto-retry");
});

test("a pre-send Chat surface promotes once and only sends through its real Session", async () => {
	const bootstrapId = "renderer:chat-bootstrap";
	const realSessionId = "catalog-session";
	const harness = createSendHarness({ drafts: { [bootstrapId]: "start after send" } });
	const promotion = createDeferred();
	let promotionCalls = 0;
	let submitted;
	const send = harness.send({
		sessionId: bootstrapId,
		templates: [],
		compact: async () => undefined,
		ensureSessionId: async (sourceSessionId) => {
			promotionCalls += 1;
			assert.equal(sourceSessionId, bootstrapId);
			return promotion.promise;
		},
		sendPrompt: async (input) => {
			submitted = input;
			return { accepted: true };
		},
	});

	const first = send();
	const second = send();
	assert.equal(promotionCalls, 1, "double-clicking cannot create two Catalog Sessions");
	promotion.resolve(realSessionId);
	await Promise.all([first, second]);
	assert.equal(submitted.sessionId, realSessionId);
	assert.equal(submitted.message, "start after send");
});

test("Composer identity is session-only and send snapshots address the captured Session", () => {
	const source = sendSource();
	assert.match(source, /sessionId: string/);
	assert.match(source, /const sourceSessionId = options\.sessionId/);
	assert.match(source, /setSendState\(\{\s*sessionId/);
	assert.match(source, /sendPrompt\(\{\s*sessionId,\s*requestId/);
	assert.match(source, /store\.get\(sessionDraftByIdAtom\)\[sourceSessionId\]/);
	assert.match(source, /store\.get\(sessionAttachmentsByIdAtom\)\[sourceSessionId\]/);
	assert.match(source, /options\.ensureSessionId\s*\? await options\.ensureSessionId\(sourceSessionId\)/);
	assert.doesNotMatch(source, /currentSessionIdAtom|selectedSessionId|getComposerText|liveDraftsRef|runtimeAgentId\?:/);
	assert.doesNotMatch(source, /setActiveAgentId/);
});

test("A/B switching cannot clear or restore the other Session draft", () => {
	const source = sendSource();
	// 清空/恢复都抽到了同名前缀的 helper（第三参 keepDraft 供快捷消息直发复用），
	// 但第一个参数必须仍是本次发送捕获的 sessionId：切到 B 后再回填不能动 B 的草稿。
	assert.match(source, /clearComposerSnapshot\(sessionId, keepDraft\)/);
	// 拒绝恢复用原始草稿（rawDraft，含引用 token）：保留 chip 形态供用户修改重发；
	// unknown 快照仍存展开后文本（已实际投递的内容）
	assert.match(source, /restoreRejectedPrompt\(sessionId, keepDraft, rawDraft, imageSnapshot\)/);
	assert.match(source, /restoreRejectedSnapshot\(targetSessionId, message, imageSnapshot\)/);
	// 输入框临时 UI（↑ 历史、DOM 草稿镜像）同样必须留 keepDraft 出口，否则直发会把用户草稿镜像置空
	assert.match(source, /function resetComposerEphemeralUi\(keepDraft: boolean\) \{\s*if \(keepDraft\) return;/);
	assert.equal(source.match(/options\.resetComposerUi\?\.\(\)/g)?.length, 1, "resetComposerUi 必须统一走 resetComposerEphemeralUi 收口");
	assert.match(source, /setDraft\(\{\s*sessionId: targetSessionId/);
	assert.match(source, /setAttachments\(\{\s*sessionId: targetSessionId/);
});

test("sending-time input is appended after a rejected snapshot without losing images", () => {
	const { mergeRejectedComposerDraft, mergeRejectedComposerImages } = loadSendHelpers();
	assert.equal(mergeRejectedComposerDraft("first", "new input"), "first\n\nnew input");
	const oldImage = { type: "image", data: "old", mimeType: "image/png" };
	const newImage = { type: "image", data: "new", mimeType: "image/png" };
	assert.equal(JSON.stringify(mergeRejectedComposerImages([oldImage], [newImage])), JSON.stringify([oldImage, newImage]));
});

test("pure image submissions and double-click sends are guarded", () => {
	const { createSessionSendLock, hasComposerSubmission } = loadSendHelpers();
	assert.equal(hasComposerSubmission("", [{ type: "image", data: "x", mimeType: "image/png" }]), true);
	assert.equal(hasComposerSubmission("  ", []), false);
	const lock = createSessionSendLock();
	assert.equal(lock.claim("session-a"), true);
	assert.equal(lock.claim("session-a"), false);
	assert.equal(lock.claim("session-b"), true, "A/B sessions have isolated send locks");
	lock.release("session-a");
	assert.equal(lock.claim("session-a"), true);
});

test("unknown delivery is terminal and is not folded into rejected recovery", () => {
	const { classifySessionPromptResult } = loadSendHelpers();
	assert.equal(classifySessionPromptResult({ accepted: true }), "accepted");
	assert.equal(classifySessionPromptResult({ accepted: false, delivery: "rejected", error: "no" }), "rejected");
	assert.equal(classifySessionPromptResult({ accepted: false, delivery: "unknown", error: "timeout" }), "unknown");
	const source = sendSource();
	// 块边界不能假设 6 空格缩进（formatter 统一为 tab）：用行首空白无关的 } else { 锚点。
	const unknownBranch = source.match(/else if \(outcome === "unknown"\) \{[\s\S]*?\n[\t ]*\} else \{/)?.[0] ?? "";
	assert.doesNotMatch(unknownBranch, /restoreRejectedSnapshot/);
	// 类型成员可能被格式化换行且可选标记写法不同：容忍空白与长度。
	assert.match(unknownBranch, /unknownSnapshot\??: \{[\s\S]{0,160}?message/);
});

test("ComposerArea keeps legacy runtime queue outside the Session draft leaf", () => {
	assert.match(areaSource(), /queuePanel\?: ReactNode/);
	assert.match(areaSource(), /\{props\.queuePanel\}/);
	assert.doesNotMatch(areaSource(), /queuedPromptQueue/);
	assert.doesNotMatch(areaSource(), /from ["']\.\.\/\.\.\/App["']/);
	assert.doesNotMatch(readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8"), /queuedPromptQueue/);
});

test("first send publishes activating feedback before Session promotion", () => {
	const source = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
	const optimisticIndex = source.indexOf("publishOptimisticSubmission(sourceSessionId)");
	const ensureIndex = source.indexOf("await options.ensureSessionId(sourceSessionId)");
	assert.ok(optimisticIndex >= 0, "first-send optimistic publication must exist");
	assert.ok(ensureIndex >= 0, "Session promotion must remain in the send path");
	assert.ok(optimisticIndex < ensureIndex, "feedback must be published before promotion awaits");
	assert.match(source, /state: \{ status: "activating", requestId \}/);
});

test("runtime widgets require the current Session binding generation", () => {
	const { sameRuntimeHandle, isCoherentComposerRuntimeUi } = compile("src/renderer/src/components/session/ComposerRuntimeIntegrations.tsx", {
		react: {},
		jotai: {},
	});
	assert.equal(sameRuntimeHandle({ agentId: "a", runtimeGeneration: 2 }, { agentId: "a", runtimeGeneration: 2 }), true);
	assert.equal(sameRuntimeHandle({ agentId: "a", runtimeGeneration: 2 }, { agentId: "a", runtimeGeneration: 1 }), false);
	assert.equal(isCoherentComposerRuntimeUi({ agentId: "a", runtimeGeneration: 2 }, { agentId: "a", runtimeGeneration: 1 }), false);
	assert.equal(isCoherentComposerRuntimeUi(undefined, { agentId: "a", runtimeGeneration: 2 }), false);
	assert.match(runtimeSource(), /runtimeUi\.agentId === runtime\.agentId/);
	assert.match(runtimeSource(), /runtimeUi\.runtimeGeneration === runtime\.runtimeGeneration/);
	assert.match(runtimeSource(), /const sequence = \+\+botRequestSequenceRef\.current/);
	assert.match(runtimeSource(), /getSessionBot\(props\.sessionId\)/);
	assert.match(runtimeSource(), /activeSessionId=\{props\.sessionId\}/);
	assert.doesNotMatch(runtimeSource(), /getSessionBot\(expected\.agentId\)/);
});

// 回归（打开历史会话点飞书连接不启动 Agent）：setRuntimeBot 不得在无 runtime 时拦截请求——
// 主进程 feishuSessionBotSet 会自动启动 runtime 并绑定；只有请求期间 runtime 被替换才丢弃结果。
test("setRuntimeBot forwards Feishu binding even without a runtime handle", () => {
	const src = runtimeSource();
	// 块结束边界不能假设两空格缩进（formatter 统一为 tab）：用行首缩进无关的 } 锚点。
	const block = src.match(/async function setRuntimeBot[\s\S]*?return result;\n[\t ]*\}/)?.[0] ?? "";
	assert.ok(block, "setRuntimeBot must exist");
	// 不再有无 runtime 即 return 的守卫
	assert.doesNotMatch(block, /if \(!expected\) return;/);
	assert.doesNotMatch(block, /if \(!expected\) \{?\s*return/);
	// 请求始终发往主进程
	assert.match(block, /feishu\.setSessionBot\(sessionId, botId\)/);
	// 无 expected 时结果必须生效；有 expected 时仍防 A→B 替换竞态
	assert.match(block, /if \(!expected \|\| sameRuntimeHandle\(runtimeHandleRef\.current, expected\)\) \{/);
});

test("a delayed same-generation editor command cannot overwrite a user edit", () => {
	const { createComposerDraftGuard, markComposerDraftMutation, canApplyRuntimeEditorText } = loadControllerHelpers();
	let guard = createComposerDraftGuard({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 4,
		draft: "",
	});
	assert.equal(
		canApplyRuntimeEditorText(guard, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 4,
			currentDraft: "",
		}),
		true,
	);
	guard = markComposerDraftMutation(guard);
	assert.equal(
		canApplyRuntimeEditorText(guard, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 4,
			currentDraft: "user edit",
		}),
		false,
	);
	assert.equal(
		canApplyRuntimeEditorText(
			createComposerDraftGuard({
				sessionId: "session-a",
				agentId: "agent-a",
				runtimeGeneration: 5,
				draft: "",
			}),
			{
				sessionId: "session-a",
				agentId: "agent-a",
				runtimeGeneration: 5,
				currentDraft: "",
			},
		),
		true,
	);
});

test("deferred template results are accepted only for the current Session/project key", async () => {
	const { createLatestRequestGate } = loadControllerHelpers();
	const gate = createLatestRequestGate();
	const a = createDeferred();
	const b = createDeferred();
	const aToken = gate.begin("session-a:project-a");
	const bToken = gate.begin("session-b:project-b");
	const accepted = [];
	a.promise.then((value) => {
		if (gate.isCurrent(aToken)) accepted.push(value);
	});
	b.promise.then((value) => {
		if (gate.isCurrent(bToken)) accepted.push(value);
	});
	a.resolve("templates-a");
	b.resolve("templates-b");
	await Promise.all([a.promise, b.promise]);
	assert.deepEqual(accepted, ["templates-b"]);
});

test("selected Session reference messages zip original indices with compressed messages", () => {
	const { createSessionReferenceSelection, selectedSessionReferenceMessages } = loadControllerHelpers();
	const selection = createSessionReferenceSelection(
		[1, 4],
		[
			{ role: "user", content: "selected one", timestamp: 1 },
			{ role: "assistant", content: "selected four", timestamp: 4 },
		],
	);
	assert.deepEqual(JSON.parse(JSON.stringify(selectedSessionReferenceMessages(selection))), [
		{ role: "user", content: "selected one", timestamp: 1 },
		{ role: "assistant", content: "selected four", timestamp: 4 },
	]);
	assert.equal(selection.entries[0].index, 1);
	assert.equal(selection.entries[1].index, 4);
});

test("DSH busy send defaults to followUp; menu insert is explicit steer", () => {
	const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	// Enter / 主发送按钮：忙碌投递走统一策略（设置项 busySendDelivery）。
	assert.match(controller, /resolveBusySendDelivery\(isBusy, store\.get\(busySendDeliveryAtom\)\)/);
	// 客户端队列未指定行为时，同样走统一策略。
	assert.match(app, /resolveBusySendDelivery\(/);
});

test("image handling keeps GIFs lossless and rejects unsupported/oversized files", () => {
	const source = readFileSync("src/renderer/src/utils/composerImages.ts", "utf8");
	const helpers = loadImageHelpers();
	assert.equal(JSON.stringify(helpers.dataUrlToImageContent("data:image/png;base64,abc", "image/jpeg")), JSON.stringify({ type: "image", data: "abc", mimeType: "image/png" }));
	assert.match(source, /file\.type === "image\/gif"\) return fileToImageContent\(file\)/);
	assert.match(source, /COMPOSER_IMAGE_MAX_BYTES/);
});

test("/new is intercepted as a desktop session create, not sent to pi", async () => {
	const harness = createSendHarness({ drafts: { "session-a": "/new" } });
	let sendPromptCalls = 0;
	let createCalls = 0;
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		createNewSession: async () => {
			createCalls += 1;
		},
		sendPrompt: async () => {
			sendPromptCalls += 1;
			return { accepted: true };
		},
	});
	await send();
	assert.equal(createCalls, 1);
	assert.equal(sendPromptCalls, 0);
	assert.equal(harness.state.get(harness.atoms.sessionDraftByIdAtom)["session-a"], undefined);
});

test("/login opens the provider login dialog instead of being sent to pi", async () => {
	const harness = createSendHarness({ drafts: { "session-a": "/login anthropic" } });
	let sendPromptCalls = 0;
	const opened = [];
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		openProviderLogin: (providerId) => {
			opened.push(providerId);
		},
		sendPrompt: async () => {
			sendPromptCalls += 1;
			return { accepted: true };
		},
	});
	await send();
	// 回归背景：`/login` 以前落进普通发送分支被模型「回答」，这里锁住三条边界。
	assert.equal(sendPromptCalls, 0, "login must not reach sendPrompt");
	assert.deepEqual(opened, ["anthropic"], "provider argument is forwarded");
	assert.equal(harness.state.get(harness.atoms.sessionDraftByIdAtom)["session-a"], undefined, "draft is cleared like /new");
	// sendStates 在从未发送过的会话上是空值：用可选链断言「没被占用」。
	assert.equal(harness.state.get("sendStates")?.["session-a"], undefined, "login must not occupy the send lock");
});

test("a bare /login without provider still opens the dialog", async () => {
	const harness = createSendHarness({ drafts: { "session-a": "/login" } });
	const opened = [];
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		openProviderLogin: (providerId) => {
			opened.push(providerId);
		},
		sendPrompt: async () => ({ accepted: true }),
	});
	await send();
	assert.deepEqual(opened, [undefined]);
});

test("DSH session send is blocked with a friendly hint when runtime is missing", async () => {
	const harness = createSendHarness({
		drafts: { "session-a": "hello dsh" },
		records: { "session-a": { id: "session-a", backend: "dsh" } },
	});
	harness.state.set(harness.atoms.dshRuntimeStatusAtom, { state: "notInstalled" });
	let sendPromptCalls = 0;
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		sendPrompt: async () => {
			sendPromptCalls += 1;
			return { accepted: true };
		},
	});
	await send();
	// 拦截发生在发送前：不发 RPC、不发布乐观气泡、不占发送锁，草稿保留供装好重试。
	assert.equal(sendPromptCalls, 0, "runtime-missing dsh send must not reach sendPrompt");
	assert.equal(harness.state.get("sendStates")["session-a"].status, "error");
	assert.equal(harness.hints.length, 1, "must show the install hint");
	assert.equal(harness.hints[0].state, "notInstalled");
	assert.equal(harness.state.get(harness.atoms.sessionDraftByIdAtom)["session-a"], "hello dsh", "draft must survive the block for retry after install");
});

test("DSH session send blocks with broken reason when runtime is broken", async () => {
	const harness = createSendHarness({
		drafts: { "session-a": "ping" },
		records: { "session-a": { id: "session-a", backend: "dsh" } },
	});
	harness.state.set(harness.atoms.dshRuntimeStatusAtom, {
		state: "broken",
		reason: "version mismatch",
	});
	let sendPromptCalls = 0;
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => undefined,
		sendPrompt: async () => {
			sendPromptCalls += 1;
			return { accepted: true };
		},
	});
	await send();
	assert.equal(sendPromptCalls, 0);
	assert.deepEqual(harness.hints[0], { state: "broken", reason: "version mismatch" });
});

test("DSH session send passes through when runtime is installed or checking", async () => {
	for (const state of ["installed", "checking"]) {
		const harness = createSendHarness({
			drafts: { "session-a": "hello dsh" },
			records: { "session-a": { id: "session-a", backend: "dsh" } },
		});
		harness.state.set(harness.atoms.dshRuntimeStatusAtom, { state });
		let sendPromptCalls = 0;
		const send = harness.send({
			sessionId: "session-a",
			templates: [],
			compact: async () => undefined,
			sendPrompt: async () => {
				sendPromptCalls += 1;
				return { accepted: true };
			},
		});
		await send();
		assert.equal(sendPromptCalls, 1, `${state} must not block the send`);
		assert.equal(harness.hints.length, 0, `${state} must not show the install hint`);
	}
});

test("/compact releases the send lock so a follow-up prompt can send", async () => {
	const harness = createSendHarness({
		drafts: { "session-a": "/compact" },
		runtimes: {
			"session-a": { agentId: "agent-a", runtimeGeneration: 1 },
		},
	});
	let compactCalls = 0;
	let sendPromptCalls = 0;
	const send = harness.send({
		sessionId: "session-a",
		templates: [],
		compact: async () => {
			compactCalls += 1;
		},
		sendPrompt: async () => {
			sendPromptCalls += 1;
			return { accepted: true };
		},
	});
	await send();
	assert.equal(compactCalls, 1);
	assert.equal(sendPromptCalls, 0);
	harness.state.set(harness.atoms.sessionDraftByIdAtom, { "session-a": "after compact" });
	await send();
	assert.equal(sendPromptCalls, 1, "/compact must not leave sendingSessionIdsRef occupied");
});

test("quote tokens expand at the send entry before any snapshot is published", () => {
	const source = sendSource();
	// 审计定稿：读取草稿后立即展开（乐观缓存/队列/历史全部消费展开后文本），
	// 且「只有引用没有正文」在发送前被拦截
	assert.match(source, /expandQuoteTokens\(rawDraft, \(id\) => quoteMap\?\.\[id\]\)/);
	assert.match(source, /!stripQuoteTokens\(rawDraft\)\.trim\(\) && !imageSnapshot/);
});

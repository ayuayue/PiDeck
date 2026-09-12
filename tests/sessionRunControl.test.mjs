import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 会话运行控制策略（全状态可操作）回归测试。
 *
 * 产品规则：任意状态都必须能操作运行控制，不为「没进程/进程死了」留死角。
 * 策略是纯函数，这里按状态逐个断言四项能力的可用性，锁住三件事：
 * 1. 任何状态都不会「四项全禁用」；
 * 2. 未启动/失败/已关闭的主控动作是 start（而不是 restart）；
 * 3. live 态的主控动作是 restart 且需要确认（会中断当前回答）。
 */
function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = {
		exports: {},
		require: (specifier) => {
			// sessionCommands 只依赖 i18n 做报错文案；策略部分是纯函数，给个 stub 即可。
			if (specifier === "../i18n") {
				return { t: (key) => key };
			}
			throw new Error(`Unexpected import: ${specifier}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/utils/sessionCommands.ts"), sandbox, {
		filename: "sessionCommands.ts",
	});
	return sandbox.exports;
}

const { resolveSessionRunState, sessionRunCapabilities, canRunSessionAction, resolveProxyApplyStrategy } = loadModule();

/** 所有状态 + binding 组合：覆盖「无进程」的两类以及终态持有绑定的情形。 */
const STATE_MATRIX = [
	{ state: "unstarted", hasBinding: false },
	{ state: "detached", hasBinding: false },
	{ state: "detached", hasBinding: true },
	{ state: "starting", hasBinding: true },
	{ state: "idle", hasBinding: true },
	{ state: "running", hasBinding: true },
	{ state: "error", hasBinding: true },
	{ state: "closed", hasBinding: true },
];

test("every run state exposes at least one usable run-control action", () => {
	for (const input of STATE_MATRIX) {
		const caps = sessionRunCapabilities(input);
		const usable = ["start", "stop", "reload"].filter((action) =>
			canRunSessionAction(caps, action),
		);
		assert.ok(
			usable.length > 0,
			`state=${input.state} binding=${input.hasBinding} should keep at least one action enabled`,
		);
	}
});

test("states without a live process use start as the primary action", () => {
	// 未启动 / 已解绑 / 失败 / 已关闭：进程不存在或已死，语义是「启动」而非「重启」。
	for (const input of [
		{ state: "unstarted", hasBinding: false },
		{ state: "detached", hasBinding: false },
		{ state: "error", hasBinding: true },
		{ state: "closed", hasBinding: true },
	]) {
		const caps = sessionRunCapabilities(input);
		assert.equal(caps.primaryAction, "start", `state=${input.state}`);
		assert.equal(caps.canRestart, true, `state=${input.state} should still be startable`);
		// 终态没有可停的进程：停止必须禁用，避免把已死的绑定再停一次。
		assert.equal(caps.canStop, false, `state=${input.state} has no process to stop`);
		// 无进程时可以磁盘重载。
		assert.equal(caps.canReload, true, `state=${input.state} should allow reload`);
	}
});

test("live states use restart and require confirmation", () => {
	for (const state of ["idle", "running"]) {
		const caps = sessionRunCapabilities({ state, hasBinding: true });
		assert.equal(caps.primaryAction, "restart", `state=${state}`);
		assert.equal(caps.canStop, true, `state=${state} should be stoppable`);
		assert.equal(caps.canRestart, true, `state=${state} should be restartable`);
		// live 态强刷磁盘会覆盖内存中的流式消息：重载必须禁用。
		assert.equal(caps.canReload, false, `state=${state} must not allow disk reload`);
		// 重启会打断当前回答，必须走确认。
		assert.equal(caps.requiresConfirm, true, `state=${state} needs confirm`);
	}
});

test("starting blocks start/restart but keeps stop as a manual escape hatch", () => {
	const caps = sessionRunCapabilities({ state: "starting", hasBinding: true });
	// 握手期间再点启动/重启会与正在进行的 fork 竞争，必须挡住。
	assert.equal(caps.canRestart, false);
	assert.equal(canRunSessionAction(caps, "start"), false);
	assert.equal(caps.pending, true);
	// 但进程卡在启动阶段时，用户需要手动中断：停止保留可用。
	assert.equal(caps.canStop, true);
	assert.equal(canRunSessionAction(caps, "stop"), true);
	// 进程虽未 ready 但确实存在：不允许磁盘强刷。
	assert.equal(canRunSessionAction(caps, "reload"), false);
});

test("busy flag suppresses every action to avoid concurrent rebinds", () => {
	for (const input of STATE_MATRIX) {
		const caps = sessionRunCapabilities({ ...input, busy: true });
		assert.equal(caps.canStart, false, `state=${input.state} busy`);
		assert.equal(caps.canStop, false, `state=${input.state} busy`);
		assert.equal(caps.canReload, false, `state=${input.state} busy`);
	}
});

test("in-flight queued prompts block restart but not stop", () => {
	const caps = sessionRunCapabilities({
		state: "running",
		hasBinding: true,
		hasInFlightQueuedPrompt: true,
	});
	// 队列里还有 sending/unknown 的消息：重启会丢消息，必须挡住。
	assert.equal(caps.canRestart, false);
	// 停止仍然可用（用户主动停机是明确的丢弃意图）。
	assert.equal(caps.canStop, true);
});

test("resolveSessionRunState normalizes runtime snapshots", () => {
	assert.equal(resolveSessionRunState({ status: "running" }, true), "running");
	assert.equal(resolveSessionRunState({ status: "error" }, true), "error");
	// 前端视图态 detached 与主进程未知值分开处理。
	assert.equal(resolveSessionRunState({ status: "detached" }, false), "detached");
	// 没有 runtime 行但有绑定 → 视为已解绑；无绑定 → 从未启动。
	assert.equal(resolveSessionRunState(undefined, true), "detached");
	assert.equal(resolveSessionRunState(undefined, false), "unstarted");
	// 状态缺失时同样按绑定情况归一化，不返回 undefined。
	assert.equal(resolveSessionRunState({}, false), "unstarted");
});

test("canRunSessionAction maps start and restart onto the same capability", () => {
	const startable = sessionRunCapabilities({ state: "closed", hasBinding: true });
	assert.equal(canRunSessionAction(startable, "start"), true);
	assert.equal(canRunSessionAction(startable, "restart"), true);

	const live = sessionRunCapabilities({ state: "running", hasBinding: true });
	assert.equal(canRunSessionAction(live, "start"), true);
	assert.equal(canRunSessionAction(live, "reload"), false);
});

// ── 会话代理设置的生效方式（一步开代理）──
//
// 用户痛点：改了代理设置后要自己「停止 → 启动」两步才能生效。
// 规则：代理注入在 spawn env 上，能重启就自动重启（一步生效）；
// DSH 共享 host 永远不按会话重启（会波及所有 DSH 会话）。

test("proxy apply strategy restarts a live pi session so the change takes effect at once", () => {
	assert.equal(
		resolveProxyApplyStrategy({ backend: "pi", hasBinding: true, isLive: true }),
		"restart-now",
	);
	// 后端缺省视为 pi（旧数据兼容），同样享受自动重启。
	assert.equal(
		resolveProxyApplyStrategy({ backend: undefined, hasBinding: true, isLive: true }),
		"restart-now",
	);
});

test("proxy apply strategy waits for next start when there is no live process", () => {
	// 未启动/已解绑：下次启动进程时自然读到新配置，不需要额外动作。
	assert.equal(
		resolveProxyApplyStrategy({ backend: "pi", hasBinding: false, isLive: false }),
		"next-start",
	);
	// 终态（error/closed）持有绑定但进程已死：重启没有意义，等下次启动。
	assert.equal(
		resolveProxyApplyStrategy({ backend: "pi", hasBinding: true, isLive: false }),
		"next-start",
	);
});

test("proxy apply strategy never auto-restarts the shared DSH host", () => {
	// DSH 是单一共享 host：按会话重启会杀掉所有 DSH 会话，必须只提示不重启。
	for (const isLive of [true, false]) {
		for (const hasBinding of [true, false]) {
			assert.equal(
				resolveProxyApplyStrategy({ backend: "dsh", hasBinding, isLive }),
				"dsh-host-restart",
				`dsh live=${isLive} binding=${hasBinding} must not auto-restart`,
			);
		}
	}
});

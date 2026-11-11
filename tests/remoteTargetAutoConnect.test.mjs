/**
 * 配置目标：选中未连接的 SSH 主机时自动连接，而不是先报 REMOTE_CONFIG_HOST_NOT_READY。
 *
 * 三类断言：
 * 1. 纯状态机（remoteHostConnectionModel）：去重、失败稳定码、推送覆盖、未接线不启动请求；
 * 2. 远端配置面板 hook：先 ensure 再 read；连接失败不 read；读到 host-not-ready 时重连续读一次；
 * 3. 选择器/面板源码契约：动画、重试入口、WSL 空态提示、密码补录都还在。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const HOST = "11111111-1111-4111-8111-111111111111";
const HOST2 = "22222222-2222-4222-8222-222222222222";
const MODEL = "src/renderer/src/config/remoteHostConnectionModel.ts";
const HOOK = "src/renderer/src/config/useRemotePiConfigPanel.ts";
const SWITCH = "src/renderer/src/config/ConfigEnvironmentSwitch.tsx";
const PANEL = "src/renderer/src/config/RemoteConfigPanel.tsx";

const flush = async (ticks = 4) => {
	for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeStore(ports) {
	const { createRemoteHostConnectionStore } = loadTsCommonJs(MODEL);
	return createRemoteHostConnectionStore(ports);
}

test("start(): 列表状态补一次快照，推送覆盖同一主机", async () => {
	let push;
	const store = makeStore({
		list: async () => ({ ok: true, hosts: [], states: { [HOST]: "ready", [HOST2]: "offline" } }),
		onStateChange: (listener) => {
			push = listener;
			return () => undefined;
		},
	});
	store.start();
	await flush();
	assert.equal(store.snapshot().states[HOST], "ready");
	assert.equal(store.snapshot().states[HOST2], "offline");
	push({ hostId: HOST2, state: "ready" });
	assert.equal(store.snapshot().states[HOST2], "ready");
	// 不合法的推送整体丢弃，不把未知状态写进界面。
	push({ hostId: HOST2, state: "totally-fine" });
	assert.equal(store.snapshot().states[HOST2], "ready");
});

test("ensureConnected(): 离线时只发一次 connect，过程中是 connecting，成功后回 ready 并清错误", async () => {
	const gate = deferred();
	let calls = 0;
	const store = makeStore({
		connect: async () => {
			calls += 1;
			await gate.promise;
			return { ok: true, hostId: HOST, state: "ready" };
		},
	});
	const first = store.ensureConnected(HOST);
	const second = store.ensureConnected(HOST);
	assert.equal(calls, 1, "并发调用共享同一次 connect");
	assert.equal(store.snapshot().pending[HOST], true);
	assert.equal(store.snapshot().states[HOST], "connecting");
	gate.resolve();
	assert.equal((await first).ok, true);
	assert.equal((await second).ok, true);
	assert.equal(store.snapshot().pending[HOST], undefined);
	assert.equal(store.snapshot().states[HOST], "ready");

	// 已在线时不再打 IPC（这是「连接保持」的渲染层前提：面板重挂不会重复连）。
	assert.equal((await store.ensureConnected(HOST)).ok, true);
	assert.equal(calls, 1);
});

test("ensureConnected(): 失败只记稳定码并落离线；非稳定码回复不当成功", async () => {
	const store = makeStore({ connect: async () => ({ ok: false, hostId: HOST, code: "SSH_PASSWORD_REQUIRED" }) });
	const refused = await store.ensureConnected(HOST);
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "SSH_PASSWORD_REQUIRED");
	assert.equal(store.snapshot().errors[HOST], "SSH_PASSWORD_REQUIRED");
	assert.equal(store.snapshot().states[HOST], "offline");
	assert.equal(store.snapshot().pending[HOST], undefined);

	const invalid = makeStore({ connect: async () => ({ ok: false, code: "not a stable code" }) });
	const invalidResult = await invalid.ensureConnected(HOST);
	assert.equal(invalidResult.code, "REMOTE_CONNECTION_INVALID_RESULT");
	assert.equal(invalid.snapshot().errors[HOST], "REMOTE_CONNECTION_INVALID_RESULT");

	const thrown = makeStore({
		connect: async () => {
			throw new Error("ssh exploded with a path /home/me/.ssh/id");
		},
	});
	const thrownResult = await thrown.ensureConnected(HOST);
	assert.equal(thrownResult.code, "REMOTE_CONNECTION_FAILED");
	assert.equal(thrown.snapshot().errors[HOST], "REMOTE_CONNECTION_FAILED", "异常原文不进入界面");
});

test("ensureConnected(): 未接线 / 非法 hostId 不发请求，校验失败不留假状态", async () => {
	let calls = 0;
	const unwired = makeStore({ connect: async () => ((calls += 1), { ok: true, state: "ready" }) });
	const invalidId = await unwired.ensureConnected("not-a-uuid");
	assert.equal(invalidId.code, "REMOTE_HOST_ID_INVALID");

	const noPorts = makeStore({});
	assert.equal((await noPorts.ensureConnected(HOST)).ok, true, "无端口时交给读请求报真实错误");
	assert.equal(calls, 0, "非法 id 不得触发 connect");
});

test("单例 + ready 快照：页面重挂载复用同一状态，不会每次重新 connect", async () => {
	let connects = 0;
	let lists = 0;
	const hostApi = {
		list: async () => ((lists += 1), { ok: true, hosts: [], states: { [HOST]: "ready" } }),
		connect: async () => {
			connects += 1;
			return { ok: true, hostId: HOST, state: "ready" };
		},
		onStateChange: () => () => undefined,
	};
	const { remoteHostConnectionStore } = loadTsCommonJs("src/renderer/src/config/useRemoteHostConnection.ts", { globals: { window: { piDesktop: { remoteHosts: hostApi } } } });
	// 单例：选择器与面板、以及它们各自的重挂载，拿到的是同一份连接状态。
	assert.equal(remoteHostConnectionStore(), remoteHostConnectionStore());
	const store = remoteHostConnectionStore();
	store.start();
	store.start();
	await flush();
	assert.equal(lists, 1, "start 幂等：重挂载不重复拉目录");
	assert.equal((await store.ensureConnected(HOST)).ok, true);
	assert.equal(connects, 0, "主进程已报 ready 时不得再发起真连接（这就是「连接保持」的渲染层判据）");
});

test("remoteHostTone(): pending 优先，失败码把 offline 提升为 error", async () => {
	const { remoteHostTone } = loadTsCommonJs(MODEL);
	assert.equal(remoteHostTone({ states: { [HOST]: "ready" }, pending: {}, errors: {} }, HOST), "online");
	assert.equal(remoteHostTone({ states: { [HOST]: "bootstrap" }, pending: { [HOST]: true }, errors: {} }, HOST), "connecting");
	assert.equal(remoteHostTone({ states: { [HOST]: "offline" }, pending: {}, errors: { [HOST]: "SSH_PASSWORD_REQUIRED" } }, HOST), "error");
	assert.equal(remoteHostTone({ states: { [HOST]: "offline" }, pending: {}, errors: {} }, HOST), "offline");
});

/** 用确定性 React 宿主跑 hook：不依赖 DOM；effect 在 render 后同步执行，异步结果用 flush 等待。 */
function runPanelHook(options) {
	const host = quickMessageHookHost();
	const { useRemotePiConfigPanel } = loadTsCommonJs(HOOK, {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi: {} },
			"./useRemoteHostConnection": {
				useRemoteHostConnection: () => ({
					snapshot: { states: {}, pending: {}, errors: {} },
					ensureConnected: options.ensureConnected,
				}),
			},
		},
	});
	let view;
	const render = () => {
		host.render(() => {
			view = useRemotePiConfigPanel({ hostId: HOST, file: "models", ports: options.ports });
		});
		return view;
	};
	render();
	// 异步读完成后重新渲染一次拿到新的 reducer 状态（快照对象本身不会原地更新）。
	return { host, render, view: () => view };
}

const snapshotResponse = (file = "models") => ({ remote: { kind: "remote", hostId: HOST, file, version: "a".repeat(64), sha256: "a".repeat(64), data: file === "models" ? { providers: {} } : {}, secrets: [] } });

test("面板 hook：先确保连接再 read；连接失败不读文件，直接给 host-not-ready", async () => {
	const reads = [];
	const ensure = [];
	const ok = runPanelHook({
		ensureConnected: async (hostId) => (ensure.push(hostId), { ok: true }),
		ports: { read: async () => (reads.push(1), snapshotResponse()), save: async () => ({}) },
	});
	await flush();
	assert.deepEqual(ensure, [HOST]);
	assert.equal(reads.length, 1);
	assert.equal(ok.render().state.phase, "ready");

	const refused = runPanelHook({
		ensureConnected: async () => ({ ok: false, code: "SSH_PASSWORD_REQUIRED" }),
		ports: { read: async () => (reads.push(2), snapshotResponse()), save: async () => ({}) },
	});
	await flush();
	assert.equal(refused.render().state.phase, "failed");
	assert.equal(refused.render().state.code, "REMOTE_CONFIG_HOST_NOT_READY");
	assert.equal(reads.length, 1, "连接没成功时不得发 config 读请求");
});

test("面板 hook：读到 host-not-ready 时重连一次再读一次，不无限重试", async () => {
	let reads = 0;
	let ensureCalls = 0;
	const host = runPanelHook({
		ensureConnected: async () => {
			ensureCalls += 1;
			return { ok: true };
		},
		ports: {
			read: async () => {
				reads += 1;
				if (reads === 1) throw new Error("REMOTE_CONFIG_HOST_NOT_READY");
				return snapshotResponse();
			},
			save: async () => ({}),
		},
	});
	await flush(8);
	assert.equal(reads, 2);
	assert.equal(ensureCalls, 2, "掉线后只重连一次");
	assert.equal(host.render().state.phase, "ready");
});

test("环境切换源码：自动连接、连接动画、密码补录与 WSL 空态提示都在", () => {
	const source = readFileSync(SWITCH, "utf8");
	assert.match(source, /useRemoteHostConnection/);
	assert.match(source, /ensureConnected/);
	assert.match(source, /animate-pideck-spin/);
	assert.match(source, /data-testid="config-target-remote-hint"/);
	assert.match(source, /data-testid="config-target-reconnect"/);
	assert.match(source, /SSH_PASSWORD_REQUIRED/);
	assert.match(source, /settings\.connections\.password\.title/);
	assert.match(source, /data-testid="config-target-wsl-empty"/);
	assert.match(source, /config\.target\.wslEmpty/);
	// 组件不直接碰 IPC：连接经共享 store 走，读/写只由 owner 决定。
	assert.doesNotMatch(source, /ipcRenderer|desktopApi/);
	// 三组选项与「本机」入口不因改版丢失。
	assert.match(source, /data-testid="config-env-local"/);
	assert.match(source, /data-testid=\{"config-env-ssh-" \+ host\.id\}/);
	assert.match(source, /data-testid="config-env-wsl"/);
});

const SSH_HOST = { kind: "ssh", id: HOST, label: "dev-box", sshHost: "root@10.0.0.1" };
const switchStubs = (snapshot) => ({
	react: React,
	"./useRemoteHostConnection": { useRemoteHostConnection: () => ({ snapshot, ensureConnected: async () => ({ ok: true }) }) },
});

test("SSR：ssh 环境在未知连接状态时画成「未连接」，且分页上带环境名", () => {
	const { ConfigBackendSwitch } = loadTsCommonJs(SWITCH, { stubs: switchStubs({ states: {}, pending: {}, errors: {} }) });
	const html = renderToStaticMarkup(
		React.createElement(ConfigBackendSwitch, {
			pane: "pi",
			showDsh: false,
			piDirty: false,
			dshDirty: false,
			target: { kind: "ssh", hostId: HOST },
			hosts: [SSH_HOST],
			onSelectPane: () => undefined,
			onSelectTarget: () => undefined,
		}),
	);
	assert.match(html, /data-testid="config-backend-pi-environment"/);
	assert.match(html, /data-kind="ssh"/);
	assert.match(html, /dev-box/);
});

test("SSR：正在连接时环境状态条带转圈 + 呼吸文案，而不是先报错", () => {
	const { ConfigEnvironmentStatus } = loadTsCommonJs(SWITCH, {
		stubs: switchStubs({ states: { [HOST]: "connecting" }, pending: { [HOST]: true }, errors: {} }),
	});
	const html = renderToStaticMarkup(React.createElement(ConfigEnvironmentStatus, { target: { kind: "ssh", hostId: HOST }, hosts: [SSH_HOST] }));
	assert.match(html, /data-testid="config-environment-status"/);
	assert.match(html, /data-tone="connecting"/);
	assert.match(html, /animate-pideck-spin/);
	assert.match(html, /animate-pulse/);
	assert.match(html, /正在连接 dev-box/);
});

test("面板源码：连接中单独一块 + 失败后给重新连接入口", () => {
	const source = readFileSync(PANEL, "utf8");
	assert.match(source, /data-testid=\{connecting \? "remote-config-connecting" : "remote-config-loading"\}/);
	assert.match(source, /remoteConfig\.connecting/);
	assert.match(source, /data-testid="remote-config-reconnect"/);
	assert.match(source, /remoteConfig\.reconnect/);
	assert.match(source, /connectCode/);
});

test("中英文案成对：新增的自动连接/重试 key 两侧都有", async () => {
	const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const key of ["config.target.connecting", "config.target.retryConnect", "config.target.wslEmpty", "remoteConfig.connecting", "remoteConfig.connectFailed", "remoteConfig.reconnect"]) {
		assert.ok(typeof zhCN[key] === "string" && zhCN[key].length > 0, "zh-CN " + key);
		assert.ok(typeof enUS[key] === "string" && enUS[key].length > 0, "en-US " + key);
	}
	assert.match(zhCN["config.target.connecting"], /\{host\}/);
	assert.match(enUS["config.target.connecting"], /\{host\}/);
});

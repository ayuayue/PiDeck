import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 侧栏远端项目行的「服务器名 + 连接状态点」：状态映射与 IPC 载荷收窄都是纯函数，
// 这里直接加载生产模块验证，不从组件源码里复制一套判据。

const { applyRemoteHostStateChange, mergeRemoteHostIdentity, readRemoteHostDirectory, readRemoteHostStateChange, readRemoteHostStates, resolveRemoteHostConnectionTone } = loadTsCommonJs("src/renderer/src/utils/remoteHostIdentity.ts");

// VM 里加载的模块与测试文件不同 realm：原型比较没有意义，按普通对象/标量比较。
const plain = (value) => JSON.parse(JSON.stringify(value));

const HOST_A = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const HOST_B = "1a2b3c4d-5e6f-4a7b-8c9d-1e2f3a4b5c6d";

const directoryResponse = {
	ok: true,
	status: "ready",
	hosts: [
		{ id: HOST_A, label: "xunjian", sshHost: "10.0.0.8", verified: true, disabled: false },
		{ id: HOST_B, label: "build-box", sshHost: "192.168.1.100", verified: true, disabled: true },
	],
};

test("connection tone: only a usable host is green, in-flight states are not", () => {
	assert.equal(resolveRemoteHostConnectionTone("ready"), "online");
	// degraded 仍可读可写（manager 会自愈），不当故障吓人。
	assert.equal(resolveRemoteHostConnectionTone("degraded"), "online");
	for (const state of ["connecting", "probing", "bootstrapping", "reconnecting"]) {
		assert.equal(resolveRemoteHostConnectionTone(state), "connecting", state);
	}
	assert.equal(resolveRemoteHostConnectionTone("needs-attention"), "error");
	for (const state of ["disconnected", "offline"]) {
		assert.equal(resolveRemoteHostConnectionTone(state), "offline", state);
	}
	// 尚未收到推送（窗口刚挂载/重载）不能猜成已连接。
	assert.equal(resolveRemoteHostConnectionTone(undefined), "offline");
});

test("directory narrowing keeps only well-formed hosts", () => {
	const directory = readRemoteHostDirectory(directoryResponse);
	assert.deepEqual(plain(directory), {
		[HOST_A]: { label: "xunjian", sshHost: "10.0.0.8", verified: true, disabled: false },
		[HOST_B]: { label: "build-box", sshHost: "192.168.1.100", verified: true, disabled: true },
	});

	const dirty = readRemoteHostDirectory({
		ok: true,
		hosts: [
			{ id: "not-a-uuid", label: "nope", sshHost: "h" },
			{ id: HOST_A, label: "  ", sshHost: "h" },
			{ id: HOST_A, label: "bad\u0007label", sshHost: "h" },
			{ id: HOST_B, label: "ok", sshHost: "h", verified: "yes", disabled: 1 },
		],
	});
	// 字段类型不对不提升为 true；缺失的布尔按 false，宁可不声称已验证。
	assert.deepEqual(plain(dirty), { [HOST_B]: { label: "ok", sshHost: "h", verified: false, disabled: false } });

	// 未启用/不可读时不能返回空目录：调用方要保留旧索引，而不是把主机显示成「未知主机」。
	assert.equal(readRemoteHostDirectory({ ok: false, code: "REMOTE_FEATURE_DISABLED" }), undefined);
	assert.equal(readRemoteHostDirectory(null), undefined);
});

test("state-change push is re-validated at the renderer boundary", () => {
	assert.deepEqual(plain(readRemoteHostStateChange({ hostId: HOST_A, state: "probing" })), { hostId: HOST_A, state: "probing" });
	assert.equal(readRemoteHostStateChange({ hostId: "not-a-uuid", state: "ready" }), undefined);
	assert.equal(readRemoteHostStateChange({ hostId: HOST_A, state: "READY" }), undefined);
	assert.equal(readRemoteHostStateChange({ hostId: HOST_A }), undefined);
});

test("push before the directory keeps its state when the list arrives", () => {
	const pushed = applyRemoteHostStateChange({}, { hostId: HOST_A, state: "connecting" });
	const merged = mergeRemoteHostIdentity(pushed, readRemoteHostDirectory(directoryResponse));
	assert.equal(merged[HOST_A].state, "connecting", "a list must not erase a newer connection state");
	assert.equal(merged[HOST_A].label, "xunjian");
	// 目录里没有的主机保留自己那条状态，不会被整批替换掉。
	assert.equal(merged[HOST_B].label, "build-box");
});

test("project row renders the remote badge, host name and dot without losing hover clearance", () => {
	const tree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
	// 远端项目才换成带云朵角标的文件夹；本机项目保持原样。
	assert.match(tree, /\{isRemoteProject\(project\) \? \(\s*<RemoteProjectFolderIcon collapsed=\{collapsed\} \/>/);
	assert.match(tree, /\{isRemoteProject\(project\) \? <RemoteProjectHostTag hostId=\{project\.locator\.hostId\} \/> : null\}/);
	// 行尾身份不能破坏既有的 hover 让位契约（+ / 筛选 / ⋯ 不得叠到文字上）。
	assert.match(tree, /conversation-body min-w-0 flex-1 pr-7 transition-\[padding-right\] group-hover:pr-\[88px\] group-focus-within:pr-\[88px\]/);
	// 状态点语义只在这一处映射，组件不自己编第二套。
	const tag = readFileSync("src/renderer/src/components/sidebar/RemoteProjectHostTag.tsx", "utf8");
	assert.match(tag, /resolveRemoteHostConnectionTone\(identity\.state\)/);
	assert.match(tag, /data-tone=\{tone\}/);
	assert.doesNotMatch(tag, /state === "ready"/);

	// 角标从 lucide 地球换成自绘云朵（2026-11 视觉调整）：仍然是 `text-info` 语义色。
	const badge = readFileSync("src/renderer/src/components/sidebar/RemoteProjectFolderIcon.tsx", "utf8");
	assert.match(badge, /<mask\b/);
	assert.match(badge, /text-info/);
	assert.doesNotMatch(badge, /Globe2/);
	// mask id 必须实例级（同一屏挂很多项目行），且镂空是透空的：不能再垫固定底色的圆盘，
	// 否则 hover / 选中行会露出一块对不上的圆片。
	assert.match(badge, /useId\(\)/);
	// 只看真实 className：组件注释里会解释「旧做法垫过 bg-sidebar 圆盘」，那不是用法。
	assert.doesNotMatch(badge, /className="[^"]*bg-sidebar/);
});

// 离开设置页再回来时没有任何推送可重放：列表必须把当前状态一起带回来，否则已连接的主机会显示成断开。
test("list carries a state snapshot for views that remount", () => {
	assert.deepEqual(plain(readRemoteHostStates({ ok: true, states: { [HOST_A]: "ready", [HOST_B]: "degraded" } })), { [HOST_A]: "ready", [HOST_B]: "degraded" });
	// 不合法的主机 id / 状态一律丢弃，不能把脏数据当成连接状态。
	assert.deepEqual(plain(readRemoteHostStates({ ok: true, states: { "not-a-host": "ready", [HOST_A]: "bogus" } })), {});
	// 旧主进程没有这个字段时退化为空对象，不影响目录加载。
	assert.deepEqual(plain(readRemoteHostStates({ ok: true, hosts: [] })), {});
});

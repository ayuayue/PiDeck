import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 配置目标（P1-1 UI 侧）的纯逻辑：选择器项、目标比较、本地编辑器选项、provider 操作门禁。
 * 这些规则决定了「切目标时保不保留草稿」「读写带不带 target」「按钮能不能点」，
 * 因此按行为断言，不扫源码形状。
 */

const model = loadTsCommonJs("src/renderer/src/config/piConfigTargetModel.ts");
const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const SSH_HOST = { kind: "ssh", id: HOST, label: "build-box", sshHost: "dev@10.0.0.5" };
const WSL_HOST = { kind: "wsl", id: HOST, label: "Ubuntu dev", distro: "Ubuntu-26.04", user: "dev" };

test("目标相等判定：同 kind 同 id 才算同一目标（local 忽略 id）", () => {
	const local = { kind: "local" };
	assert.equal(model.samePiConfigTarget(local, local), true);
	assert.equal(model.samePiConfigTarget({ kind: "wsl", hostId: HOST }, { kind: "wsl", hostId: HOST }), true);
	assert.equal(model.samePiConfigTarget({ kind: "wsl", hostId: HOST }, { kind: "wsl", hostId: OTHER }), false);
	assert.equal(model.samePiConfigTarget({ kind: "ssh", hostId: HOST }, { kind: "ssh", hostId: HOST }), true);
	// 同一个 id 在 ssh 与 wsl 两个命名空间里是不同目标：切换必须真的重载。
	assert.equal(model.samePiConfigTarget({ kind: "ssh", hostId: HOST }, { kind: "wsl", hostId: HOST }), false);
	assert.equal(model.samePiConfigTarget(local, { kind: "wsl", hostId: HOST }), false);
	assert.equal(model.samePiConfigTarget({ kind: "wsl", hostId: HOST }, local), false);
});

test("本地编辑器只对 wsl 目标带 target 选项（ssh 由远端面板接管，local 是缺省）", () => {
	assert.equal(model.localEditorTargetOption({ kind: "local" }), undefined);
	assert.equal(model.localEditorTargetOption({ kind: "ssh", hostId: HOST }), undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(model.localEditorTargetOption({ kind: "wsl", hostId: HOST }))), { target: { kind: "wsl", hostId: HOST } });
});

test("按目标找档案：只认同 kind 的条目，找不到或本机返回 undefined", () => {
	const hosts = [SSH_HOST, WSL_HOST, { kind: "wsl", id: OTHER, label: "root", distro: "Ubuntu-24.04", user: "root" }];
	assert.deepEqual(JSON.parse(JSON.stringify(model.wslTargetHostOf(hosts, { kind: "wsl", hostId: OTHER }))), { kind: "wsl", id: OTHER, label: "root", distro: "Ubuntu-24.04", user: "root" });
	assert.equal(model.wslTargetHostOf(hosts, { kind: "wsl", hostId: "33333333-3333-4333-8333-333333333333" }), undefined);
	assert.equal(model.wslTargetHostOf(hosts, { kind: "local" }), undefined);
	// 同一个 id 的 ssh 条目不能被当成 wsl 档案（否则会把远端主机标签套在 WSL 配置上）。
	assert.equal(model.wslTargetHostOf([SSH_HOST], { kind: "wsl", hostId: HOST }), undefined);
	assert.equal(model.wslTargetHostOf([], { kind: "wsl", hostId: HOST }), undefined);
});

test("列表映射：ssh 主机与 WSL 档案各自保持 kind，不互相冒充", () => {
	const ssh = model.toSshTargetHosts([{ id: HOST, label: "build-box", sshHost: "dev@10.0.0.5" }]);
	assert.deepEqual(JSON.parse(JSON.stringify(ssh)), [{ kind: "ssh", id: HOST, label: "build-box", sshHost: "dev@10.0.0.5" }]);
	const wsl = model.toWslTargetHosts([{ id: OTHER, label: "Ubuntu dev", distro: "Ubuntu-26.04", user: "dev" }]);
	assert.deepEqual(JSON.parse(JSON.stringify(wsl)), [{ kind: "wsl", id: OTHER, label: "Ubuntu dev", distro: "Ubuntu-26.04", user: "dev" }]);
	assert.deepEqual(JSON.parse(JSON.stringify(model.toWslTargetHosts([]))), []);
});

test("切换目标前只拦「配置组」的未保存草稿，不误拦技能/提示词等无关脏标记", () => {
	assert.equal(model.hasUnsavedConfigDrafts([]), false);
	assert.equal(model.hasUnsavedConfigDrafts(["skills", "prompts"]), false);
	assert.equal(model.hasUnsavedConfigDrafts(["config:models"]), true);
	assert.equal(model.hasUnsavedConfigDrafts(["skills", "config:settings"]), true);
});

test("只有存在 WSL 档案时才提示「技能/提示词/扩展页仅编辑 Windows 配置」", () => {
	assert.equal(model.hasWslConfigProfile([]), false);
	assert.equal(model.hasWslConfigProfile([SSH_HOST]), false);
	assert.equal(model.hasWslConfigProfile([SSH_HOST, WSL_HOST]), true);
});

test("provider 探针（测试连接/拉取模型/用量）只对本机开放", () => {
	assert.equal(model.providerOpsAllowed({ kind: "local" }), true);
	assert.equal(model.providerOpsAllowed({ kind: "ssh", hostId: HOST }), false);
	assert.equal(model.providerOpsAllowed({ kind: "wsl", hostId: HOST }), false);
});

test("WSL 目标新增的词典键在中英文两侧齐备且占位符一致", () => {
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	const keys = Object.keys(zh).filter((key) => key.startsWith("config.target.wsl") || key.startsWith("config.windowsOnly"));
	assert.ok(keys.length >= 7, "unexpected WSL key count " + keys.length);
	for (const key of keys) {
		assert.ok(Object.prototype.hasOwnProperty.call(en, key), "en-US missing " + key);
		const zhPlaceholders = [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		const enPlaceholders = [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		assert.deepEqual(zhPlaceholders, enPlaceholders, key);
	}
	assert.ok(zh["config.target.wslSource"].includes("{label}"));
	assert.ok(zh["config.windowsOnly.body"].includes("{page}"));
});

test("打开配置管理的默认目标：远端项目落在它那台主机，本机项目与未知主机不被改写", () => {
	/** vm 沙箱返回的对象来自另一个 realm：逐字段摊平后再比较（本文件其它用例同做法）。 */
	const plain = (value) => JSON.parse(JSON.stringify(value));
	const local = { kind: "local" };
	const other = { kind: "ssh", id: OTHER, label: "other", sshHost: "dev@10.0.0.6" };
	const remoteProject = { id: "p1", name: "app", lastOpenedAt: 1, locator: { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } };
	const localProject = { id: "p2", name: "local app", lastOpenedAt: 1, path: "/home/dev/app" };
	// 远端项目 + 该主机在可选目标里 ⇒ 默认落在服务器：打开「模型配置 / Pi 设置」就是在那台机器上编辑。
	assert.deepEqual(plain(model.preferredConfigTargetForProject(remoteProject, [SSH_HOST, WSL_HOST], local)), { kind: "ssh", hostId: HOST });
	// 主机不在清单里（未验证/被禁用/清单还没到）：保持本机，不指向一个读不到的机器。
	assert.deepEqual(plain(model.preferredConfigTargetForProject(remoteProject, [WSL_HOST], local)), { kind: "local" });
	assert.deepEqual(plain(model.preferredConfigTargetForProject(remoteProject, [], local)), { kind: "local" });
	// 只有同 id 的 WSL 档案不算「同一个远端主机」。
	assert.deepEqual(plain(model.preferredConfigTargetForProject(remoteProject, [WSL_HOST], local)), { kind: "local" });
	// 本机项目不参与「默认远端」；没有项目时保持原值。
	assert.deepEqual(plain(model.preferredConfigTargetForProject(localProject, [SSH_HOST], local)), { kind: "local" });
	assert.deepEqual(plain(model.preferredConfigTargetForProject(undefined, [SSH_HOST], local)), { kind: "local" });
	// 用户已主动选过目标（另一台主机 / WSL）时不被打开动作改写。
	assert.deepEqual(plain(model.preferredConfigTargetForProject(remoteProject, [SSH_HOST, other], { kind: "ssh", hostId: OTHER })), { kind: "ssh", hostId: OTHER });
	assert.deepEqual(plain(model.preferredConfigTargetForProject(remoteProject, [SSH_HOST], { kind: "wsl", hostId: HOST })), { kind: "wsl", hostId: HOST });
});

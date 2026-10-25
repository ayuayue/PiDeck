/**
 * DSH_HOME 共享 / 并发冲突判定（issue #189 问题 1）。
 *
 * 背景：PiDeck 默认用用户真实 `~/.dsh`，与 dsh CLI 共用 profiles / settings.yaml /
 * 插件状态文件；DSH 官方约束「同一 DSH_HOME 只允许一个 host」。本模块只做判定与
 * 透出（不阻断），因此用例覆盖两类信号：
 * - sharesCliHome：默认 home 未隔离 → 配置页提示命令行侧设 DSH_HOME；
 * - externalHostPid：锁文件里另一个仍存活的 host → 明确报出 pid。
 *
 * 判定必须「离开文件系统」可测：homeDir / selfPid / isAlive 全部注入。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DEFAULT_DSH_HOME_DIR_NAME, normalizeDshHomePath, isCliSharedHome, resolveDshHomeSharing, externalHostHolderPid } = loadTsCommonJs("src/main/dsh/dshHomeSharing.ts");

test("默认共享目录名与 dsh CLI 约定一致（.dsh）", () => {
	assert.equal(DEFAULT_DSH_HOME_DIR_NAME, ".dsh");
});

test("normalizeDshHomePath: 统一分隔符、去尾斜杠、Windows 忽略大小写", () => {
	assert.equal(normalizeDshHomePath("C:\\Users\\me\\.dsh\\"), process.platform === "win32" ? "c:/users/me/.dsh" : "C:/Users/me/.dsh");
	assert.equal(normalizeDshHomePath("/home/me/.dsh/"), "/home/me/.dsh");
});

test("isCliSharedHome: 命中默认 ~/.dsh（含尾斜杠/分隔符差异）", () => {
	assert.equal(isCliSharedHome("/home/me/.dsh", "/home/me"), true);
	assert.equal(isCliSharedHome("/home/me/.dsh/", "/home/me/"), true);
});

test("isCliSharedHome: 自定义目录不算共用（已隔离）", () => {
	assert.equal(isCliSharedHome("/home/me/.dsh-cli", "/home/me"), false);
	assert.equal(isCliSharedHome("/data/dsh", "/home/me"), false);
});

test("isCliSharedHome: 空值不误判为共用", () => {
	assert.equal(isCliSharedHome("", "/home/me"), false);
	assert.equal(isCliSharedHome("/home/me/.dsh", ""), false);
});

test("resolveDshHomeSharing: 无覆盖 + 默认目录 → 报告共用", () => {
	const state = resolveDshHomeSharing({
		dshHome: "/home/me/.dsh",
		override: undefined,
		homeDir: "/home/me",
	});
	assert.equal(state.usingOverride, false);
	assert.equal(state.sharesCliHome, true);
});

test("resolveDshHomeSharing: 有覆盖 → 视为已隔离，不再报共用", () => {
	const state = resolveDshHomeSharing({
		dshHome: "/home/me/.dsh",
		override: "/data/dsh-cli",
		homeDir: "/home/me",
	});
	assert.equal(state.usingOverride, true);
	assert.equal(state.sharesCliHome, false);
});

test("resolveDshHomeSharing: 覆盖为空白串按「无覆盖」处理", () => {
	const state = resolveDshHomeSharing({
		dshHome: "/home/me/.dsh",
		override: "   ",
		homeDir: "/home/me",
	});
	assert.equal(state.usingOverride, false);
	assert.equal(state.sharesCliHome, true);
});

test("externalHostHolderPid: 锁里是另一个存活 pid → 报出该 pid", () => {
	const pid = externalHostHolderPid({
		lockRaw: JSON.stringify({ pid: 4242 }),
		selfPid: 1000,
		isAlive: (value) => value === 4242,
	});
	assert.equal(pid, 4242);
});

test("externalHostHolderPid: pid 已死（陈旧锁）→ 不报冲突", () => {
	const pid = externalHostHolderPid({
		lockRaw: JSON.stringify({ pid: 4242 }),
		selfPid: 1000,
		isAlive: () => false,
	});
	assert.equal(pid, undefined);
});

test("externalHostHolderPid: 锁是自己的 pid（重启残留）→ 不报冲突", () => {
	const pid = externalHostHolderPid({
		lockRaw: JSON.stringify({ pid: 1000 }),
		selfPid: 1000,
		isAlive: () => true,
	});
	assert.equal(pid, undefined);
});

test("externalHostHolderPid: 锁缺失/内容损坏/形状非法 → 静默不报（锁坏不该报冲突）", () => {
	const isAlive = () => true;
	assert.equal(externalHostHolderPid({ lockRaw: undefined, selfPid: 1, isAlive }), undefined);
	assert.equal(externalHostHolderPid({ lockRaw: "  ", selfPid: 1, isAlive }), undefined);
	assert.equal(externalHostHolderPid({ lockRaw: "{not json", selfPid: 1, isAlive }), undefined);
	assert.equal(externalHostHolderPid({ lockRaw: '"str"', selfPid: 1, isAlive }), undefined);
	assert.equal(externalHostHolderPid({ lockRaw: "{}", selfPid: 1, isAlive }), undefined);
	assert.equal(externalHostHolderPid({ lockRaw: '{"pid":"42"}', selfPid: 1, isAlive }), undefined);
	assert.equal(externalHostHolderPid({ lockRaw: '{"pid":-1}', selfPid: 1, isAlive }), undefined);
	assert.equal(externalHostHolderPid({ lockRaw: '{"pid":0}', selfPid: 1, isAlive }), undefined);
});

test("回归 #189：默认 home + 另一个存活 host → 两个信号同时成立（冲突优先展示）", () => {
	const sharing = resolveDshHomeSharing({
		dshHome: "/home/me/.dsh",
		override: "",
		homeDir: "/home/me",
	});
	const pid = externalHostHolderPid({
		lockRaw: JSON.stringify({ pid: 777 }),
		selfPid: 1,
		isAlive: (value) => value === 777,
	});
	assert.equal(sharing.sharesCliHome, true);
	assert.equal(pid, 777);
});

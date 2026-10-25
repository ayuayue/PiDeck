import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 「检测到多个 pi 安装」的展示规则。
 * 主进程负责列表顺序与 isActive/shellDefault/isNewest，渲染层只该做这些可单测的映射——
 * 徽章优先级一旦写错，用户就会看到两份 pi 都标「当前使用」，或者该提醒的没提醒。
 */

const load = createTsSandbox();
const { piInstallationBadge, piInstallationBadgeKey, piInstallationSourceKey, piInstallationVersionKey, shouldOfferInstallationChoice, groupInstallations, installationRowActions, piInstallationVersionNoteKey } = load("src/renderer/src/utils/piInstallationOptions.ts");

/** 工厂：只关心被测字段，其余给默认值，避免用例里到处写完整对象。 */
function installation(overrides = {}) {
	return {
		path: "/opt/pi/pi",
		realPath: "/opt/pi/pi",
		source: "path",
		isActive: false,
		...overrides,
	};
}

test("徽章优先级：当前使用 > 终端默认 > 较新", () => {
	assert.equal(piInstallationBadge(installation({ isActive: true, shellDefault: true, isNewest: true })), "active");
	assert.equal(piInstallationBadge(installation({ shellDefault: true, isNewest: true })), "shellDefault");
	assert.equal(piInstallationBadge(installation({ isNewest: true })), "newest");
	assert.equal(piInstallationBadge(installation()), null);
});

test("徽章与来源各自映射到文案 key", () => {
	assert.equal(piInstallationBadgeKey("active"), "environment.installBadgeActive");
	assert.equal(piInstallationBadgeKey("shellDefault"), "environment.installBadgeShellDefault");
	assert.equal(piInstallationBadgeKey("newest"), "environment.installBadgeNewest");
	assert.equal(piInstallationBadgeKey(null), null);

	assert.equal(piInstallationSourceKey("managed"), "environment.installSourceManaged");
	assert.equal(piInstallationSourceKey("package-manager"), "environment.installSourcePackageManager");
	assert.equal(piInstallationSourceKey("portable"), "environment.installSourcePortable");
	assert.equal(piInstallationSourceKey("custom"), "environment.installSourceCustom");
	assert.equal(piInstallationSourceKey("path"), "environment.installSourcePath");
	// 未知来源（旧数据/新来源）不能渲染成空文案
	assert.equal(piInstallationSourceKey("mystery"), "environment.installSourcePath");
});

test("版本探测失败的条目要显示「无法获取版本」而不是空白", () => {
	assert.equal(piInstallationVersionKey(installation({ version: "1.2.3" })), null);
	assert.equal(piInstallationVersionKey(installation({ versionError: "ENOENT" })), "environment.installVersionUnknown");
	assert.equal(piInstallationVersionKey(installation()), "environment.installVersionUnknown");
});

test("只有多于一份安装时才需要用户选择", () => {
	assert.equal(shouldOfferInstallationChoice([]), false);
	assert.equal(shouldOfferInstallationChoice([installation({ isActive: true })]), false);
	assert.equal(shouldOfferInstallationChoice([installation({ isActive: true }), installation({ path: "/a/.pi/agent/bin/pi", source: "managed" })]), true);
});

test("列表分组：自动发现的与用户添加的分开，且保持原顺序", () => {
	const detected = installation({ path: "/opt/auto/pi" });
	const added = installation({ path: "/opt/mine/pi", userAdded: true, source: "custom" });
	const grouped = groupInstallations([added, detected]);
	assert.equal(grouped.detected.length, 1);
	assert.equal(grouped.userAdded.length, 1);
	assert.equal(grouped.detected[0].path, "/opt/auto/pi");
	assert.equal(grouped.userAdded[0].path, "/opt/mine/pi");
});

test("行内操作：当前使用项不给「使用」，只有用户添加的项能编辑/移除", () => {
	// 沙箱 realm 的对象与宿主原型不同，转成宿主纯值再比
	const actions = (item) => JSON.parse(JSON.stringify(installationRowActions(item)));
	assert.deepEqual(actions(installation({ isActive: true })), { canUse: false, canEdit: false, canRemove: false });
	assert.deepEqual(actions(installation()), { canUse: true, canEdit: false, canRemove: false });
	assert.deepEqual(actions(installation({ userAdded: true, source: "custom" })), { canUse: true, canEdit: true, canRemove: true });
});

test("版本提示：最高版标「较新」，其他可选版本标「较旧」；版本缺失时不提示", () => {
	const newest = installation({ version: "2.0.0", isNewest: true });
	const older = installation({ version: "1.0.0" });
	assert.equal(piInstallationVersionNoteKey(newest, true), "environment.installBadgeNewest");
	assert.equal(piInstallationVersionNoteKey(older, true), "environment.installBadgeOlder");
	// 没有“更新的”可比时不贴「较旧」标签（单一安装场景）
	assert.equal(piInstallationVersionNoteKey(older, false), null);
	assert.equal(piInstallationVersionNoteKey(installation(), true), null);
});

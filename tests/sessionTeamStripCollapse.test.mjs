/**
 * DSH Team 条折叠记忆（用户反馈：手动折叠后切换会话又默认展开）。
 *
 * 现状根因：折叠状态只存在 ComposerMeasuredExtras 的组件 state（内存），
 * key 还带 sessionId；切换会话/面板重挂后 context map 为空 → 回到默认展开。
 *
 * 契约：Team 条的折叠偏好落 localStorage、跨会话共享；默认展开只在“从未设置过”时生效。
 * 纯函数放在 utils 里以便这里直接加载断言；组件接线用源码正则（空白容忍）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { TEAM_COLLAPSED_STORAGE_KEY, readTeamCollapsedPreference, writeTeamCollapsedPreference } = loadTsCommonJs("src/renderer/src/utils/sessionTeamCollapsePreference.ts");

/** 可控的 Storage 替身：只实现偏好读写用到的两个方法。 */
function fakeStorage(initial = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem(key) {
			return data.has(key) ? data.get(key) : null;
		},
		setItem(key, value) {
			data.set(key, String(value));
		},
	};
}

test("Team 条默认展开：没有存储值时返回 false", () => {
	assert.equal(readTeamCollapsedPreference(fakeStorage()), false);
	assert.equal(readTeamCollapsedPreference(null), false, "storage 不可用（隐私模式/无 window）必须 fail-safe 回默认展开");
});

test("Team 条折叠偏好可读可写，键名稳定", () => {
	const storage = fakeStorage();
	assert.equal(TEAM_COLLAPSED_STORAGE_KEY, "pideck:session-team-collapsed");

	writeTeamCollapsedPreference(true, storage);
	assert.equal(readTeamCollapsedPreference(storage), true, "手动折叠后必须记住");
	writeTeamCollapsedPreference(false, storage);
	assert.equal(readTeamCollapsedPreference(storage), false, "手动展开后同样要记住（不能残留 true）");
});

test("存储异常不得影响输入框渲染（getItem/setItem 抛错时静默回退）", () => {
	const throwing = {
		getItem() {
			throw new Error("SecurityError");
		},
		setItem() {
			throw new Error("QuotaExceededError");
		},
	};
	assert.equal(readTeamCollapsedPreference(throwing), false);
	assert.doesNotThrow(() => writeTeamCollapsedPreference(true, throwing));
});

test("SessionTeamStrip 走跨会话持久偏好，不再按 sessionId 各自默认", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionTeamStrip.tsx", "utf8");
	assert.match(source, /readTeamCollapsedPreference/);
	assert.match(source, /writeTeamCollapsedPreference/);
	// 折叠 key 必须跨会话共享（不能再用 team:${sessionId}），否则换会话又弹开。
	assert.doesNotMatch(source, /team:\$\{\s*props\.sessionId\s*\}/);
	assert.match(source, /useComposerWidgetCollapsed\(\s*TEAM_WIDGET_KEY\s*,\s*readTeamCollapsedPreference\(\)\s*\)/);
	// 点击折叠先写偏好、再走 composer 通道更新布局（顺序不能反：反了会先按旧默认渲染一帧）。
	const toggleBlock = source.match(/const handleToggleCollapsed = useCallback\([\s\S]*?\}, \[[\s\S]*?\]\);/);
	assert.ok(toggleBlock, "点击处理必须收口在稳定回调里");
	assert.match(toggleBlock[0], /writeTeamCollapsedPreference\(!\s*collapsed\)/);
	assert.match(toggleBlock[0], /toggleCollapsed\(\)/);
});

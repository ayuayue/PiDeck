import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * catalog 自动加载 effect 的依赖稳定性。
 *
 * refreshProjectSessions 由 useProjectSync 以普通函数返回，每次渲染都是新引用。
 * 若被写进 effect deps，catalog 停在 error 时会出现：刷新失败 → 状态更新重渲染 →
 * effect 重跑 → 再刷新，形成无限扫描（Chat 引导页 / 展开项目预加载 / 活动项目补加载）。
 * 三处都必须经 refreshProjectSessionsRef 取最新实现，且 deps 不含该函数。
 */
const app = readFileSync("src/renderer/src/App.tsx", "utf8");

const AUTO_LOAD_EFFECT_MARKERS = ["const action = resolveChatSessionBootstrap({", "settings.json 覆盖首屏 localStorage 后", "切换项目时按 catalog load state 判断"];

test("自动加载 effect 经 ref 调用 refreshProjectSessions，不把它写进 deps", () => {
	assert.match(app, /const refreshProjectSessionsRef = useRef\(refreshProjectSessions\);/);
	for (const marker of AUTO_LOAD_EFFECT_MARKERS) {
		const start = app.indexOf(marker);
		assert.notEqual(start, -1, `effect marker should exist: ${marker}`);
		const rest = app.slice(start);
		const depsMatch = rest.match(/\}, \[[^\]]*\]\);/);
		assert.ok(depsMatch, `effect should keep an explicit dependency list: ${marker}`);
		const body = rest.slice(0, rest.indexOf(depsMatch[0]));
		assert.match(body, /refreshProjectSessionsRef\.current\(/, `effect should call via ref: ${marker}`);
		assert.doesNotMatch(depsMatch[0], /\brefreshProjectSessions\b/, `effect deps must not include refreshProjectSessions: ${marker}`);
	}
});

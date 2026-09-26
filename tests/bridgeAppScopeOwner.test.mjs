/**
 * 应用级桥落点的 owner 回归守卫（评审批 §3「后写者为胜」）。
 *
 * 语义（2026-09 定，与 pi TUI 的扩展 UI 生命周期一致）：设置弹窗 / 标题栏 / 右键菜单
 * / 配置页这类**应用级落点**由**当前聚焦会话**的 pi 进程供给；没有聚焦会话就没有内容。
 * pi TUI 里扩展 UI 同样是 `session_start` 挂上、`resetExtensionUI()` 清掉 —— 没有
 * 「应用级扩展 UI」这个概念，因此也不存在「谁拥有它」的歧义。
 *
 * 于是这两类东西不允许再出现：
 *  - 「最后一个推过桥帧的会话」这种全局回落状态：多会话并发推帧时谁最后推谁赢，
 *    会话删除/关闭后还会留下悬空 id（评审原话）；
 *  - 名字或注释暗示「应用级落点跟哪个会话无关」的多余间接层 —— 那正是上面那种
 *    回落最容易复活的地方。
 *
 * 这是**源码级契约测试**（不是行为测试）：一旦越界立刻红灯。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/** 递归列出 src 下的 TS/TSX 源文件（相对 cwd 的仓库根）。 */
function listSources(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSources(full));
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

const SOURCES = listSources("src");

/**
 * 落点取值允许的来源：
 *  - `currentSessionIdAtom`：唯一入口（聚焦会话）
 *  - `sessionRuntimeUiBySessionIdAtomFamily` / `sessionBridgeUiFamily`：按 sessionId 的
 *    per-session 视图（PR 评审 §2.3 要求「多实例按 session 订阅」）
 * 除此之外的任何 session 选择器（回落锚点、会话列表顺序……）都会让「应用级落点由谁供给」
 * 重新变成一次猜测，这里直接红灯。
 */
const ALLOWED_SESSION_ATOM_IMPORTS = new Set(["sessionBridgeUiFamily", "sessionRuntimeUiBySessionIdAtomFamily", "SessionRuntimeUiState", "currentSessionIdAtom"]);

test("桥落点取值不再有「最后写者」回落状态", () => {
	const offenders = SOURCES.filter((file) => readFileSync(file, "utf8").includes("lastBridgeSessionId"));
	assert.deepEqual(offenders, [], `不允许再引入 lastBridgeSessionId 回落（会话删除后会留悬空 id）: ${offenders.join(", ")}`);
});

test("应用级落点只有一个取会话入口（useBridgeSessionId）", () => {
	const offenders = SOURCES.filter((file) => readFileSync(file, "utf8").includes("useBridgeChromeSessionId"));
	assert.deepEqual(offenders, [], `应用级落点的取会话入口应为 useBridgeSessionId，不要再加 chrome 专用 hook: ${offenders.join(", ")}`);
});

test("BridgeSlot 只按 session 订桥状态、并只从聚焦会话取应用级内容", () => {
	const source = readFileSync("src/renderer/src/components/bridge/BridgeSlot.tsx", "utf8");
	// 落点取值只允许来自这两个模块：session-atoms（焦点会话 + 落点 family）与
	// session-selectors（既有的按会话 runtime UI family）。
	for (const modulePath of ["atoms\\/session-atoms", "atoms\\/session-selectors"]) {
		const match = source.match(new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*"(?:\\.\\.\\/)+${modulePath}";`));
		assert.ok(match, `BridgeSlot 必须从 ${modulePath} 引入落点状态`);
		const imported = match[1]
			.split(",")
			.map((item) => item.trim().replace(/^type\s+/, ""))
			.filter(Boolean);
		const extra = imported.filter((name) => !ALLOWED_SESSION_ATOM_IMPORTS.has(name));
		assert.deepEqual(extra, [], `BridgeSlot 不允许再引入第三个会话来源（会重新变成「挑一个会话」）: ${extra.join(", ")}`);
	}

	// 落点组件必须按 sessionId 订 family，不能整张 map 全量订阅（PR 评审 §2.3）
	assert.ok(!/useAtomValue\(sessionRuntimeUiByIdAtom\)/.test(source), "落点组件不允许再直接订阅整张 sessionRuntimeUiByIdAtom");

	// 唯一入口就是「聚焦会话」本身，不是任何回落。
	assert.match(source, /export function useBridgeSessionId\([^)]*\)[\s\S]{0,120}?useAtomValue\(currentSessionIdAtom\)/, "useBridgeSessionId 必须就是聚焦会话（currentSessionIdAtom）");
});

test("桥文件不再宣称「应用级落点与会话无关」", () => {
	const offenders = SOURCES.filter((file) => /components[\\/]bridge[\\/]/.test(file) && readFileSync(file, "utf8").includes("会话无关"));
	assert.deepEqual(offenders, [], `应用级落点由聚焦会话供给，不能再用「与会话无关」解释: ${offenders.join(", ")}`);
});

test("应用级落点的 sessionId 只能来自聚焦会话（hook 或透传 prop）", () => {
	// 应用级落点 = 由宿主 chrome 承载、跟会话内内容无关的那些位置。
	const appScopeSlots = ["titlebar.action", "settings.section", "config.page", "dialog.body", "dialog.action", "context.menu"];
	const allowed = new Set(["bridgeSessionId", "currentSessionId"]);
	let checked = 0;
	for (const file of SOURCES) {
		const source = readFileSync(file, "utf8");
		for (const slot of appScopeSlots) {
			// 抓 `<BridgeGuiSlot … slot="<slot>" …>` 这一整个开标签，再取它的 sessionId 表达式。
			const tag = source.match(new RegExp(`<BridgeGuiSlot[\\s\\S]{0,400}?slot="${slot.replace(".", "\\.")}"[\\s\\S]{0,400}?>`));
			if (!tag) continue;
			checked += 1;
			const expression = tag[0].match(/sessionId=\{([^}]*)\}/);
			assert.ok(expression, `${file} 的 ${slot} 落点必须显式传 sessionId（聚焦会话）`);
			const value = expression[1].trim();
			const ok = allowed.has(value) || /^props\.currentSessionId$/.test(value);
			assert.ok(ok, `${file} 的 ${slot} 落点 sessionId 不能取自「最后一个推过帧的会话」之类回落: ${value}`);
		}
	}
	assert.ok(checked > 0, "至少要检查到应用级落点挂载（挂载点被改名时请同步本测试）");
});

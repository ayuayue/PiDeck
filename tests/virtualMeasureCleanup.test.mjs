/**
 * 虚拟化测量的清理入口：卸载时必须把 null 交给 measureElement，并淘汰按 key 存的闭包缓存。
 *
 * 为什么需要（docs/virtualization-audit.md「六、已知限制」自己写着：「这条没有渲染测试覆盖——
 * 仓库没有 jsdom / testing-library，判据是代码对照」）：
 *
 *   1. 只 return 不交 null：已卸载的行留在 virtual-core 的 elementsCache / ResizeObserver 里，
 *      越滚内存越高。VirtualRunList 在 2026-11 就是这么写的（只 return，不清缓存），
 *      当时靠人读代码发现。
 *   2. 交了 null 不淘汰闭包缓存：按 id 存的 ref 回调数量随「曾经挂载过的行数」增长，
 *      长会话可达数千轮。
 *
 * 两条都不是理论风险，是已经发生过的一次回归。这条测试把「代码对照」（人判）换成源码级
 * 不变量（机器判），不动渲染——仓库没有渲染测试环境，这一点不改变。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (/\.tsx$/.test(name)) out.push(p);
	}
	return out;
}

/**
 * 源码级不变量。返回违规说明数组（空数组 = 合规）。
 * 只看「真正调用 virtualizer.measureElement」的文件：stub、测试替身、只写注释的不在此列。
 */
export function checkSource(source) {
	const problems = [];
	if (!/virtualizer\.measureElement\(\s*[A-Za-z_$]/.test(source)) return problems;
	// 1. 必须有卸载清理入口
	if (!/measureElement\(\s*null\s*\)/.test(source)) {
		problems.push("调了 measureElement(node) 却没有 measureElement(null)：卸载的行会留在 elementsCache 里");
	}
	// 2. 若持有「按 key 存的 ref 回调缓存」，卸载分支必须淘汰它
	const cacheDecl = source.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useMemo\(\s*\(\)\s*=>\s*new Map</);
	if (cacheDecl) {
		const name = cacheDecl[1];
		if (!new RegExp("\\b" + name + "\\.delete\\(").test(source)) {
			problems.push(name + " 里的闭包缓存没有 delete：键数随「曾经挂载过的行数」增长");
		}
	}
	return problems;
}

test("仓库里的虚拟栈都满足测量清理口径", () => {
	const files = walk(SRC).filter((f) => f.endsWith(".tsx"));
	const offenders = [];
	for (const file of files) {
		const problems = checkSource(readFileSync(file, "utf8"));
		if (problems.length) offenders.push(relative(ROOT, file) + " → " + problems.join("；"));
	}
	assert.deepEqual(offenders, [], "虚拟化测量清理口径被破坏：\n" + offenders.join("\n"));
});

// ── 坏样本：三条都必须红，一条好的必须绿 ──
test("坏样本：只 return 不交 null → 红", () => {
	const bad = "const r = (node) => { if (!node) return; virtualizer.measureElement(node); };";
	assert.equal(checkSource(bad).length > 0, true, "旧写法（只 return）必须被抓到");
});

test("坏样本：交了 null 但没淘汰闭包缓存 → 红", () => {
	const bad = ["const measureRefs = useMemo(() => new Map<string, (n) => void>(), [virtualizer]);", "const cb = (node) => { if (!node) { virtualizer.measureElement(null); return; } virtualizer.measureElement(node); };", "measureRefs.set(id, cb);"].join("\n");
	const problems = checkSource(bad);
	assert.equal(
		problems.some((p) => p.includes("closur") || p.includes("闭包") || p.includes("delete")),
		true,
		"缺 delete 必须被抓到：" + problems.join("/"),
	);
});

test("好样本：交 null + 淘汰缓存 → 绿", () => {
	const good = ["const measureRefs = useMemo(() => new Map<string, (n) => void>(), [virtualizer]);", "const cb = (node) => { if (!node) { virtualizer.measureElement(null); measureRefs.delete(id); return; } virtualizer.measureElement(node); };"].join("\n");
	assert.deepEqual(checkSource(good), []);
});

test("不适用：没调 measureElement 的文件不被这条判据管", () => {
	assert.deepEqual(checkSource("const estimateHeight = 20; export const X = () => null;"), []);
});

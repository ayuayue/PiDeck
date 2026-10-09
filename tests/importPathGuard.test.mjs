import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const guard = await loadTsCommonJs("src/main/sessions/importPathGuard.ts");

test("词法前缀校验防 .. 逃逸：resolve 后比较", () => {
	const { isPathInsideRoot } = guard;
	// 直接子路径放行
	assert.equal(isPathInsideRoot("C:/Users/x/.codex/sessions", "C:/Users/x/.codex/sessions/2026/01/s.jsonl"), true);
	// 反斜杠/大小写差异放行（Windows 语义）
	assert.equal(isPathInsideRoot("c:\\users\\x\\.codex\\sessions", "C:/Users/x/.codex/sessions/s.jsonl"), true);
	// 等于根放行（导入器约定 target !== root 时才要求前缀，根自身合法）
	assert.equal(isPathInsideRoot("C:/Users/x/.codex", "C:/Users/x/.codex"), true);
	// .. 词法绕过必须被拒（resolve 后已出根）
	assert.equal(isPathInsideRoot("C:/Users/x/.codex/sessions", "C:/Users/x/.codex/sessions/../../../../../Windows/system32/config/sam"), false);
	assert.equal(isPathInsideRoot("C:/Users/x/.codex/sessions", "C:/Users/x/.codex/sessions/.."), false);
	// 兄弟目录前缀混淆必须被拒（minimax 旧实现漏掉的 / 边界）
	assert.equal(isPathInsideRoot("C:/Users/x/.minimax/sessions", "C:/Users/x/.minimax/sessions-evil/m.jsonl"), false);
	// 完全外部路径拒绝
	assert.equal(isPathInsideRoot("C:/Users/x/.codex/sessions", "D:/other/place/s.jsonl"), false);
});

test("assertSourceWithinRoot 抛结构化错误并带来源标签", () => {
	const { assertSourceWithinRoot } = guard;
	assert.throws(() => assertSourceWithinRoot("C:/r/sessions", "C:/r/sessions/../../etc/passwd", "Codex"), /Codex session path is outside/);
	assert.doesNotThrow(() => assertSourceWithinRoot("C:/r/sessions", "C:/r/sessions/a.jsonl", "Codex"));
});

test("目录语义：目录根的父路径不吞子目录前缀", () => {
	const { isPathInsideRoot } = guard;
	// 目录本身在根下（用于 minimax 的 dirname 校验）
	assert.equal(isPathInsideRoot("C:/Users/x/.minimax", "C:/Users/x/.minimax/sessions/abc"), true);
	assert.equal(isPathInsideRoot("C:/Users/x/.minimax", "C:/Users/x/.minimax-evil/sessions/abc"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS, evaluatePull } from "../scripts/prGate.mjs";

/**
 * 社区 PR 首筛门禁的行为测试（docs/pr-merge-gate.md §1–§2）。
 * 全部断言走导出的 evaluatePull()：规则一旦从模块里挪走或口径变化，这里就该红。
 */

const pull = (overrides = {}) => ({
	number: 1,
	title: "样例",
	author: "someone",
	additions: 10,
	deletions: 2,
	changedFiles: 1,
	files: [{ path: "src/main/foo.ts", additions: 8, deletions: 2 }],
	patch: "",
	...overrides,
});

const codes = (result) => result.reasons.map((reason) => reason.code);

test("docs-only 小改动通过", () => {
	const result = evaluatePull(pull({ files: [{ path: "docs/x.md", additions: 5, deletions: 0 }], changedFiles: 1 }));
	assert.equal(result.verdict, "allow");
	assert.deepEqual(codes(result), []);
	assert.equal(result.facts.docsOnly, true);
});

test("超过拒绝阈值直接 block", () => {
	const result = evaluatePull(pull({ additions: LIMITS.blockLines, deletions: 1, changedFiles: 2 }));
	assert.equal(result.verdict, "block");
	assert.ok(codes(result).includes("SIZE_BLOCK"));
});

test("大 PR 要求人工 + 禁止自动合并标记", () => {
	const result = evaluatePull(pull({ additions: LIMITS.manualLines, deletions: 1, changedFiles: 3 }));
	assert.equal(result.verdict, "manual");
	assert.ok(codes(result).includes("SIZE_LARGE"));
});

test("关闭 Electron 隔离的新增行命中红线", () => {
	const result = evaluatePull(
		pull({
			patch: "--- a/src/main/index.ts\n+++ b/src/main/index.ts\n@@\n+	webPreferences: { webSecurity: false },\n",
			files: [
				{ path: "src/main/index.ts", additions: 1, deletions: 0 },
				{ path: "tests/index.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
		}),
	);
	assert.equal(result.verdict, "block");
	assert.ok(codes(result).includes("R1_ELECTRON_ISOLATION_OFF"));
});

test("泄漏的密钥字面量命中红线", () => {
	const fakeKey = ["sk", "a".repeat(24)].join("-");
	const result = evaluatePull(pull({ patch: `+const key = "${fakeKey}";\n` }));
	assert.equal(result.verdict, "block");
	assert.ok(codes(result).includes("R5_SECRET_LITERAL"));
});

test("测试里的假 token 只提醒，不当红线", () => {
	const fakeKey = ["ghp", "b".repeat(24)].join("_");
	const result = evaluatePull(
		pull({
			files: [
				{ path: "src/main/log.ts", additions: 2, deletions: 0 },
				{ path: "tests/log.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
			patch: `diff --git a/tests/log.test.mjs b/tests/log.test.mjs\n+++ b/tests/log.test.mjs\n+const token = "${fakeKey}";\n`,
		}),
	);
	assert.equal(result.verdict, "manual");
	assert.ok(codes(result).includes("R5_SECRET_IN_TEST"));
	assert.ok(!codes(result).includes("R5_SECRET_LITERAL"));
});

test("改源码但不带测试 → 人工复核", () => {
	const result = evaluatePull(pull());
	assert.equal(result.verdict, "manual");
	assert.ok(codes(result).includes("NO_TEST_EVIDENCE"));
});

test("带测试的源码改动通过首筛", () => {
	const result = evaluatePull(
		pull({
			files: [
				{ path: "src/main/foo.ts", additions: 8, deletions: 2 },
				{ path: "tests/foo.test.mjs", additions: 20, deletions: 0 },
			],
			changedFiles: 2,
			patch: "+export const foo = 1;\n",
		}),
	);
	assert.equal(result.verdict, "allow");
});

test("删除测试用例需要说明功能被移除", () => {
	const result = evaluatePull(
		pull({
			files: [{ path: "tests/nav.test.mjs", additions: 0, deletions: 12 }],
			patch: '--- a/tests/nav.test.mjs\n+++ b/tests/nav.test.mjs\n@@\n-test("goes back", () => {});\n',
		}),
	);
	assert.equal(result.verdict, "manual");
	assert.ok(codes(result).includes("TEST_DELETED"));
});

test("新增只读源码的测试被拦下", () => {
	const result = evaluatePull(
		pull({
			files: [{ path: "tests/guard.test.mjs", additions: 6, deletions: 0 }],
			patch: "+const src = readFile" + 'Sync("src/main/index.ts", "utf8");\n',
		}),
	);
	assert.equal(result.verdict, "manual");
	assert.ok(codes(result).includes("SOURCE_ONLY_TEST"));
});

test("改 zh-CN 未带 zh-TW 生成物 → 人工复核", () => {
	const result = evaluatePull(
		pull({
			files: [
				{ path: "src/renderer/src/i18n/rendererCopy.zh-CN.ts", additions: 3, deletions: 1 },
				{ path: "tests/copy.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
		}),
	);
	assert.ok(codes(result).includes("I18N_NOT_REGENERATED"));
});

test("package.json 依赖变更需人工核对", () => {
	const result = evaluatePull(
		pull({
			files: [
				{ path: "package.json", additions: 2, deletions: 0 },
				{ path: "tests/pkg.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
			patch: 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@\n+    "some-lib": "^1.2.3",\n',
		}),
	);
	assert.ok(codes(result).includes("R2_DEPENDENCY_CHANGE"));
});

test("正则 .test( 的删除行不算删测试", () => {
	const result = evaluatePull(
		pull({
			files: [
				{ path: "src/main/version.ts", additions: 2, deletions: 2 },
				{ path: "tests/version.test.mjs", additions: 2, deletions: 0 },
			],
			changedFiles: 2,
			patch: "--- a/src/main/version.ts\n+++ b/src/main/version.ts\n@@\n-\t\tif (!NPM_EXACT_VERSION_RE.test(version)) {\n",
		}),
	);
	assert.ok(!codes(result).includes("TEST_DELETED"));
	assert.equal(result.verdict, "allow");
});

test("只读源码的断言只在测试文件里拦", () => {
	const result = evaluatePull(
		pull({
			files: [
				{ path: "scripts/check-wiring.mjs", additions: 1, deletions: 0 },
				{ path: "tests/wiring.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
			patch: "diff --git a/scripts/check-wiring.mjs b/scripts/check-wiring.mjs\n+++ b/scripts/check-wiring.mjs\n+const src = readFile" + 'Sync("src/main/index.ts", "utf8");\n',
		}),
	);
	assert.ok(!codes(result).includes("SOURCE_ONLY_TEST"));
});

test("shell:true 新增行需要人工确认", () => {
	const result = evaluatePull(
		pull({
			patch: "+exec(command, { shell: true });\n",
			files: [
				{ path: "src/main/run.ts", additions: 1, deletions: 0 },
				{ path: "tests/run.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
		}),
	);
	assert.ok(codes(result).includes("R4_SHELL_TRUE"));
});

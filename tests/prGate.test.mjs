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

test("删除用例多于新增用例时才报 TEST_DELETED", () => {
	const result = evaluatePull(
		pull({
			files: [{ path: "tests/nav.test.mjs", additions: 0, deletions: 12 }],
			patch: '--- a/tests/nav.test.mjs\n+++ b/tests/nav.test.mjs\n@@\n-test("goes back", () => {});\n',
		}),
	);
	assert.equal(result.verdict, "manual");
	assert.ok(codes(result).includes("TEST_DELETED"));
});

test("改写用例（删旧加新）不算删测试", () => {
	const result = evaluatePull(
		pull({
			files: [{ path: "tests/nav.test.mjs", additions: 14, deletions: 12 }],
			patch: ["diff --git a/tests/nav.test.mjs b/tests/nav.test.mjs", "+++ b/tests/nav.test.mjs", "@@", '-test("goes back", () => {});', '-test("goes forward", () => {});', '+test("goes back", () => {});', '+test("goes forward", () => {});', '+test("goes home", () => {});'].join("\n"),
		}),
	);
	assert.ok(!codes(result).includes("TEST_DELETED"));
});

test("赋值式/引号键关闭隔离同样命中（R1 不能只认 JSX 字面量）", () => {
	for (const line of ["\twebPreferences.webSecurity = false;", '\t"nodeIntegration": true,']) {
		const result = evaluatePull(
			pull({
				patch: `diff --git a/src/main/index.ts b/src/main/index.ts\n+++ b/src/main/index.ts\n@@\n+${line}\n`,
				files: [
					{ path: "src/main/index.ts", additions: 1, deletions: 0 },
					{ path: "tests/index.test.mjs", additions: 1, deletions: 0 },
				],
				changedFiles: 2,
			}),
		);
		assert.equal(result.verdict, "block", line);
		assert.ok(codes(result).includes("R1_ELECTRON_ISOLATION_OFF"), line);
	}
});

test("sandbox:false 只提醒（主窗口当前就是 false，不是新增红线）", () => {
	const result = evaluatePull(
		pull({
			patch: "+\t\tsandbox: false,\n",
			files: [
				{ path: "src/main/win.ts", additions: 1, deletions: 0 },
				{ path: "tests/win.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
		}),
	);
	assert.equal(result.verdict, "manual");
	assert.ok(codes(result).includes("R1_SANDBOX_OFF"));
	assert.ok(!codes(result).includes("R1_ELECTRON_ISOLATION_OFF"));
});

test("测试文件里的隔离开关只提醒", () => {
	const result = evaluatePull(
		pull({
			files: [
				{ path: "src/main/index.ts", additions: 2, deletions: 0 },
				{ path: "tests/index.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
			patch: "diff --git a/tests/index.test.mjs b/tests/index.test.mjs\n+++ b/tests/index.test.mjs\n+expect(webPreferences.webSecurity = false).toBeUndefined();\n",
		}),
	);
	assert.equal(result.verdict, "manual");
	const hit = result.reasons.find((reason) => reason.code === "R1_ELECTRON_ISOLATION_OFF");
	assert.equal(hit?.level, "manual");
});

test("exec 接变量要人看，接字面量不报", () => {
	const variable = evaluatePull(pull({ patch: "+exec(userCmd);\n" }));
	assert.ok(codes(variable).includes("R4_EXEC_NON_LITERAL"));
	const literal = evaluatePull(pull({ patch: '+execSync("git status");\n' }));
	assert.ok(!codes(literal).includes("R4_EXEC_NON_LITERAL"));
});

test("新增凭据类文件直接 block", () => {
	const result = evaluatePull(
		pull({
			files: [{ path: ".env.local", additions: 1, deletions: 0 }],
			changedFiles: 1,
			patch: "diff --git a/.env.local b/.env.local\nnew file mode 100644\n+++ b/.env.local\n@@\n+FOO=bar\n",
		}),
	);
	assert.equal(result.verdict, "block");
	assert.ok(codes(result).includes("R5_SENSITIVE_FILE"));
});

test("往 pi 会话 jsonl 直接写要人看，evidence 日志不报", () => {
	const sessions = evaluatePull(
		pull({
			patch: "diff --git a/src/main/pi/x.ts b/src/main/pi/x.ts\n+++ b/src/main/pi/x.ts\n+fs.appendFileSync(join(piSessionsDir, `${id}.jsonl`), line);\n",
		}),
	);
	assert.ok(codes(sessions).includes("R5_PI_JSONL_WRITE"));
	const evidence = evaluatePull(
		pull({
			patch: 'diff --git a/scripts/lab.js b/scripts/lab.js\n+++ b/scripts/lab.js\n+fs.appendFileSync(join(root, "evidence", "runtime.jsonl"), record);\n',
		}),
	);
	assert.ok(!codes(evidence).includes("R5_PI_JSONL_WRITE"));
});

test("密钥写成字面量要人看，process.env 不报", () => {
	const literal = evaluatePull(pull({ patch: '+const apiKey = "abcdefghijkl0123456789";\n' }));
	assert.ok(codes(literal).includes("R5_SECRET_ASSIGNMENT"));
	const assigned = evaluatePull(
		pull({
			files: [
				{ path: "src/main/ai.ts", additions: 2, deletions: 0 },
				{ path: "tests/ai.test.mjs", additions: 1, deletions: 0 },
			],
			changedFiles: 2,
			patch: "+const apiKey = process.env.API_KEY;\n",
		}),
	);
	assert.ok(!codes(assigned).includes("R5_SECRET_ASSIGNMENT"));
});

test("改门禁又带产品代码 → block；加 --allow-protected 才放行", () => {
	const mixed = pull({
		files: [
			{ path: "scripts/check-test-shape.mjs", additions: 3, deletions: 1 },
			{ path: "src/main/index.ts", additions: 3, deletions: 0 },
			{ path: "tests/index.test.mjs", additions: 3, deletions: 0 },
		],
		changedFiles: 3,
	});
	assert.equal(evaluatePull(mixed).verdict, "block");
	assert.ok(codes(evaluatePull(mixed)).includes("SELF_PROTECTED_PATH"));
	assert.equal(evaluatePull(mixed, { allowProtected: true }).verdict, "allow");
});

test("只改 CI 不算门禁自改的 block", () => {
	const result = evaluatePull(
		pull({
			files: [{ path: ".github/workflows/dev-guard.yml", additions: 4, deletions: 1 }],
			changedFiles: 1,
		}),
	);
	assert.equal(result.verdict, "allow");
	assert.ok(codes(result).includes("SELF_PROTECTED_PATH"));
});

test("新增 e2e：自己 launch 要人看，走 fixtures 只提醒", () => {
	const selfLaunch = evaluatePull(
		pull({
			files: [
				{ path: "e2e/new-feature.spec.ts", additions: 40, deletions: 0 },
				{ path: "src/renderer/src/App.tsx", additions: 5, deletions: 1 },
			],
			changedFiles: 2,
			patch: 'diff --git a/e2e/new-feature.spec.ts b/e2e/new-feature.spec.ts\nnew file mode 100644\n+++ b/e2e/new-feature.spec.ts\n+import { _electron as electron } from "@playwright/test";\n',
		}),
	);
	assert.equal(selfLaunch.verdict, "manual");
	assert.ok(codes(selfLaunch).includes("E2E_SELF_LAUNCH"));
	const withFixtures = evaluatePull(
		pull({
			files: [
				{ path: "e2e/new-feature.spec.ts", additions: 40, deletions: 0 },
				{ path: "src/renderer/src/App.tsx", additions: 5, deletions: 1 },
			],
			changedFiles: 2,
			patch: 'diff --git a/e2e/new-feature.spec.ts b/e2e/new-feature.spec.ts\nnew file mode 100644\n+++ b/e2e/new-feature.spec.ts\n+import { test, expect } from "./fixtures";\n',
		}),
	);
	assert.equal(withFixtures.verdict, "allow");
	assert.ok(codes(withFixtures).includes("E2E_NEW_SPEC"));
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

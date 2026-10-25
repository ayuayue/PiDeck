/**
 * dsh-bill 启动回填补丁测试（host 启动 CPU 修复）。
 *
 * 背景：dsh-bill@0.14 启动时 backfillFromLog() 全量回放历史会话日志，会话文件
 * 大时 CPU 飙升且超时会话每次启动重放。补丁把 lifecycle 链里的
 * `.then(() => backfillLog())` 换成 env 守卫（DSH_BILL_BACKFILL=1 才回填）。
 *
 * 测试策略：
 * - 补丁函数（applyDshBillBackfillPatch）用 loadTsCommonJs 加载真实 TS 模块，
 *   配临时目录中的仿 dsh-bill 包（package.json + lib/index.js）验证各分支；
 * - 接线（DshHost.start 在 fork 前调用补丁）用源码正则断言（与
 *   dshManualStopWiring.test.mjs 同款静态接线检查，避免为接线拉起真实 boot）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { applyDshBillBackfillPatch } = loadTsCommonJs("src/main/dsh/dshBillBackfillPatch.ts");

/** 官方 dsh-bill@0.14 lifecycle 链（不含 apply 方法的闭合括号，来自 node_modules 实测）。 */
const OFFICIAL_CHAIN = ["hostkitReady", "\t.then(() => loadPrefs())", "\t.then(() => loadRollup())", "\t.then(() => loadPersisted())", "\t.then(() => { loading = false; persist() })", "\t.then(() => Promise.all([ensurePricingLoaded(), ensureFxLoaded()]))", "\t.then(() => backfillFromLog())", "\t.catch(() => {})"].join(
	"\n",
);

/** 把 lifecycle 链包进真实的 apply() 结构（中括号平衡，可过 new Function 语法检查）。 */
const wrapApply = (chain) => `const hostkitReady = Promise.resolve();\nconst plugin = {\n\tapply() {\n${chain}\n\t},\n};\n`;

/** 官方形态完整夹具（语法合法）。 */
const OFFICIAL_LIFECYCLE = wrapApply(OFFICIAL_CHAIN);

/** 在临时目录构造仿 dsh-bill 包（package.json name=dsh-bill + lib/index.js）。 */
function makeFakeDshBill(indexBody) {
	const root = mkdtempSync(join(tmpdir(), "pideck-dshbill-test-"));
	mkdirSync(join(root, "lib"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dsh-bill", version: "0.14.0", main: "lib/index.js" }));
	const entry = join(root, "lib", "index.js");
	writeFileSync(entry, indexBody);
	return { root, entry };
}

test("补丁：官方 0.14 lifecycle 片段被替换为 env 守卫（默认不再回填）", () => {
	const { root, entry } = makeFakeDshBill(OFFICIAL_LIFECYCLE);
	const logs = [];
	try {
		const applied = applyDshBillBackfillPatch(entry, (message) => logs.push(message));
		assert.equal(applied, true);
		const patched = readFileSync(entry, "utf8");
		// 回填调用消失，守卫出现且默认 return（跳过）。
		assert.ok(!patched.includes(".then(() => backfillFromLog())"));
		assert.match(patched, /process\.env\.DSH_BILL_BACKFILL === "1"/);
		assert.match(patched, /return backfillFromLog\(\)/);
		// 链上其他步骤原样保留（实时记账 / pricing 加载不受影响）。
		assert.match(patched, /\.then\(\(\) => loadPersisted\(\)\)/);
		assert.match(patched, /ensurePricingLoaded\(\), ensureFxLoaded\(\)/);
		// 语法合法（Function 构造器编译，不执行）。
		assert.doesNotThrow(() => new Function(patched));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("补丁幂等：已打补丁的文件再次应用返回 false 且内容不变", () => {
	const { root, entry } = makeFakeDshBill(OFFICIAL_LIFECYCLE);
	try {
		assert.equal(
			applyDshBillBackfillPatch(entry, () => {}),
			true,
		);
		const once = readFileSync(entry, "utf8");
		assert.equal(
			applyDshBillBackfillPatch(entry, () => {}),
			false,
		);
		assert.equal(readFileSync(entry, "utf8"), once);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("补丁容错：目标串缺失（未来版本）不写文件且不抛错", () => {
	const { root, entry } = makeFakeDshBill("hostkitReady.then(() => loadPrefs())\n");
	const logs = [];
	try {
		assert.equal(
			applyDshBillBackfillPatch(entry, (message) => logs.push(message)),
			false,
		);
		assert.equal(readFileSync(entry, "utf8"), "hostkitReady.then(() => loadPrefs())\n");
		assert.ok(logs.some((line) => line.includes("未找到目标代码")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("补丁容错：目标串出现多次（压缩产物）不盲改", () => {
	const body = `const a = ${OFFICIAL_LIFECYCLE}\nconst b = ${OFFICIAL_LIFECYCLE}\n`;
	const { root, entry } = makeFakeDshBill(body);
	try {
		assert.equal(
			applyDshBillBackfillPatch(entry, () => {}),
			false,
		);
		assert.equal(readFileSync(entry, "utf8"), body);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("补丁解析：从包 main 入口向上定位包根，lib/index.js 优先于入口兜底", () => {
	// require.resolve 返回的是包 main（lib/index.js）；这里故意让入口 != 标准路径
	// 也能命中：入口即 lib/index.js 的标准布局本就由候选 1 覆盖。
	const { root, entry } = makeFakeDshBill(OFFICIAL_LIFECYCLE);
	try {
		assert.equal(
			applyDshBillBackfillPatch(entry, () => {}),
			true,
		);
		assert.ok(readFileSync(join(root, "lib", "index.js"), "utf8").includes("DSH_BILL_BACKFILL"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("补丁容错：入口文件不存在时不抛错返回 false", () => {
	const logs = [];
	assert.equal(
		applyDshBillBackfillPatch(join(tmpdir(), "pideck-nonexistent", "index.js"), (message) => logs.push(message)),
		false,
	);
	assert.ok(logs.some((line) => line.includes("入口文件不存在")));
});

test("接线：DshHost.start 在 fork 前对 host 实际加载的 dsh-bill 应用补丁", () => {
	const source = readFileSync("src/main/dsh/DshHost.ts", "utf8");
	// 补丁调用点必须在 start() 内、且晚于 runtimeRoot 解析（require 锚点与
	// hostEntry 的 require.resolve("dsh-bill") 同源）。
	const startIdx = source.indexOf("private async start()");
	const patchIdx = source.indexOf('applyDshBillBackfillPatch(require.resolve("dsh-bill")');
	const runtimeRootIdx = source.indexOf("const runtimeRoot = this.resolveRuntimeAppRoot");
	assert.ok(startIdx >= 0, "start() 存在");
	assert.ok(runtimeRootIdx > startIdx, "runtimeRoot 在 start() 内解析");
	assert.ok(patchIdx > runtimeRootIdx, "补丁在 runtimeRoot 解析之后（同一 require 锚点）");
	// fork 在补丁之后：补丁必须先于 host 进程加载 dsh-bill 落盘。
	const forkIdx = source.indexOf("new DshHostProcess(", patchIdx);
	assert.ok(forkIdx > patchIdx, "fork 在补丁之后");
	// 失败不阻断 boot：try/catch 包裹。
	assert.match(source, /try \{\s*applyDshBillBackfillPatch/);
});

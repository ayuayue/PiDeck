import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runPackageRootRuleRepair, scanInstalledPackageDirs } = loadTsCommonJs("src/main/config/piPackageRootRuleRepair.ts");

/** 构造 <dir>/npm/node_modules 骨架（含一个普通包与一个 @scope 包）。 */
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-pkgrepair-"));
	const npmRoot = join(dir, "npm", "node_modules");
	mkdirSync(join(npmRoot, "billion-context-pi"), { recursive: true });
	mkdirSync(join(npmRoot, "@scope", "tool"), { recursive: true });
	return { dir, npmRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("scanInstalledPackageDirs 返回包目录（含 @scope 一层），根不存在时返回空", () => {
	const { dir, npmRoot, cleanup } = setup();
	try {
		assert.deepEqual([...scanInstalledPackageDirs(npmRoot)].sort(), [join(npmRoot, "@scope", "tool"), join(npmRoot, "billion-context-pi")].sort());
		assert.deepEqual([...scanInstalledPackageDirs(join(dir, "missing", "node_modules"))], []);
	} finally {
		cleanup();
	}
});

test("清掉指向包目录的残留规则，其余规则不动，并写日志", async () => {
	const { npmRoot, cleanup } = setup();
	try {
		const pkgDir = join(npmRoot, "billion-context-pi");
		const calls = [];
		const logs = [];
		const result = await runPackageRootRuleRepair(
			{
				service: {
					stripPackageRootResourceRules: async (scope, packageDirs) => {
						calls.push({ scope, packageDirs: [...packageDirs] });
						return { ok: true, removed: [`-${pkgDir}`] };
					},
				},
				npmRoot: () => npmRoot,
				logger: { info: (scope, message, detail) => logs.push({ scope, message, detail }), warn: () => {} },
			},
			{ scope: "global" },
		);
		assert.equal(result.status, "cleaned");
		assert.deepEqual([...result.removed], [`-${pkgDir}`]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].scope.scope, "global");
		// 服务拿到的是扫描出来的包目录（不依赖 packages 条目形态）
		assert.equal(calls[0].packageDirs.includes(pkgDir), true);
		assert.equal(logs.length, 1);
	} finally {
		cleanup();
	}
});

test("没有可删规则时不报错（skipped），扫描不到包目录时直接跳过", async () => {
	const { npmRoot, cleanup } = setup();
	try {
		const noRule = await runPackageRootRuleRepair({ service: { stripPackageRootResourceRules: async () => ({ ok: true, removed: [] }) }, npmRoot: () => npmRoot }, { scope: "global" });
		assert.equal(noRule.status, "skipped");
		let called = 0;
		const noPackages = await runPackageRootRuleRepair(
			{
				service: {
					stripPackageRootResourceRules: async () => {
						called += 1;
						return { ok: true, removed: [] };
					},
				},
				npmRoot: () => join(npmRoot, "missing-root"),
			},
			{ scope: "global" },
		);
		assert.equal(noPackages.status, "skipped");
		assert.equal(called, 0, "没有包目录可参考时不应该去改设置文件");
	} finally {
		cleanup();
	}
});

test("写失败或抛异常只记警告，不向上抛（不能阻塞启动）", async () => {
	const { npmRoot, cleanup } = setup();
	try {
		const warnings = [];
		const failed = await runPackageRootRuleRepair(
			{
				service: { stripPackageRootResourceRules: async () => ({ ok: false, error: "ELOCKED", removed: [] }) },
				npmRoot: () => npmRoot,
				logger: { info: () => {}, warn: (scope, message, detail) => warnings.push({ scope, message, detail }) },
			},
			{ scope: "global" },
		);
		assert.equal(failed.status, "failed");
		assert.match(failed.error, /ELOCKED/);
		const thrown = await runPackageRootRuleRepair(
			{
				service: {
					stripPackageRootResourceRules: async () => {
						throw new Error("boom");
					},
				},
				npmRoot: () => npmRoot,
			},
			{ scope: "global" },
		);
		assert.equal(thrown.status, "failed");
		assert.match(thrown.error, /boom/);
		assert.equal(warnings.length, 1);
	} finally {
		cleanup();
	}
});

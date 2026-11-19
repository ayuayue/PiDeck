import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validatePackageJson } from "../scripts/check-package-json.mjs";

/**
 * package.json 结构门禁的分辨力测试（docs/pr-merge-gate.md §1 R7）。
 * 全部断言走导出的 validatePackageJson()：判据被改宽、改恒真，这里必须红。
 * 坏样本取自 2026-11-15 事故的真实形态：段头被删、JSON 仍合法、依赖名混进 scripts。
 */

const healthy = () =>
	JSON.stringify({
		name: "pideck",
		version: "0.0.0",
		scripts: { build: "vite build", "check:format": "biome format src" },
		dependencies: { "electron-updater": "6.6.2" },
		devDependencies: { typescript: "5.9.3" },
	});

test("结构完整的 package.json 通过", () => {
	assert.deepEqual(validatePackageJson(healthy()), []);
});

test("dependencies 段被吞进 scripts（2026-11-15 事故形态）被拒", () => {
	const broken = JSON.parse(healthy());
	broken.dependencies["@agentclientprotocol/sdk"] = "1.4.0";
	broken.scripts = { ...broken.scripts, ...broken.dependencies };
	delete broken.dependencies;
	const problems = validatePackageJson(JSON.stringify(broken));
	// 不带作用域的依赖名（`electron-updater`）与普通脚本键同形，只靠「缺 dependencies 段」抓；
	// 带作用域/斜杠的包名会同时命中第二条，两条都在才是真分辨力。
	assert.ok(
		problems.some((problem) => problem.includes("缺 dependencies 段")),
		problems.join(" / "),
	);
	assert.ok(
		problems.some((problem) => problem.includes("混进了包名样式的键")),
		problems.join(" / "),
	);
});

test("JSON 合法但缺段时不能放过", () => {
	const broken = { name: "pideck", version: "0.0.0", scripts: { build: "vite build" } };
	assert.notDeepEqual(validatePackageJson(JSON.stringify(broken)), []);
});

test("非法 JSON 直接报", () => {
	assert.deepEqual(validatePackageJson('{"name": "x",}').length, 1);
});

test("版本值不是非空字符串时被拒", () => {
	const broken = JSON.parse(healthy());
	broken.dependencies["electron-updater"] = { version: "6.6.2" };
	assert.ok(validatePackageJson(JSON.stringify(broken)).some((problem) => problem.includes("版本不是非空字符串")));
});

test("仓库当前的 package.json 通过判据", () => {
	assert.deepEqual(validatePackageJson(readFileSync("package.json", "utf8")), []);
});

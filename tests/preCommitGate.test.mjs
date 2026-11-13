import assert from "node:assert/strict";
import test from "node:test";
import { pickFormattableStagedFiles } from "../scripts/preCommitGate.mjs";

/**
 * 本地提交守卫（.githooks/pre-commit → scripts/preCommitGate.mjs）的纯函数契约。
 *
 * 只测「哪些暂存文件该交给 biome」这一段：全仓扫描的两条守卫有自己的测试
 * （check-file-size / check-test-shape 是命令行脚本，CI 与钩子共用）。
 */
test("只把存在的可格式化源文件交给 biome", () => {
	const staged = ["src/main/index.ts", "src/renderer/src/App.tsx", "scripts/preCommitGate.mjs", "src/shared/ipc.ts", "package.json", "src/renderer/src/styles/surfaces.css", "AGENTS.md", "docs/mega-file-split-plan.md", ".github/workflows/ci.yml", "src/main/pi/removed-file.ts"];
	assert.deepEqual(pickFormattableStagedFiles(staged), ["src/main/index.ts", "src/renderer/src/App.tsx", "scripts/preCommitGate.mjs", "src/shared/ipc.ts", "package.json", "src/renderer/src/styles/surfaces.css"]);
});

test("空输入返回空数组（没有暂存文件时钩子不该调 biome）", () => {
	assert.deepEqual(pickFormattableStagedFiles([]), []);
});

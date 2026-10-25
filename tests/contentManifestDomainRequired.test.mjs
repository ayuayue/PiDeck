import test from "node:test";
import assert from "node:assert/strict";
import { generateContentManifest } from "../scripts/generate-content-manifests.mjs";

// 裸调用（缺 --domain）必须报"缺失"而不是误导性的 "unknown domain: null"：
// parseArgs 允许 domain:null 透传，generateContentManifest 需要把两种情况分开，
// 手动跑脚本的人才能一眼知道要补什么参数（2026-03 docs 命令照抄失败排查）。
test("generateContentManifest rejects missing domain with actionable error", () => {
	assert.throws(
		() => generateContentManifest({}),
		(error) => error instanceof Error && error.message.includes("missing required --domain"),
		"domain 缺失时应报 missing required --domain 而不是 unknown domain: null",
	);
});

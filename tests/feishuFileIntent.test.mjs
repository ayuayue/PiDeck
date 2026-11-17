import { mkdtempSync } from "./helpers/tempDir.mjs";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function loadFileIntentModule() {
	const source = readFileSync("src/main/feishu/fileIntent.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (name) => {
			if (name === "node:fs") return { existsSync };
			if (name === "node:path") return { isAbsolute: (p) => p.startsWith("/"), join };
			throw new Error(`unexpected require: ${name}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "fileIntent.ts" });
	return sandbox.exports;
}

test("detects Chinese request to send a workspace file", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-file-intent-"));
	const fp = join(dir, "temp.pdf");
	writeFileSync(fp, "pdf");
	const { resolveFeishuFileSendIntent } = loadFileIntentModule();

	assert.equal(resolveFeishuFileSendIntent("把 temp.pdf 这个文件发给我", dir), fp);
});

test("detects html file send request", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-file-intent-"));
	const fp = join(dir, "Pi-Agent-整修计划.html");
	writeFileSync(fp, "html");
	const { resolveFeishuFileSendIntent } = loadFileIntentModule();

	assert.equal(resolveFeishuFileSendIntent("Pi-Agent-整修计划.html这个文件发我", dir), fp);
});

test("requires explicit send intent before executing agent file markers", () => {
	const { hasExplicitFeishuFileSendIntent } = loadFileIntentModule();

	assert.equal(hasExplicitFeishuFileSendIntent("写成一个md文件放到本地"), false);
	assert.equal(hasExplicitFeishuFileSendIntent("写成一个md文件发我"), true);
});

test("ignores non-send file questions", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-file-intent-"));
	writeFileSync(join(dir, "temp.pdf"), "pdf");
	const { resolveFeishuFileSendIntent } = loadFileIntentModule();

	assert.equal(resolveFeishuFileSendIntent("分析 temp.pdf 的内容", dir), undefined);
});

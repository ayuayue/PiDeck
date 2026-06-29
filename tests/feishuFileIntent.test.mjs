import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("ignores non-send file questions", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-file-intent-"));
	writeFileSync(join(dir, "temp.pdf"), "pdf");
	const { resolveFeishuFileSendIntent } = loadFileIntentModule();

	assert.equal(resolveFeishuFileSendIntent("分析 temp.pdf 的内容", dir), undefined);
});

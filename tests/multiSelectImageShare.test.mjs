import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";
import ts from "typescript";
import vm from "node:vm";

function loadAppUtils() {
	const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	// AppUtils 引用 session/composer/chips；vm 沙箱不会解析相对模块，显式桩掉。
	const sandbox = {
		exports: {},
		location: { href: "file:///Users/test/app" },
		require: (id) => {
			if (id === "../session/composer/chips") return { formatFilePathRef: (p) => p };
			return {};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
	return sandbox.exports;
}

test("multi-select image export stays renderable for html-to-image", () => {
	const styles = readRendererStyles();
	const rule = styles.match(/\.multi-select-image-export \{([\s\S]*?)\n\}/)?.[1] ?? "";

	assert.match(rule, /left:\s*0;/);
	assert.doesNotMatch(rule, /-100000px/);
});

test("multi-select image export maps selected assistant messages to their visible run rows", () => {
	const { getMultiSelectImageCaptureIds } = loadAppUtils();
	const user = { kind: "message", message: { id: "u1", role: "user", text: "hi", timestamp: 1 } };
	const run = {
		kind: "agent-run",
		id: "run-1",
		startedAt: 2,
		endedAt: 3,
		items: [
			{ kind: "message", message: { id: "a1", role: "assistant", text: "first", timestamp: 2 } },
			{ kind: "message", message: { id: "a2", role: "assistant", text: "second", timestamp: 3 } },
		],
	};

	const ids = getMultiSelectImageCaptureIds([user, run], new Set(["u1", "a2"]));

	assert.deepEqual([...ids], ["u1", "run-1"]);
});

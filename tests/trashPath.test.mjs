import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// trashPath 统一回收站入口测试：
// 1) 正常转发到 Electron shell.trashItem；
// 2) 回收站不可用时抛错（拒绝静默硬删）。
// 所有「用户主动删除」都必须经由此入口（见 src/main/fs/trash.ts）。

const trashPathModule = "src/main/fs/trash.ts";

function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubs[specifier] ?? {};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
		},
		{ filename: filePath },
	);
	return module.exports;
}

function loadTrashPath(trashItemImpl) {
	const stubs = {
		electron: { shell: { trashItem: trashItemImpl } },
		"../logging/sharedLogger": { getAppLogger: () => null },
	};
	return compile(trashPathModule, stubs).trashPath;
}

test("trashPath 将目标路径转发给 shell.trashItem", async () => {
	const calls = [];
	const trashItem = async (p) => {
		calls.push(p);
	};
	const trashPath = loadTrashPath(trashItem);
	await trashPath("C:/some/user/file.txt");
	assert.deepEqual(calls, ["C:/some/user/file.txt"]);
});

test("trashPath 在回收站不可用时抛错（拒绝静默硬删）", async () => {
	const trashItem = async () => {
		throw new Error("trash unavailable");
	};
	const trashPath = loadTrashPath(trashItem);
	await assert.rejects(() => trashPath("C:/some/user/file.txt"), /trash unavailable/);
});

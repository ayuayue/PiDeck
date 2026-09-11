import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";
import { BUILT_IN_EXTENSIONS } from "../src/main/extensions/builtInExtensions.ts";

const nodeRequire = createRequire(import.meta.url);

/**
 * pi-deck-trash-guard 内置扩展测试：
 * 1) 纯函数（分段/分词/删除目标提取/glob 展开/开关）；
 * 2) 默认导出的 tool_call 行为（vm 加载 + stub spawn）：
 *    删除命令执行前先把副本送回收站、原文件不动、非删除命令不动作。
 */

// ── vm 加载扩展（真实 node 内置模块 + stub child_process / pi 模块） ──

function compileExtension(fakeSpawn) {
	const source = readFileSync("resources/extensions/pi-deck-trash-guard.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "pi-deck-trash-guard.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (specifier) => {
				if (specifier === "node:child_process") return { spawn: fakeSpawn };
				if (specifier === "@earendil-works/pi-coding-agent") return {};
				return nodeRequire(specifier);
			},
			process,
			console,
			Buffer,
			setTimeout,
			clearTimeout,
		},
		{ filename: "pi-deck-trash-guard.ts" },
	);
	return module.exports;
}

/** 构造假 spawn：立即成功返回，记录调用 */
function makeFakeSpawn() {
	const calls = [];
	const fakeSpawn = (file, args) => {
		calls.push({ file, args });
		const listeners = {};
		const child = {
			stderr: { on: () => {} },
			on: (event, cb) => {
				listeners[event] = cb;
			},
		};
		queueMicrotask(() => listeners.close?.(0));
		return child;
	};
	return { calls, fakeSpawn };
}

// ── 纯函数测试 ──

test("splitShellSegments 按 && ; | & 换行分段且引号内不切", () => {
	const ext = compileExtension(() => ({}));
	assert.deepEqual([...ext.splitShellSegments("rm a.txt && rm b.txt; rm c.txt | wc -l")], [
		"rm a.txt",
		"rm b.txt",
		"rm c.txt",
		"wc -l",
	]);
	assert.deepEqual([...ext.splitShellSegments('rm "a;b.txt"')], ['rm "a;b.txt"']);
	assert.deepEqual([...ext.splitShellSegments("echo hi")], ["echo hi"]);
	assert.deepEqual([...ext.splitShellSegments("   ")], []);
});

test("extractDeleteTargets 覆盖 rm/unlink/Windows del/Remove-Item 与标志、重定向", () => {
	const ext = compileExtension(() => ({}));
	const targets = (segment) => [...ext.extractDeleteTargets(segment)];
	// 基础
	assert.deepEqual(targets("rm a.txt b.txt"), ["a.txt", "b.txt"]);
	assert.deepEqual(targets("rm -rf build dist"), ["build", "dist"]);
	assert.deepEqual(targets("unlink a.txt"), ["a.txt"]);
	// -- 之后不再解析标志
	assert.deepEqual(targets("rm -- -weird.txt"), ["-weird.txt"]);
	// 引号路径（Windows 风格反斜杠在双引号内保留）
	assert.deepEqual(targets('rm "C:\\new folder\\a.txt"'), ["C:\\new folder\\a.txt"]);
	// 重定向目标不是删除对象
	assert.deepEqual(targets("rm a.txt > /dev/null"), ["a.txt"]);
	assert.deepEqual(targets("rm a.txt 2>&1"), ["a.txt"]);
	assert.deepEqual(targets("rm a.txt >out.log 2>err.log"), ["a.txt"]);
	// 前缀包装 + 命令绝对路径
	assert.deepEqual(targets("sudo rm -rf x"), ["x"]);
	assert.deepEqual(targets("/usr/bin/rm a.txt"), ["a.txt"]);
	// Windows cmd 删除族：/ 前缀是标志
	assert.deepEqual(targets('del /q /f "my file.txt"'), ["my file.txt"]);
	assert.deepEqual(targets("rmdir /s /q build"), ["build"]);
	// PowerShell：- 前缀是标志；-Path 的值是目标；-Filter 的值丢弃
	assert.deepEqual(targets("Remove-Item -Recurse -Force dist"), ["dist"]);
	assert.deepEqual(targets("Remove-Item -Path foo.txt"), ["foo.txt"]);
	assert.deepEqual(targets("Remove-Item -Filter *.log"), []);
	// 非删除命令
	assert.deepEqual(targets("echo hi"), []);
	assert.deepEqual(targets("git clean -fd"), []);
	assert.deepEqual(targets("ls -la"), []);
});

test("expandGlobTarget 只展开最后一段通配且遵循隐藏文件语义", () => {
	const ext = compileExtension(() => ({}));
	const dir = mkdtempSync(join(tmpdir(), "trash-guard-test-"));
	try {
		writeFileSync(join(dir, "a.log"), "x");
		writeFileSync(join(dir, "b.log"), "x");
		writeFileSync(join(dir, ".hidden.log"), "x");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "cc.log"), "x");

		const rel = (p) => [...p].sort().map((x) => x.replace(/\\/g, "/"));
		// 普通通配不匹配隐藏文件
		assert.deepEqual(rel(ext.expandGlobTarget(join(dir, "*.log"), dir)), [
			join(dir, "a.log").replace(/\\/g, "/"),
			join(dir, "b.log").replace(/\\/g, "/"),
		]);
		// 显式点开头匹配隐藏
		assert.deepEqual(rel(ext.expandGlobTarget(join(dir, ".h*"), dir)), [
			join(dir, ".hidden.log").replace(/\\/g, "/"),
		]);
		// 子目录通配（??.log 匹配两字符文件名）
		assert.deepEqual(rel(ext.expandGlobTarget(join(dir, "sub", "??.log"), dir)), [
			join(dir, "sub", "cc.log").replace(/\\/g, "/"),
		]);
		// ** 不支持 → 空匹配（照常删除但不备份）
		assert.deepEqual([...ext.expandGlobTarget(join(dir, "**"), dir)], []);
		// 无通配原样返回
		assert.deepEqual([...ext.expandGlobTarget(join(dir, "a.log"), dir)], [join(dir, "a.log")]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isGuardEnabled / platformTrashKind", () => {
	const ext = compileExtension(() => ({}));
	assert.equal(ext.isGuardEnabled(undefined), true);
	assert.equal(ext.isGuardEnabled(""), true);
	assert.equal(ext.isGuardEnabled("off"), false);
	assert.equal(ext.isGuardEnabled("0"), false);
	assert.equal(ext.isGuardEnabled("FALSE"), false);
	assert.equal(ext.isGuardEnabled("on"), true);
	assert.equal(ext.platformTrashKind("win32"), "powershell");
	assert.equal(ext.platformTrashKind("darwin"), "osascript");
	assert.equal(ext.platformTrashKind("linux"), "gio");
	assert.equal(ext.platformTrashKind("freebsd"), "unsupported");
});

test("trash-guard 扩展已注册进 BUILT_IN_EXTENSIONS", () => {
	assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-trash-guard.ts"));
});

// ── 默认导出行为测试 ──

test("tool_call: rm 前把副本送回收站（spawn 收到暂存路径），原文件不动", async () => {
	const { calls, fakeSpawn } = makeFakeSpawn();
	const ext = compileExtension(fakeSpawn);
	const dir = mkdtempSync(join(tmpdir(), "trash-guard-e2e-"));
	const target = join(dir, "doomed.txt");
	writeFileSync(target, "precious");

	const handlers = {};
	const fakePi = { on: (event, handler) => (handlers[event] = handler) };
	await ext.default(fakePi);
	assert.ok(handlers.tool_call, "应注册 tool_call 处理器");

	try {
		const result = await handlers.tool_call(
			{ toolName: "bash", input: { command: `rm "${target}"` } },
			{ cwd: dir },
		);
		// 一律放行
		assert.equal(result, undefined);
		// 原文件仍然存在（只备份，不代删）
		assert.equal(existsSync(target), true, "原文件必须保持不动，删除由原命令执行");
		// spawn 被调用且参数含暂存副本路径（Windows 走 powershell EncodedCommand）
		assert.equal(calls.length, 1);
		assert.equal(calls[0].file, "powershell.exe");
		const encoded = calls[0].args[calls[0].args.indexOf("-EncodedCommand") + 1];
		const script = Buffer.from(encoded, "base64").toString("utf16le");
		assert.match(script, /SendToRecycleBin/);
		const stagedPath = script.match(/'([^']+-\d+-doomed\.txt)'/)?.[1];
		assert.ok(stagedPath, "脚本应包含暂存副本路径");
		assert.equal(existsSync(stagedPath), true, "暂存副本应存在（stub spawn 成功后不会被清理）");
		assert.equal(readFileSync(stagedPath, "utf8"), "precious", "副本内容与原文件一致");
		rmSync(join(tmpdir(), "pi-deck-trash-guard"), { recursive: true, force: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool_call: 非 bash 工具与非删除命令不触发备份", async () => {
	const { calls, fakeSpawn } = makeFakeSpawn();
	const ext = compileExtension(fakeSpawn);
	const handlers = {};
	await ext.default({ on: (event, handler) => (handlers[event] = handler) });

	await handlers.tool_call({ toolName: "write", input: { filePath: "x.txt" } }, { cwd: "." });
	await handlers.tool_call({ toolName: "bash", input: { command: "echo hi > hi.txt" } }, { cwd: "." });
	assert.equal(calls.length, 0);
});

test("PIDECK_TRASH_GUARD=off 时不注册处理器", async () => {
	const ext = compileExtension(() => ({}));
	const prev = process.env.PIDECK_TRASH_GUARD;
	process.env.PIDECK_TRASH_GUARD = "off";
	try {
		let registered = false;
		await ext.default({ on: () => (registered = true) });
		assert.equal(registered, false);
	} finally {
		if (prev === undefined) delete process.env.PIDECK_TRASH_GUARD;
		else process.env.PIDECK_TRASH_GUARD = prev;
	}
});

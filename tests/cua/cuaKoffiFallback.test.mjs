import assert from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// issue #313 回归：koffi 原生二进制缺失的打包环境（arm64 runner 打出的 x64
// macOS 包不含 @koromix/koffi-darwin-x64）里，`import koffi` 在模块求值时抛
// 「Cannot find the native Koffi module」，应用启动即崩。约束：cua 模块不许
// 静态 import koffi，只能经 ./koffiRuntime 在函数内惰性加载并对失败降级。

const GUARDED_FILES = ["src/main/cua/CuaWin32.ts", "src/main/cua/CuaEngine.ts"];

test("cua modules never statically import koffi", () => {
	for (const file of GUARDED_FILES) {
		const source = readFileSync(file, "utf8");
		assert.ok(!/^\s*import\s+koffi\s+from\s+["']koffi["']/m.test(source), `${file} must not statically import koffi (issue #313)`);
		assert.ok(!/^\s*import\s+.*\sfrom\s+["']koffi["']/m.test(source), `${file} must not statically import from koffi at all (issue #313)`);
	}
});

test("CuaWin32 loads koffi only through the guarded runtime loader", () => {
	const source = readFileSync("src/main/cua/CuaWin32.ts", "utf8");
	// 非 win32 必须连 require 都不发起（koffiStub 直返），win32 失败走 catch 降级。
	assert.ok(/if\s*\(\s*!isWindows\s*\)\s*return\s+koffiStub/.test(source), "non-Windows must return koffiStub before any koffi require");
	assert.ok(/requireKoffi\(\)[\s\S]*?catch/.test(source), "requireKoffi() must be wrapped in try/catch");
});

test("CuaWin32 loads and degrades gracefully when the koffi native module is missing", () => {
	const CuaWin32 = loadTsCommonJs("src/main/cua/CuaWin32.ts", {
		stubs: {
			"./koffiRuntime": {
				requireKoffi: () => {
					throw new Error("Cannot find the native Koffi module; did you bundle it correctly?");
				},
			},
		},
	});

	// 模块求值成功（启动不再崩）；不触达原生层的纯计算函数仍可用。
	const inputs = CuaWin32.buildUnicodeInputs("A");
	assert.strictEqual(inputs.length, 2);

	// 真正触达原生绑定的调用抛「带原因」的错误：win32 上是 koffi 加载失败原因，
	// 其它平台是平台说明——两种都是调用期错误，而不是启动期崩溃。
	assert.throws(() => CuaWin32.enumerateWindows(), /koffi native module failed to load|only available on Windows/);
});

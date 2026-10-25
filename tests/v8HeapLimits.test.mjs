import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// v8HeapLimits：V8 老生代堆上限的分层策略（2026-08 #213）。
//
// 回归背景：原先只有一个全局 `--js-flags=--max-old-space-size=384`，Chromium 会把它
// 透传到每个渲染进程，会话窗口的 JS 堆被钉在 384MB，极端会话一次挂载上千条消息就
// V8 OOM（EXC_BREAKPOINT / exitCode 5），用户看到「窗口莫名重载」。
//
// 契约：主进程保留 384MB（RSS 卫生），渲染进程必须通过 additionalArguments 抬到更大档位。
// 这里锁死两个数值与字符串格式，防止有人「顺手统一」回单一全局开关。

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: () => ({}),
			// 默认档位读 process.env 里的诊断覆盖变量，沙箱里给出真实 process
			process,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const { MAIN_MAX_OLD_SPACE_MB, RENDERER_MAX_OLD_SPACE_MB, mainProcessJsFlags, rendererHeapAdditionalArguments, mainProcessHeapMb, rendererProcessHeapMb, resolveHeapOverrideMb } = compile("src/main/v8HeapLimits.ts");

test("渲染进程档位必须显著大于主进程档位（否则 #213 会复发）", () => {
	assert.ok(RENDERER_MAX_OLD_SPACE_MB > MAIN_MAX_OLD_SPACE_MB);
	assert.ok(RENDERER_MAX_OLD_SPACE_MB >= 1024, "渲染档位至少 1GB 才有兜底意义");
});

test("主进程参数是 appendSwitch 用的裸 flags 字符串", () => {
	assert.equal(mainProcessJsFlags(), `--max-old-space-size=${MAIN_MAX_OLD_SPACE_MB}`);
	assert.ok(!mainProcessJsFlags().startsWith("--js-flags="), "appendSwitch('js-flags', ...) 只接受值本身");
});

test("渲染进程参数带 --js-flags= 前缀，用于 webPreferences.additionalArguments", () => {
	const args = rendererHeapAdditionalArguments();
	assert.equal(args.length, 1);
	assert.equal(args[0], `--js-flags=--max-old-space-size=${RENDERER_MAX_OLD_SPACE_MB}`);
	assert.ok(args[0].includes(String(RENDERER_MAX_OLD_SPACE_MB)));
	assert.ok(!args[0].includes(`=${MAIN_MAX_OLD_SPACE_MB}`), "渲染进程不应继承主进程档位");
});

test("未设诊断变量时档位取常量默认值（进程 env 不含覆盖变量）", () => {
	assert.equal(mainProcessHeapMb({}), MAIN_MAX_OLD_SPACE_MB);
	assert.equal(rendererProcessHeapMb({}), RENDERER_MAX_OLD_SPACE_MB);
});

test("诊断变量可临时抬档（现场复现 OOM 用），非法值回落默认", () => {
	assert.equal(mainProcessHeapMb({ PIDECK_MAIN_HEAP_MB: "768" }), 768);
	assert.equal(mainProcessJsFlags({ PIDECK_MAIN_HEAP_MB: "768" }), "--max-old-space-size=768");
	assert.equal(rendererHeapAdditionalArguments({ PIDECK_RENDERER_HEAP_MB: "3072" })[0], "--js-flags=--max-old-space-size=3072");
	// 非数字 / 空值 / 缺失 → 默认档位，避免一个手滑的 env 把兜底搞没
	assert.equal(mainProcessHeapMb({ PIDECK_MAIN_HEAP_MB: "abc" }), MAIN_MAX_OLD_SPACE_MB);
	assert.equal(mainProcessHeapMb({ PIDECK_MAIN_HEAP_MB: "  " }), MAIN_MAX_OLD_SPACE_MB);
	assert.equal(rendererProcessHeapMb({ PIDECK_RENDERER_HEAP_MB: "NaN" }), RENDERER_MAX_OLD_SPACE_MB);
});

test("越界的诊断值夹到边界：主进程不低于 256MB、渲染不低于 1GB（低于即 #213 危险区）", () => {
	assert.equal(mainProcessHeapMb({ PIDECK_MAIN_HEAP_MB: "64" }), 256);
	assert.equal(mainProcessHeapMb({ PIDECK_MAIN_HEAP_MB: "999999" }), 4096);
	assert.equal(rendererProcessHeapMb({ PIDECK_RENDERER_HEAP_MB: "128" }), 1024);
	assert.equal(rendererProcessHeapMb({ PIDECK_RENDERER_HEAP_MB: "999999" }), 8192);
	assert.equal(resolveHeapOverrideMb({ X: "1.6" }, "X", 384, { min: 0, max: 4096 }), 2);
});

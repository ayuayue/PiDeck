import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 架构错包提示（2026-10 用户反馈回归防护）：M1 Pro 用户装了无后缀的 x64 dmg，
 * Rosetta 转译导致严重卡顿。防护分两层，本测试各覆盖一层：
 * ① 打包命名：package.json 的 mac artifactName 必须显式含 ${arch}（x64 产物不再无后缀）；
 * ② 运行时检测：runningUnderARM64Translation 判定 → 提示换装 arm64 包（可永久关闭）。
 */

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

// 纯逻辑模块只 import 类型（编译期擦除），无需解析运行时依赖
function loadModule() {
	const sandbox = { exports: {} };
	vm.runInNewContext(transpile("src/renderer/src/utils/archMismatchNotice.ts"), sandbox, {
		filename: "archMismatchNotice.ts",
	});
	return sandbox.exports;
}

test("shouldShowArchMismatchNotice: darwin x64-under-Rosetta and not dismissed → true", () => {
	const { shouldShowArchMismatchNotice } = loadModule();
	assert.equal(shouldShowArchMismatchNotice({ platform: "darwin", runningUnderArm64Translation: true }, false), true);
});

test("shouldShowArchMismatchNotice: dismissed flag wins even under Rosetta", () => {
	const { shouldShowArchMismatchNotice } = loadModule();
	assert.equal(shouldShowArchMismatchNotice({ platform: "darwin", runningUnderArm64Translation: true }, true), false);
});

test("shouldShowArchMismatchNotice: native arm64 mac / linux never prompt", () => {
	const { shouldShowArchMismatchNotice } = loadModule();
	assert.equal(shouldShowArchMismatchNotice({ platform: "darwin", runningUnderArm64Translation: false }, false), false);
	assert.equal(shouldShowArchMismatchNotice({ platform: "linux", runningUnderArm64Translation: false }, false), false);
	assert.equal(shouldShowArchMismatchNotice({ platform: "linux", runningUnderArm64Translation: true }, false), false);
});

test("shouldShowArchMismatchNotice: Windows ARM emulation does not prompt (no win arm64 build to offer)", () => {
	const { shouldShowArchMismatchNotice } = loadModule();
	// Windows 也只有 x64 发行物：runningUnderARM64Translation=true 同样不该提示
	assert.equal(shouldShowArchMismatchNotice({ platform: "win32", runningUnderArm64Translation: true }, false), false);
});

test("buildLatestReleaseUrl tolerates trailing slashes", () => {
	const { buildLatestReleaseUrl } = loadModule();
	assert.equal(buildLatestReleaseUrl("https://github.com/ayuayue/PiDeck/releases"), "https://github.com/ayuayue/PiDeck/releases/latest");
	assert.equal(buildLatestReleaseUrl("https://github.com/ayuayue/PiDeck/releases/"), "https://github.com/ayuayue/PiDeck/releases/latest");
});

// 行为侧（React hook + 装配）用源码断言，模式与 agentLoadNotice 契约测试一致
test("useArchMismatchNotice is wired through App and shows a warning toast with both actions", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const hook = readFileSync("src/renderer/src/hooks/useArchMismatchNotice.ts", "utf8");
	assert.match(app, /useArchMismatchNotice\(\)/);
	// 提示为 warning 档（黄三角图标），与 Agent 数量告警同档
	assert.match(hook, /15000,\s*"warning"/);
	assert.match(hook, /t\("app\.archMismatchTitle"\)/);
	assert.match(hook, /t\("app\.archMismatchBody"\)/);
	// 主按钮打开发布页（openExternal 第二参 forceSystem=true 走系统浏览器）、次按钮永久关闭
	assert.match(hook, /buildLatestReleaseUrl\(info\.releasesUrl\)/);
	assert.match(hook, /openExternal\(latestUrl,\s*true\)/);
	assert.match(hook, /localStorage\.setItem\(ARCH_MISMATCH_DISMISSED_KEY,\s*"1"\)/);
	// 判定必须走纯函数（防止 hook 内散落条件判断绕过单测覆盖的语义）
	assert.match(hook, /shouldShowArchMismatchNotice\(/);
	// 检测链路失败静默：提示功能不能影响启动（catch 内只留注释）
	assert.match(hook, /\} catch \{[\s\S]{0,120}?\}/);
});

test("IPC 三处同步：通道常量 + main handler + preload 白名单", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const main = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(shared, /archStatus:\s*"system:arch-status"/);
	assert.match(main, /ipcMain\.handle\(ipcChannels\.archStatus/);
	assert.match(main, /app\.runningUnderARM64Translation === true/);
	assert.match(preload, /getArchStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.archStatus\)/);
});

test("打包命名：mac artifactName 显式含 ${arch}（x64 产物不再无后缀）", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.build.mac.artifactName, "${productName}-${version}-${arch}.${ext}");
});

test("i18n copy covers zh-CN and en-US with arm64 guidance", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"app\.archMismatchTitle": "当前运行的是 Intel 版包/);
	assert.match(zh, /"app\.archMismatchBody": "检测到你的 Mac 是 Apple Silicon/);
	assert.match(zh, /"app\.archMismatchBody": [^\n]*arm64/);
	// en 文案值可能被格式化到下一行（引号也可能改为单引号）：容忍换行
	assert.match(en, /"app\.archMismatchTitle":[\s\S]{0,8}["']Intel build detected/);
	assert.match(en, /"app\.archMismatchBody":[\s\S]{0,8}["']Your Mac has Apple Silicon/);
	// 两个按钮双语同步
	assert.match(zh, /"app\.archMismatchAction": "前往下载 arm64 版"/);
	assert.match(zh, /"app\.archMismatchDismiss": "不再提示"/);
	assert.match(en, /"app\.archMismatchAction": "Get the arm64 build"/);
	assert.match(en, /"app\.archMismatchDismiss": "Don't remind again"/);
});

/**
 * Linux 宠物窗 smoke 测试（CI：ubuntu + xvfb）。
 *
 * 在真实 Electron 主进程里，用 TypeScript transpile + vm 加载 src/main/pet/PetWindow.ts，
 * 然后真实创建 BrowserWindow（加载 out/renderer/pet.html），验证：
 * 1. detectPetWindowCaps() 在真实 Linux 图形环境输出可解析的 caps；
 * 2. PetWindow.create() 能创建窗口并加载渲染层；
 * 3. 窗口能正常销毁，退出码 0。
 *
 * 运行方式（需先 npm run build）：
 *   xvfb-run -a npx electron scripts/pet-smoke.cjs
 */
const { app } = require("electron");
const ts = require("typescript");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fail = (message) => {
	console.error(`PET_SMOKE_FAIL ${message}`);
	app.exit(1);
};

/**
 * 加载纯常量/纯函数的 .ts 模块（Electron 内置 Node 不支持 type stripping，
 * 普通 node 24 可以；与 PetWindow 同样用 transpile+vm）。沙箱内 require 一律
 * 抛错：进到这里的前提就是模块无运行时依赖。
 */
const loadPureTsModule = (sourcePath) => {
	const src = fs.readFileSync(sourcePath, "utf8");
	const { outputText } = ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const mod = { exports: {} };
	vm.runInNewContext(
		outputText,
		{
			module: mod,
			exports: mod.exports,
			// 纯模块的函数默认参数可能取 process.env（如 v8HeapLimits），透传真实 process
			process,
			require: (id) => {
				throw new Error(`pure module ${path.basename(sourcePath)} must not require(${id})`);
			},
		},
		{ filename: path.basename(sourcePath) },
	);
	return mod.exports;
};

app.whenReady().then(async () => {
	try {
		// ── 加载 PetWindow.ts（与 tests/petWindowCaps.test.mjs 相同手法，但 electron 用真模块）──
		const source = fs.readFileSync(path.join(__dirname, "../src/main/pet/PetWindow.ts"), "utf8");
		const { outputText } = ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		});
		const moduleRef = { exports: {} };
		const sandbox = {
			module: moduleRef,
			exports: moduleRef.exports,
			__dirname: path.join(__dirname, "../out/main"),
			process,
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			require: (id) => {
				if (id === "electron") return require("electron");
				if (id.startsWith("node:")) return require(id.slice(5));
				if (id === "@electron-toolkit/utils") return { is: { dev: false } };
				if (id === "../preloadPath") return { preparePreloadPath: async (sourcePath) => sourcePath };
				if (id === "../settings/SettingsStore") {
					return { readElectronChromiumSandboxPreference: () => false };
				}
				// PetWindow 新增依赖（shared 纯几何常量；v8HeapLimits 纯常量/纯函数，
				// #213 渲染堆档位——两者均无运行时依赖，用 loadPureTsModule 加载真实源码，
				// stub 会与实现漂移）
				if (id === "../../shared/petNotificationLayout") {
					return loadPureTsModule(path.join(__dirname, "../src/shared/petNotificationLayout.ts"));
				}
				if (id === "../v8HeapLimits") {
					return loadPureTsModule(path.join(__dirname, "../src/main/v8HeapLimits.ts"));
				}
				// 渲染层噪音判定/聚合（#376 让 PetWindow 的 console-message 与主窗口共用同一口径）：
				// 纯函数 + type-only import，无运行时依赖，同样加载真实源码而不是 stub。
				if (id === "../../shared/rendererNoise") {
					return loadPureTsModule(path.join(__dirname, "../src/shared/rendererNoise.ts"));
				}
				if (id === "../logging/sharedLogger") return { getAppLogger: () => undefined };
				if (id === "./petSpriteProtocol") return { PET_WINDOW_PARTITION: "persist:pet" };
				throw new Error(`pet-smoke: unexpected require(${id})`);
			},
		};
		vm.runInNewContext(outputText, sandbox, { filename: "PetWindow.ts" });
		const { PetWindow, detectPetWindowCaps } = moduleRef.exports;

		const caps = detectPetWindowCaps();
		console.log(`PET_CAPS ${JSON.stringify(caps)}`);
		if (typeof caps.transparent !== "boolean" || typeof caps.freePosition !== "boolean") {
			return fail(`unexpected caps shape: ${JSON.stringify(caps)}`);
		}

		const petWindow = new PetWindow();
		await petWindow.create(1);
		if (!petWindow.exists) return fail("window was not created");
		console.log("PET_WINDOW_EXISTS true");

		petWindow.destroy();
		console.log("PET_SMOKE_OK");
		app.exit(0);
	} catch (err) {
		return fail(`${err && err.stack ? err.stack : err}`);
	}
});

// 兜底：加载失败也要退出，避免 CI 挂起
setTimeout(() => fail("timed out after 30s"), 30_000);

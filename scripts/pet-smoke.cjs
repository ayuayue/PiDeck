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
				// PetWindow 新增依赖（shared 纯几何常量，node 24 type stripping 直接加载；
				// 后两者仅取常量/无副作用，stub 避免拖入 electron 协议注册与日志实现）
				if (id === "../../shared/petNotificationLayout") {
				// Electron 内置 Node 不支持 .ts type stripping（普通 node 24 可以），
				// 与 PetWindow 同样用 transpile+vm 加载纯常量模块（仅 type-only import，无运行时依赖）
				const layoutSrc = fs.readFileSync(path.join(__dirname, "../src/shared/petNotificationLayout.ts"), "utf8");
				const { outputText: layoutOut } = ts.transpileModule(layoutSrc, {
					compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
				});
				const layoutModule = { exports: {} };
				vm.runInNewContext(layoutOut, { module: layoutModule, exports: layoutModule.exports, require: (i) => { throw new Error("unexpected layout require " + i); } }, { filename: "petNotificationLayout.ts" });
				return layoutModule.exports;
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

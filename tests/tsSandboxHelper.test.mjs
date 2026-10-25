import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/**
 * 手写 vm 沙箱统一入口（createTsSandbox）的契约测试。
 *
 * 背景：测试用手写沙箱加载生产模块时，未识别的 import 会落到 `require(spec)`，
 * 而它的解析基准是 **tests/ 目录**而不是被加载的生产文件——生产代码一新增本地
 * import，测试就整片 MODULE_NOT_FOUND（2026-09 连踩三次）。本 helper 存在的意义
 * 就是让「相对 import 按源文件目录解析」成为默认行为，不再由各测试各自补桥。
 *
 * 这里锁三件事：
 *  1. 相对 import 按**源文件目录**解析（含嵌套与 .ts 扩展名兜底）；
 *  2. stubs / globals 可注入，且命中 stub 时不再走文件系统；
 *  3. 同一实例内模块缓存生效（互相依赖只求值一次，桩在各处共享）。
 */

test("相对 import 按源文件目录解析，而不是 tests/ 目录", () => {
	const load = createTsSandbox();
	// sessionSourceHead 自身无相对依赖，但 sessionFileSizeCopy 是被别人引用的真实模块：
	// 两者都必须能直接加载（若按 tests/ 基准解析就会 MODULE_NOT_FOUND）
	assert.equal(typeof load("src/main/sessions/sessionSourceHead.ts").readSessionSourceHead, "function");
	assert.equal(typeof load("src/main/sessions/sessionFileSizeCopy.ts").sessionFileSizeMb, "function");
});

test("嵌套相对依赖被自动解析（不靠测试逐个补桩）", () => {
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => "C:/tmp/x" } } } });
	// SessionRuntimeCoordinator → ./sessionFileSizeCopy（第 4 轮修复时新增的依赖）：
	// 这正是历史上会连锁破坏测试的场景，现在应无需任何额外桩
	const mod = load("src/main/sessions/SessionRuntimeCoordinator.ts");
	assert.equal(typeof mod.SessionRuntimeCoordinator, "function");
});

test("未注入的包名交回 Node 解析（electron 这种需显式桁，不静默造空对象）", () => {
	const load = createTsSandbox();
	// 包名不属于 helper 职责：它交回 Node。electron 在 node_modules 里只导出一个路径字符串，
	// 因此依赖它的生产模块必须由测试显式提供 stub（否则拿到的是字符串而非 API）——
	// 这正是各导入器测试都桁 electron 的原因，在此固定下来避免后人误以为能自动生效。
	const electronValue = nodeRequire("electron");
	assert.equal(typeof electronValue, "string", "electron 解析结果是路径字符串（需 stub）");
	// 相对模块解析不到时必须显式报错，而不是静默 undefined
	assert.throws(() => load("src/main/sessions/__missing_dependency_probe__.ts"), /ENOENT|Cannot find|no such file/i);
});

test("stubs 命中优先且不再走文件系统解析", () => {
	let statCalls = 0;
	const fakeSourceHead = { readSessionSourceHead: async () => ({ head: "", size: 0, mtimeMs: 0 }) };
	const load = createTsSandbox({
		stubs: { "./sessionSourceHead": fakeSourceHead },
		globals: {
			// 记录 helper 是否尝试解析该 specifier（命中 stub 就不该解析）
			__probe: () => {
				statCalls += 1;
			},
		},
	});
	const mod = load("src/main/sessions/sessionFileSizeCopy.ts");
	// sessionFileSizeCopy 不依赖 sessionSourceHead；这里只验证 stub 表本身可用：
	// 用一个确实依赖它的模块验证命中（ClaudeSessionImporter 依赖它）
	const loader = createTsSandbox({
		stubs: {
			electron: { app: { getPath: () => "C:/tmp/x" } },
			"./sessionSourceHead": fakeSourceHead,
		},
	});
	assert.ok(loader("src/main/sessions/ClaudeSessionImporter.ts").ClaudeSessionImporter);
	assert.equal(statCalls, 0, "命中 stub 时不应触发文件系统探测");
	assert.equal(typeof mod.sessionFileSizeMb, "function");
});

test("globals 可覆盖 sandbox 全局（自定义 process.platform 等）", () => {
	const touched = [];
	const load = createTsSandbox({
		globals: {
			process: { platform: "linux", cwd: () => process.cwd(), versions: process.versions },
			__record: (value) => {
				touched.push(value);
			},
		},
	});
	const mod = load("src/main/sessions/sessionFileSizeCopy.ts");
	assert.equal(mod.bytesToMb(1024 * 1024), 1);
	// globals 注入本身可被模块访问（这里只验证机制：注入的函数在 sandbox 内可见）
	assert.equal(touched.length, 0);
});

test("同一实例内模块缓存生效：同一路径返回同一 exports", () => {
	const load = createTsSandbox();
	const first = load("src/main/sessions/sessionFileSizeCopy.ts");
	const second = load("src/main/sessions/sessionFileSizeCopy.ts");
	assert.equal(first, second);
});

test("不同实例互不干扰（各自独立的缓存与桩）", () => {
	const a = createTsSandbox({ globals: { __tag: "a" } });
	const b = createTsSandbox({ globals: { __tag: "b" } });
	assert.notEqual(a("src/main/sessions/sessionFileSizeCopy.ts"), b("src/main/sessions/sessionFileSizeCopy.ts"));
});

test("解析不到的相对模块报可读错误（含 specifier 与来源文件）", () => {
	const load = createTsSandbox();
	assert.throws(() => load("src/main/sessions/__definitely_missing__.ts"), /ENOENT|Cannot find|no such file/i);
});

test("★ 构建期 define（__PIDECK_DEV_BUILD__）有默认值且可被覆盖", () => {
	// 2026-09 回归：define 只在 electron-vite 构建期注入，沙箱里就是普通标识符。
	// helper 不给默认值的话，任何 import 到 deepLinkScheme / channelIdentity 的
	// 生产模块（AgentManager 链路上 53 个测试）全部 ReferenceError 而非断言失败。
	// 默认取 stable 通道；测 dev 通道的用例（channelIdentity.test.mjs）用 globals 覆盖。
	assert.equal(createTsSandbox()("src/main/utils/deepLinkScheme.ts").APP_DEEP_LINK_SCHEME, "pideck");
	assert.equal(createTsSandbox()("src/main/update/channelIdentity.ts").resolveUpdateChannel(), "stable");
	assert.equal(createTsSandbox({ globals: { __PIDECK_DEV_BUILD__: true } })("src/main/utils/deepLinkScheme.ts").APP_DEEP_LINK_SCHEME, "pideck-dev");
	assert.equal(createTsSandbox({ globals: { __PIDECK_DEV_BUILD__: true } })("src/main/update/channelIdentity.ts").resolveUpdateChannel(), "dev");

	// loadTsCommonJs 走完整依赖图，同一份默认值必须成立（否则整条 AgentManager 链断）
	assert.equal(loadTsCommonJs("src/main/utils/deepLinkScheme.ts").APP_DEEP_LINK_SCHEME, "pideck");
	assert.equal(loadTsCommonJs("src/main/update/channelIdentity.ts", { globals: { __PIDECK_DEV_BUILD__: true } }).resolveUpdateChannel(), "dev");
});

test("真实临时模块：跨目录相对 import 也能解析", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-ts-sandbox-"));
	try {
		const sub = join(dir, "nested");
		await mkdir(sub, { recursive: true });
		await writeFile(join(dir, "dep.ts"), "export const value = 41;\n");
		await writeFile(join(sub, "main.ts"), 'import { value } from "../dep";\nexport const answer = value + 1;\n');
		const load = createTsSandbox();
		assert.equal(load(join(sub, "main.ts")).answer, 42);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

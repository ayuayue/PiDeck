/**
 * dshRuntimeLockClosure 纯函数单测（scripts/dshRuntimeLockClosure.mjs）。
 *
 * 覆盖交叉打包的关键判定逻辑，全部用 fixture lock 数据，不依赖真实网络/npm：
 * - lock key 解析（含嵌套 node_modules 与 scoped 包名）
 * - 闭包遍历（种子 → dependencies/optionalDependencies，不跟 peer/dev）
 * - 同名多版本：按声明范围选择嵌套条目（node-pty 1.1.0/1.2.0-beta.15 场景回归）
 * - file: 链接条目解引用
 * - 平台门控包判定（os/cpu/libc 字段 → optionalDependencies）
 * - 目标平台三元组归一化（libc 缺省与非法值）
 */
import test from "node:test";
import assert from "node:assert/strict";

import { collectLockClosure, isActivePackageEntry, isPlatformGatedEntry, npmPlatformArgs, parseLockKey, normalizeTarget, pinnedDependenciesFromClosure, resolveLinkEntry, resolveLockPackageKey } from "../scripts/dshRuntimeLockClosure.mjs";

/**
 * 最小可用的 lock packages fixture：
 * - 顶层 @deepseek-ai/dsh 与 dsh-subprocess-local（要求嵌套 node-pty 精确版本）
 * - 顶层 node-pty@1.1.0（项目 production 依赖占位，不满足 dsh-subprocess-local 的范围）
 * - 平台门控包（sharp/koffi 形态）
 * - file: 链接条目（dsh-tool-pwsh-persistent 形态）
 */
function buildFixtureLock() {
	return {
		"node_modules/@deepseek-ai/dsh": {
			version: "0.1.5-rc.1",
			dependencies: { "@deepseek-ai/dsh-base": "^0.1.5-rc.1", "@deepseek-ai/dsh-subprocess-local": "^0.1.5-rc.1" },
		},
		"node_modules/@deepseek-ai/dsh-base": { version: "0.1.5-rc.1" },
		"node_modules/@deepseek-ai/dsh-subprocess-local": {
			version: "0.1.5-rc.1",
			// 精确版本要求：顶层 1.1.0 不满足，必须解析到嵌套条目（回归锚点）
			dependencies: { koffi: "^3.1.0", "node-pty": "1.2.0-beta.15" },
		},
		"node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty": { version: "1.2.0-beta.15" },
		"node_modules/@deepseek-ai/dsh-attachment-local": {
			version: "0.1.5-rc.1",
			optionalDependencies: { sharp: "^0.35.3" },
		},
		"node_modules/@deepseek-ai/dsh-attachment-local/node_modules/sharp": {
			version: "0.35.4",
			optionalDependencies: { "@img/sharp-win32-x64": "0.35.4", "@img/sharp-linux-x64": "0.35.4" },
		},
		// 平台门控包：os/cpu/libc 字段决定 optional 语义
		"node_modules/@img/sharp-win32-x64": { version: "0.35.4", optional: true, os: ["win32"], cpu: ["x64"] },
		"node_modules/@img/sharp-linux-x64": { version: "0.35.4", optional: true, os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
		"node_modules/koffi": { version: "3.2.1", optionalDependencies: { "@koromix/koffi-win32-x64": "3.2.1" } },
		"node_modules/@koromix/koffi-win32-x64": { version: "3.2.1", optional: true, os: ["win32"], cpu: ["x64"] },
		// 顶层 node-pty：项目 production 依赖占位
		"node_modules/node-pty": { version: "1.1.0" },
		// file: 链接条目（link 占位 + 真实条目）
		"node_modules/dsh-tool-pwsh-persistent": { link: true, resolved: "packages/dsh-tool-pwsh-persistent" },
		"packages/dsh-tool-pwsh-persistent": {
			version: "0.1.2",
			dependencies: { "node-pty": "^1.1.0" },
		},
	};
}

const SEEDS = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-attachment-local", "dsh-tool-pwsh-persistent"];

test("parseLockKey：非 node_modules 条目返回 null", () => {
	assert.equal(parseLockKey(""), null);
	assert.equal(parseLockKey("packages/dsh-tool-pwsh-persistent"), null);
	assert.deepEqual(parseLockKey("node_modules/@scope/pkg"), ["node_modules", "@scope", "pkg"]);
});

test("isActivePackageEntry：link 条目不算活包", () => {
	assert.equal(isActivePackageEntry({ version: "1.0.0" }), true);
	assert.equal(isActivePackageEntry({ link: true, resolved: "packages/x" }), false);
	assert.equal(isActivePackageEntry(null), false);
});

test("resolveLockPackageKey：顶层依赖命中顶层条目", () => {
	const lock = buildFixtureLock();
	assert.equal(resolveLockPackageKey("node_modules/@deepseek-ai/dsh", "@deepseek-ai/dsh-base", lock, "^0.1.5-rc.1"), "node_modules/@deepseek-ai/dsh-base");
});

test("resolveLockPackageKey：同名多版本按声明范围选嵌套条目（node-pty 回归锚点）", () => {
	const lock = buildFixtureLock();
	// dsh-subprocess-local 要求 node-pty@1.2.0-beta.15 精确版本，顶层 1.1.0 不满足
	assert.equal(resolveLockPackageKey("node_modules/@deepseek-ai/dsh-subprocess-local", "node-pty", lock, "1.2.0-beta.15"), "node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty");
	// file: 包要求 ^1.1.0，顶层满足
	assert.equal(resolveLockPackageKey("node_modules/dsh-tool-pwsh-persistent", "node-pty", lock, "^1.1.0"), "node_modules/node-pty");
});

test("resolveLockPackageKey：候选不存在返回 null（peer 由宿主提供）", () => {
	const lock = buildFixtureLock();
	assert.equal(resolveLockPackageKey("node_modules/@deepseek-ai/dsh", "missing-pkg", lock, "^1.0.0"), null);
});

test("resolveLinkEntry：file: 链接解引用到真实条目", () => {
	const lock = buildFixtureLock();
	const entry = lock["node_modules/dsh-tool-pwsh-persistent"];
	const resolved = resolveLinkEntry(lock, "node_modules/dsh-tool-pwsh-persistent", entry);
	assert.equal(resolved.key, "packages/dsh-tool-pwsh-persistent");
	assert.equal(resolved.entry.version, "0.1.2");
});

test("collectLockClosure：遍历 dependencies+optionalDependencies，含嵌套与 file: 解引用", () => {
	const lock = buildFixtureLock();
	const { keys, versions } = collectLockClosure(lock, SEEDS);
	const names = new Set(versions.keys());
	for (const expected of ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-subprocess-local", "@deepseek-ai/dsh-attachment-local", "koffi", "node-pty"]) {
		assert.ok(names.has(expected), `闭包缺少 ${expected}`);
	}
	// file: 包被解引用进闭包
	assert.ok(keys.includes("packages/dsh-tool-pwsh-persistent"), "file: 真实条目应进闭包 keys");
});

test("collectLockClosure：同名多版本记入 multiVersion（node-pty 双版本）", () => {
	const lock = buildFixtureLock();
	const { versions, multiVersion } = collectLockClosure(lock, SEEDS);
	// versions 记顶层版本：闭包遍历中最先命中的是顶层 1.1.0（file: 包的 ^1.1.0）；
	// 嵌套的 1.2.0-beta.15 由 multiVersion 完整暴露，供临时 package.json 生成侧诊断。
	assert.equal(versions.get("node-pty"), "1.1.0");
	assert.deepEqual([...(multiVersion.get("node-pty") ?? [])].sort(), ["1.1.0", "1.2.0-beta.15"]);
});

test("collectLockClosure：不跟随 peerDependencies", () => {
	const lock = {
		"node_modules/a": { version: "1.0.0", peerDependencies: { "peer-only": "^1.0.0" } },
		"node_modules/peer-only": { version: "1.0.0" },
	};
	const { versions } = collectLockClosure(lock, ["a"]);
	assert.equal(versions.has("peer-only"), false);
});

test("collectLockClosure：种子缺失不抛错（由调用方报错）", () => {
	const lock = buildFixtureLock();
	const { versions } = collectLockClosure(lock, ["not-in-lock"]);
	assert.equal(versions.size, 0);
});

test("pinnedDependenciesFromClosure：输出精确版本表", () => {
	const deps = pinnedDependenciesFromClosure(
		new Map([
			["b", "2.0.0"],
			["a", "1.0.0"],
		]),
	);
	assert.deepEqual(deps, { a: "1.0.0", b: "2.0.0" });
});

test("isPlatformGatedEntry：os/cpu/libc 任一字段即平台门控", () => {
	assert.equal(isPlatformGatedEntry({ version: "1.0.0", os: ["win32"] }), true);
	assert.equal(isPlatformGatedEntry({ version: "1.0.0", cpu: ["arm64"] }), true);
	assert.equal(isPlatformGatedEntry({ version: "1.0.0", libc: ["glibc"] }), true);
	assert.equal(isPlatformGatedEntry({ version: "1.0.0", optional: true }), true);
	// 无平台字段的主包不是门控包（如 cordis、dsh-base）
	assert.equal(isPlatformGatedEntry({ version: "1.0.0" }), false);
	assert.equal(isPlatformGatedEntry(null), false);
});

test("normalizeTarget：linux 缺省 libc=glibc（防 libc 静默缺包）", () => {
	assert.deepEqual(normalizeTarget({ os: "linux", arch: "x64" }), { os: "linux", arch: "x64", libc: "glibc" });
	// 显式 musl 保留（musl 发行版变体）
	assert.deepEqual(normalizeTarget({ os: "linux", arch: "arm64", libc: "musl" }), { os: "linux", arch: "arm64", libc: "musl" });
	// darwin/win32 不带 libc
	assert.deepEqual(normalizeTarget({ os: "darwin", arch: "arm64" }), { os: "darwin", arch: "arm64", libc: undefined });
	assert.deepEqual(normalizeTarget({ os: "win32", arch: "x64" }), { os: "win32", arch: "x64", libc: undefined });
});

test("normalizeTarget：非法值与非 linux 的 libc 报错", () => {
	assert.ok(normalizeTarget({ os: "sunos", arch: "x64" }).error);
	assert.ok(normalizeTarget({ os: "win32", arch: "ia32" }).error);
	assert.ok(normalizeTarget({ os: "win32", arch: "x64", libc: "glibc" }).error);
});

test("npmPlatformArgs：输出 --os/--cpu/--ignore-scripts，linux 追加 --libc", () => {
	assert.deepEqual(npmPlatformArgs({ os: "win32", arch: "x64", libc: undefined }), ["--os", "win32", "--cpu", "x64", "--ignore-scripts", "--omit=dev"]);
	assert.deepEqual(npmPlatformArgs({ os: "linux", arch: "x64", libc: "glibc" }), ["--os", "linux", "--cpu", "x64", "--ignore-scripts", "--omit=dev", "--libc", "glibc"]);
});

import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DSH_RUNNER_NODE_MAJOR, isDshRunnerNodeCompatible, pathLooksLikeOtherNodeMajor, nodePathCandidates, versionManagerNodeCandidates, parseNodeVersion, resolveConfiguredNodePath, detectDshRunnerNode, detectSystemNode, resolveDshRunnerNodePath, isNodeShimPath, isRunnableRunnerNode } =
	loadTsCommonJs("src/main/dsh/dshRunnerNode.ts");

/** 把一个真实 node 二进制放到任意路径（硬链接优先，跨卷退回复制）。 */
async function plantNodeBinary(target) {
	await mkdir(join(target, ".."), { recursive: true });
	try {
		await link(process.execPath, target);
	} catch {
		await copyFile(process.execPath, target);
	}
	return target;
}

test("Windows 候选路径含官方安装目录", () => {
	const candidates = nodePathCandidates("win32", { ProgramFiles: "C:\\Program Files" });
	assert.equal(candidates[0], "C:\\Program Files\\nodejs\\node.exe");
});

test("Windows 用户级安装位置随 LOCALAPPDATA 拼出", () => {
	const candidates = nodePathCandidates("win32", {
		ProgramFiles: "C:\\Program Files",
		LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
	});
	assert.ok(candidates.includes("C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs\\node.exe"));
});

test("无 LOCALAPPDATA 时不产生 undefined 路径", () => {
	const candidates = nodePathCandidates("win32", { ProgramFiles: "C:\\Program Files" });
	assert.ok(!candidates.some((p) => p.includes("undefined")));
});

test("macOS / Linux 候选覆盖 Homebrew 与系统路径", () => {
	assert.ok(nodePathCandidates("darwin").includes("/opt/homebrew/bin/node"));
	assert.equal(nodePathCandidates("linux")[0], "/usr/bin/node");
});

test("parseNodeVersion 剥 v 前缀", () => {
	assert.equal(parseNodeVersion("v24.13.0\n"), "24.13.0");
	assert.equal(parseNodeVersion("24.13.0"), "24.13.0");
});

test("两段版本号补齐为三段", () => {
	assert.equal(parseNodeVersion("v24.13"), "24.13.0");
});

test("ABI 兼容只认 Node 24", () => {
	assert.equal(DSH_RUNNER_NODE_MAJOR, 24);
	assert.equal(isDshRunnerNodeCompatible("24.13.0"), true);
	assert.equal(isDshRunnerNodeCompatible("22.12.0"), false);
	assert.equal(isDshRunnerNodeCompatible("25.0.0"), false);
	assert.equal(isDshRunnerNodeCompatible(""), false);
	assert.equal(pathLooksLikeOtherNodeMajor("C:\\\\nvm\\\\v22.12.0\\\\node.exe"), true);
	assert.equal(pathLooksLikeOtherNodeMajor("C:\\\\fnm\\\\node-versions\\\\v24.13.0\\\\installation\\\\node.exe"), false);
	assert.equal(pathLooksLikeOtherNodeMajor("C:\\\\Program Files\\\\nodejs\\\\node.exe"), false);
});

test("nvm-windows / fnm / mise 安装目录进入候选，不依赖 PATH", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-nvm-"));
	try {
		const nvmVer = join(root, "nvm", "v24.13.0");
		const fnmVer = join(root, "fnm", "node-versions", "v24.13.0", "installation");
		const miseVer = join(root, "mise", "installs", "node", "24.13.0");
		await mkdir(nvmVer, { recursive: true });
		await mkdir(fnmVer, { recursive: true });
		await mkdir(miseVer, { recursive: true });
		const env = {
			NVM_HOME: join(root, "nvm"),
			FNM_DIR: join(root, "fnm"),
			MISE_DATA_DIR: join(root, "mise"),
			USERPROFILE: join(root, "nouser"),
			HOME: join(root, "nouser"),
			LOCALAPPDATA: join(root, "local"),
			APPDATA: join(root, "roaming"),
		};
		const candidates = versionManagerNodeCandidates("win32", env);
		assert.ok(candidates.includes(join(nvmVer, "node.exe")));
		assert.ok(candidates.includes(join(fnmVer, "node.exe")));
		assert.ok(candidates.includes(join(miseVer, "node.exe")));
		assert.ok(nodePathCandidates("win32", { ProgramFiles: "C:\\Program Files", ...env }).includes(join(nvmVer, "node.exe")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("配置路径去空白；空串视为未配置", () => {
	assert.equal(resolveConfiguredNodePath("  C:\\nodejs\\node.exe  "), "C:\\nodejs\\node.exe");
	assert.equal(resolveConfiguredNodePath(""), "");
	assert.equal(resolveConfiguredNodePath(undefined), "");
	assert.equal(resolveConfiguredNodePath(null), "");
});

test("配置了不存在的路径时 source=not-found，不把脏路径当可执行文件", async () => {
	const info = await detectDshRunnerNode({
		configuredPath: "C:\\definitely-missing-pideck-node.exe",
		platform: "win32",
		env: { HOME: "C:\\pideck-no-home", USERPROFILE: "C:\\pideck-no-home" },
	});
	assert.equal(info.source, "not-found");
	assert.equal(info.compatible, false);
	assert.match(info.error ?? "", /无法执行配置的 Node 路径/);
});

test("配置了存在但不是 node 的文件时探测失败", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-node-"));
	try {
		const fake = join(root, "not-node.exe");
		await writeFile(fake, "nope");
		const info = await detectDshRunnerNode({
			configuredPath: fake,
			platform: "win32",
			env: { HOME: root, USERPROFILE: root },
		});
		assert.equal(info.source, "not-found");
		assert.equal(info.compatible, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveDshRunnerNodePath 非 Windows 不解析", async () => {
	assert.equal(await resolveDshRunnerNodePath({ platform: "linux" }), undefined);
});

// —— 版本管理器垫片回归（run_code 报 “managed process cleanup failed”）——
// mise/scoop/volta/chocolatey 的 shim 能跑 `node -v`，但会把 runner 的 IPC 管道
// 吞掉，宿主判 “Windows Job runner exited with exit code 0 before proving its
// managed range empty”，PTC run_code 整体失败。这里锁死“垫片不能当 runner”。

test("垫片路径识别：mise / scoop / volta / fnm / chocolatey / node_modules", () => {
	assert.equal(isNodeShimPath("C:\\Users\\t\\AppData\\Local\\mise\\shims\\node"), true);
	assert.equal(isNodeShimPath("C:\\Users\\t\\AppData\\Local\\mise\\shims\\node.exe"), true);
	assert.equal(isNodeShimPath("C:\\Users\\t\\scoop\\shims\\node.exe"), true);
	assert.equal(isNodeShimPath("C:\\Users\\t\\AppData\\Local\\Volta\\bin\\node.exe"), true);
	assert.equal(isNodeShimPath("C:\\Users\\t\\AppData\\Roaming\\fnm_multishells\\1_2\\node.exe"), true);
	assert.equal(isNodeShimPath("C:\\ProgramData\\chocolatey\\bin\\node.exe"), true);
	assert.equal(isNodeShimPath("C:\\Users\\t\\proj\\node_modules\\.bin\\node"), true);
	// Unix 分隔符同样归一后命中（mise/asdf 在 mac/linux 也是垫片）
	assert.equal(isNodeShimPath("/home/t/.local/share/mise/shims/node"), true);
	assert.equal(isNodeShimPath("/home/t/.asdf/shims/node"), true);
	// 真实二进制不受影响
	assert.equal(isNodeShimPath("C:\\Users\\t\\AppData\\Local\\mise\\installs\\node\\24.13.0\\node.exe"), false);
	assert.equal(isNodeShimPath("C:\\Program Files\\nodejs\\node.exe"), false);
	assert.equal(isNodeShimPath("C:\\Users\\t\\AppData\\Local\\Volta\\tools\\image\\node\\24.13.0\\node.exe"), false);
});

test("Windows 上无扩展名的 PATH 命中（bash 垫片）不可 spawn", () => {
	assert.equal(isRunnableRunnerNode("C:\\Users\\t\\AppData\\Local\\mise\\shims\\node", "win32"), false);
	assert.equal(isRunnableRunnerNode("C:\\Program Files\\nodejs\\node.exe", "win32"), true);
	assert.equal(isRunnableRunnerNode("", "win32"), false);
	assert.equal(isRunnableRunnerNode("/usr/bin/node", "linux"), true);
});

test("PATH 上只有垫片时标记 shimmed，绝不给出可用的 runner 路径", async (t) => {
	if (!isDshRunnerNodeCompatible(process.versions.node)) return t.skip(`CI node ${process.versions.node} 非 ${DSH_RUNNER_NODE_MAJOR}.x`);
	const root = await mkdtemp(join(tmpdir(), "pideck-shim-"));
	try {
		// 垫片本身指向真 node（版本 24）：能跑 -v，但仍不能当 runner。
		const shim = await plantNodeBinary(join(root, "mise", "shims", "node.exe"));
		const probe = await detectSystemNode({
			platform: "win32",
			env: { HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), MISE_DATA_DIR: join(root, "mise") },
			pathHits: [join(root, "mise", "shims", "node"), shim],
		});
		assert.equal(probe?.shimmed, true);
		assert.equal(probe?.source, "path");

		// env 指到垫片（生产里的 PIDECK_DSH_RUNNER_NODE 曾经就是这样）同样不兼容。
		const info = await detectDshRunnerNode({
			platform: "win32",
			env: { HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), MISE_DATA_DIR: join(root, "mise") },
			envPath: shim,
		});
		assert.equal(info.compatible, false);
		assert.match(info.error ?? "", /垫片/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("跳过 PATH 垫片，改用 mise 安装目录里的真 node", async (t) => {
	if (!isDshRunnerNodeCompatible(process.versions.node)) return t.skip(`CI node ${process.versions.node} 非 ${DSH_RUNNER_NODE_MAJOR}.x`);
	const root = await mkdtemp(join(tmpdir(), "pideck-shim-real-"));
	try {
		const shim = await plantNodeBinary(join(root, "mise", "shims", "node.exe"));
		const real = await plantNodeBinary(join(root, "mise", "installs", "node", process.versions.node, "node.exe"));
		const env = { HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), MISE_DATA_DIR: join(root, "mise") };
		const probe = await detectSystemNode({ platform: "win32", env, pathHits: [shim] });
		assert.equal(probe?.shimmed, undefined);
		assert.equal(probe?.resolvedPath, real);
		assert.equal(probe?.source, "known-location");
		assert.equal(isDshRunnerNodeCompatible(probe.version), true);

		const info = await detectDshRunnerNode({ platform: "win32", env, pathHits: [shim] });
		assert.equal(info.compatible, true);
		assert.equal(info.resolvedPath, real);
		assert.equal(await resolveDshRunnerNodePath({ platform: "win32", env, pathHits: [shim] }), real);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("用户手选垫片路径时判不兼容，并回退到自动探测的真 node", async (t) => {
	if (!isDshRunnerNodeCompatible(process.versions.node)) return t.skip(`CI node ${process.versions.node} 非 ${DSH_RUNNER_NODE_MAJOR}.x`);
	const root = await mkdtemp(join(tmpdir(), "pideck-shim-configured-"));
	try {
		const shim = await plantNodeBinary(join(root, "mise", "shims", "node.exe"));
		const real = await plantNodeBinary(join(root, "mise", "installs", "node", process.versions.node, "node.exe"));
		const env = { HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), MISE_DATA_DIR: join(root, "mise") };
		const info = await detectDshRunnerNode({ platform: "win32", env, configuredPath: shim, pathHits: [shim] });
		assert.equal(info.source, "configured");
		assert.equal(info.compatible, false);
		assert.match(info.error ?? "", /垫片/);
		assert.equal(await resolveDshRunnerNodePath({ platform: "win32", env, configuredPath: shim, pathHits: [shim] }), real);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

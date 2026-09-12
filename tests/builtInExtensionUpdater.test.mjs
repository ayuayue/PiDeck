/**
 * 内置扩展热更新器（BuiltInExtensionsUpdater）回归测试。
 *
 * 覆盖四类风险：
 * 1. 远端清单是不可信输入——文件名/摘要/结构异常必须整份丢弃，不能把可疑数据写进 -e 注入路径；
 * 2. 覆盖层是完整快照——扩展之间存在相对 import，只放差量文件会让 pi 解析不到依赖，
 *    因此更新必须写全「本地认识的」文件，且校验不过（半截/被篡改）时不得参与注入；
 * 3. 逐文件 sha256 判定——版本号被 bump/没 bump 都不是判据，内容变了才算有更新；
 * 4. 原子替换与回滚——更新失败不能把当前生效版本弄丢，还原/恢复上一版要能正确切回。
 *
 * 装载方式与其它主进程测试一致（tests/helpers/loadTsCommonJs.mjs）：
 * 生产代码用 bundler 的相对导入，测试侧在 CommonJS VM 里解析 TS 依赖图，不改生产 import。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 解析器与更新器必须共享同一个 builtInExtensions 模块实例：覆盖层的「可用性缓存」
// 住在那里，更新器写盘后靠 invalidate 让解析器重新校验——两个实例会让缓存断言失真。
const builtIn = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");
const manifest = loadTsCommonJs("src/main/extensions/builtInExtensionsManifest.ts");
const updaterModule = loadTsCommonJs("src/main/extensions/builtInExtensionsUpdater.ts", {
	stubs: { "./builtInExtensions": builtIn },
});

const { BuiltInExtensionsUpdater } = updaterModule;
const { EXTENSIONS_MANIFEST_FILE_NAME, parseBuiltInExtensionsManifest, readVerifiedArtifact } = manifest;
const { resolveBuiltInExtensionPath, resolveBuiltInExtensionsOverlayDir, readEffectiveBuiltInExtensionsVersion } = builtIn;

const BRANCH = "main";

function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function buildManifest(files, version) {
	const entries = Object.keys(files)
		.sort()
		.map((name) => ({
			name,
			sha256: sha256(files[name]),
			bytes: Buffer.byteLength(files[name], "utf8"),
		}));
	const bundleSha256 = createHash("sha256")
		.update(entries.map((entry) => `${entry.name}:${entry.sha256}`).join("\n"))
		.digest("hex");
	return { schemaVersion: 1, version, bundleSha256, fileCount: entries.length, files: entries };
}

/** 夹具：pod 目录 + 内置扩展目录 + 已生成的清单（模拟随包分发的那一份）。 */
function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "pideck-builtin-ext-"));
	const builtinDir = join(root, "resources", "extensions");
	const userDataDir = join(root, "userData");
	mkdirSync(builtinDir, { recursive: true });
	mkdirSync(userDataDir, { recursive: true });
	const files = {
		// pi-deck-todo-state.ts 刻意**不在** BUILT_IN_EXTENSIONS 列表里，但在清单内——
		// 它被 pi-deck-todo.ts 相对 import，是「覆盖层必须自洽」的真实成因。
		"pi-deck-todo-state.ts": "export const state = 1;\n",
		"pi-deck-todo.ts": "import './pi-deck-todo-state';\nexport const todo = 1;\n",
		"pi-deck-vision.ts": "export const vision = 1;\n",
	};
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(builtinDir, name), content);
	}
	const manifestText = `${JSON.stringify(buildManifest(files, "1.0.0"), null, 2)}\n`;
	writeFileSync(join(builtinDir, EXTENSIONS_MANIFEST_FILE_NAME), manifestText);
	return { root, builtinDir, userDataDir, files };
}

/** 远端清单的原始文本（版本号 + 文件内容可覆盖，用来构造「内容变了但版本没 bump」）。 */
function remoteManifestText(files, version) {
	return `${JSON.stringify(buildManifest(files, version), null, 2)}\n`;
}

/**
 * 假远端：AtomGit 走 OpenAPI contents（base64 包装），GitHub 走 raw 纯文本。
 * 记录请求 URL，便于断言「默认源是 AtomGit」与「GitHub 源时 raw 直连优先」。
 */
function makeNetwork(repoFiles) {
	const calls = [];
	const repoPath = Object.keys(repoFiles);
	const fetchImpl = async (url) => {
		calls.push(url);
		const relPath = resolveRepoPath(url);
		const content = relPath ? repoFiles[relPath] : undefined;
		if (content === undefined) {
			return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
		}
		const isAtomGit = url.includes("api.atomgit.com");
		const payload = isAtomGit
			? JSON.stringify({
				type: "file",
				encoding: "base64",
				content: Buffer.from(content, "utf8").toString("base64"),
			})
			: content;
		return {
			ok: true,
			status: 200,
			async arrayBuffer() {
				const buffer = Buffer.from(payload, "utf8");
				// 返回精确切片，避免共享 ArrayBuffer 池把相邻数据带进来（sha256 会因此抖动）
				return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
			},
		};
	};
	return { fetchImpl, calls, repoPath };
}

function resolveRepoPath(url) {
	const marker = "/contents/";
	const idx = url.indexOf(marker);
	if (idx >= 0) {
		const rest = url.slice(idx + marker.length);
		const query = rest.indexOf("?");
		return decodeURIComponent(query < 0 ? rest : rest.slice(0, query));
	}
	// raw.githubusercontent.com/<owner>/<repo>/<branch>/<path...>
	const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/);
	if (raw) return decodeURIComponent(raw[2]);
	return null;
}

function createUpdater(fixture, repoFiles, options = {}) {
	const network = makeNetwork(repoFiles);
	const updater = new BuiltInExtensionsUpdater({
		userDataDir: fixture.userDataDir,
		builtinExtensionsDir: fixture.builtinDir,
		fetchImpl: network.fetchImpl,
		branch: BRANCH,
		...options,
	});
	return { updater, network };
}

function repoFilesOf(fixture, override = {}, version = "1.0.1") {
	const files = { ...fixture.files, ...override };
	return {
		[`resources/extensions/${EXTENSIONS_MANIFEST_FILE_NAME}`]: remoteManifestText(files, version),
		...Object.fromEntries(
			Object.entries(files).map(([name, content]) => [`resources/extensions/${name}`, content]),
		),
	};
}

/**
 * 每次用例自建夹具并清理，避免跨用例的 userData 覆盖层状态泄漏。
 * 必须 await 回调：夹具目录在回调**返回之后**才删除，否则异步用例会读到空目录。
 */
async function withFixture(run) {
	const fixture = makeFixture();
	try {
		return await run(fixture);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}

test("parseBuiltInExtensionsManifest 丢弃一切不可信结构", () => {
	const goodFile = { name: "a.ts", sha256: "b".repeat(64), bytes: 1 };
	const good = { schemaVersion: 1, version: "1.0.0", bundleSha256: "c".repeat(64), files: [goodFile] };
	const parsed = parseBuiltInExtensionsManifest(JSON.stringify(good));
	assert.ok(parsed);
	// fileCount 由 files 推出，不信任自报值
	assert.equal(parseBuiltInExtensionsManifest(JSON.stringify({ ...good, fileCount: 99 })).fileCount, 1);

	assert.equal(parseBuiltInExtensionsManifest("{ not json"), null);
	assert.equal(parseBuiltInExtensionsManifest(JSON.stringify({ ...good, schemaVersion: 2 })), null);
	assert.equal(parseBuiltInExtensionsManifest(JSON.stringify({ ...good, version: "v1.0.0" })), null);
	assert.equal(parseBuiltInExtensionsManifest(JSON.stringify({ ...good, files: [] })), null);
	// 目录穿越 / 非 .ts / 子目录
	for (const name of ["../evil.ts", "sub/dir.ts", "evil.js", "evil.ts.exe"]) {
		const raw = JSON.stringify({ ...good, files: [{ ...goodFile, name }] });
		assert.equal(parseBuiltInExtensionsManifest(raw), null, `应拒绝文件名 ${name}`);
	}
	// 摘要形态非法
	assert.equal(
		parseBuiltInExtensionsManifest(JSON.stringify({ ...good, files: [{ ...goodFile, sha256: "xyz" }] })),
		null,
	);
	// bytes 必须正整数
	assert.equal(
		parseBuiltInExtensionsManifest(JSON.stringify({ ...good, files: [{ ...goodFile, bytes: 0 }] })),
		null,
	);
	// 同名重复会让「以文件名为键」的比对产生歧义
	assert.equal(
		parseBuiltInExtensionsManifest(JSON.stringify({ ...good, files: [goodFile, goodFile] })),
		null,
	);
});

test("readVerifiedArtifact 对内容/字节数被篡改的目录返回 null", () => {
	withFixture((fixture) => {
		assert.ok(readVerifiedArtifact(fixture.builtinDir));
		// 内容被外部改动但清单未更新 → 覆盖层/内置目录都不得带病生效
		writeFileSync(join(fixture.builtinDir, "pi-deck-vision.ts"), "export const vision = 2;\n");
		assert.equal(readVerifiedArtifact(fixture.builtinDir), null);
	});
});

test("checkRemote 按逐文件 sha256 判定更新，且忽略本地不认识的新文件名", async () => {
	await withFixture(async (fixture) => {
		// 1) 只改内容、不改版本号：仍须判定为「有更新」（版本号不是判据）
		const changed = repoFilesOf(fixture, { "pi-deck-vision.ts": "export const vision = 2;\n" }, "1.0.0");
		const { updater, network } = createUpdater(fixture, changed);
		const result = await updater.checkRemote();
		assert.equal(result.ok, true);
		assert.equal(result.hasUpdate, true);
		assert.equal(result.remoteVersion, "1.0.0");
		assert.equal(result.localVersion, "1.0.0");
		assert.deepEqual([...result.changedFiles], ["pi-deck-vision.ts"]);
		// 默认源是 AtomGit：首个请求必须打到 OpenAPI contents
		assert.ok(network.calls[0].includes("api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/"));
		assert.ok(network.calls[0].includes(`ref=${BRANCH}`));

		// 2) 远端多出一个本地不认识的文件：注入清单编译在应用里，不能凭空引入新代码
		const withNewFile = repoFilesOf(fixture, { "pi-deck-brand-new.ts": "export const x = 1;\n" }, "1.0.2");
		const { updater: second } = createUpdater(fixture, withNewFile);
		const secondResult = await second.checkRemote();
		assert.equal(secondResult.ok, true);
		assert.equal(secondResult.hasUpdate, false);
		assert.deepEqual([...secondResult.changedFiles], []);

		// 3) 清单结构非法 → 当作「拿不到有效清单」，不报有更新
		const broken = {
			...changed,
			[`resources/extensions/${EXTENSIONS_MANIFEST_FILE_NAME}`]: JSON.stringify({
				schemaVersion: 1,
				version: "1.0.2",
				files: [{ name: "../evil.ts", sha256: "a".repeat(64), bytes: 3 }],
			}),
		};
		const { updater: third } = createUpdater(fixture, broken);
		const thirdResult = await third.checkRemote();
		assert.equal(thirdResult.ok, false);
		assert.equal(thirdResult.code, "validation");
		assert.equal(thirdResult.hasUpdate, false);
	});
});

test("update 写入完整自洽覆盖层，解析路径与生效版本随之切换", async () => {
	await withFixture(async (fixture) => {
		const overlayDir = resolveBuiltInExtensionsOverlayDir(fixture.userDataDir);
		const roots = { appPath: fixture.root, resourcesPath: fixture.builtinDir, isDev: true, overlayDir };

		// 更新前：解析走随包内置目录，版本 1.0.0
		assert.equal(resolveBuiltInExtensionPath("pi-deck-todo.ts", roots), join(fixture.builtinDir, "pi-deck-todo.ts"));
		assert.equal(readEffectiveBuiltInExtensionsVersion(roots), "1.0.0");

		const repoFiles = repoFilesOf(fixture, { "pi-deck-vision.ts": "export const vision = 2;\n" }, "1.0.1");
		const { updater } = createUpdater(fixture, repoFiles);
		const result = await updater.update();
		assert.equal(result.ok, true);
		assert.equal(result.updated, true);
		assert.equal(result.version, "1.0.1");
		// 覆盖层是完整快照：3 个文件（含被 import 的 pi-deck-todo-state.ts）都要落盘
		assert.equal(result.filesWritten, 3);
		assert.ok(readVerifiedArtifact(overlayDir), "覆盖层必须通过整体校验");

		// 变化文件取远端内容，未变化文件从内置复制（相对 import 才能解析）
		assert.equal(
			readFileSync(join(overlayDir, "pi-deck-vision.ts"), "utf8"),
			"export const vision = 2;\n",
		);
		assert.equal(
			readFileSync(join(overlayDir, "pi-deck-todo-state.ts"), "utf8"),
			fixture.files["pi-deck-todo-state.ts"],
		);

		// 缓存失效：同一进程内的解析立刻切到覆盖层，不用等重启（否则「更新成功」只是自欺）
		assert.equal(resolveBuiltInExtensionPath("pi-deck-todo.ts", roots), join(overlayDir, "pi-deck-todo.ts"));
		assert.equal(readEffectiveBuiltInExtensionsVersion(roots), "1.0.1");
		// 随包目录保持原样，可随时还原
		assert.equal(readFileSync(join(fixture.builtinDir, "pi-deck-vision.ts"), "utf8"), fixture.files["pi-deck-vision.ts"]);
	});
});

test("半截/被篡改的覆盖层不得参与 -e 注入", async () => {
	await withFixture(async (fixture) => {
		const overlayDir = resolveBuiltInExtensionsOverlayDir(fixture.userDataDir);
		const roots = { appPath: fixture.root, resourcesPath: fixture.builtinDir, isDev: true, overlayDir };

		// 只有同名文件、没有清单（模拟手工丢文件/写盘中断）：不能认
		mkdirSync(overlayDir, { recursive: true });
		writeFileSync(join(overlayDir, "pi-deck-todo.ts"), "export const todo = 'hacked';\n");
		assert.equal(resolveBuiltInExtensionPath("pi-deck-todo.ts", roots), join(fixture.builtinDir, "pi-deck-todo.ts"));
		assert.equal(readEffectiveBuiltInExtensionsVersion(roots), "1.0.0");

		// 完整清单但某个文件被外部改动：整份失效，退回内置
		const repoFiles = repoFilesOf(fixture, { "pi-deck-vision.ts": "export const vision = 2;\n" }, "1.0.1");
		const { updater } = createUpdater(fixture, repoFiles);
		await updater.update();
		assert.equal(resolveBuiltInExtensionPath("pi-deck-todo.ts", roots), join(overlayDir, "pi-deck-todo.ts"));
		writeFileSync(join(overlayDir, "pi-deck-todo-state.ts"), "export const state = 'tampered';\n");
		builtIn.invalidateBuiltInExtensionsOverlayCache();
		assert.equal(resolveBuiltInExtensionPath("pi-deck-todo.ts", roots), join(fixture.builtinDir, "pi-deck-todo.ts"));
	});
});

test("已是最新时不写盘；restoreBuiltin / restorePrevious 正确切换生效版本", async () => {
	await withFixture(async (fixture) => {
		const overlayDir = resolveBuiltInExtensionsOverlayDir(fixture.userDataDir);
		const roots = { appPath: fixture.root, resourcesPath: fixture.builtinDir, isDev: true, overlayDir };
		const repoFiles = repoFilesOf(fixture, { "pi-deck-vision.ts": "export const vision = 2;\n" }, "1.0.1");
		const { updater } = createUpdater(fixture, repoFiles);

		// 第一次更新写盘，第二次同源应判定「已是最新」且不动磁盘
		assert.equal((await updater.update()).updated, true);
		const secondRun = await updater.update();
		assert.equal(secondRun.ok, true);
		assert.equal(secondRun.updated, false);
		assert.equal(secondRun.version, "1.0.1");

		// 还原内置：覆盖层转 .bak，解析回到随包目录，且可恢复上一版
		assert.equal(updater.getStatus().hasBackup, false);
		const restored = updater.restoreBuiltin();
		assert.equal(restored.ok, true);
		assert.equal(restored.updated, true);
		assert.equal(existsSync(overlayDir), false);
		assert.equal(resolveBuiltInExtensionPath("pi-deck-vision.ts", roots), join(fixture.builtinDir, "pi-deck-vision.ts"));
		assert.equal(readEffectiveBuiltInExtensionsVersion(roots), "1.0.0");
		const status = updater.getStatus();
		assert.equal(status.hasBackup, true);
		assert.equal(status.overlay, null);
		assert.equal(status.effectiveVersion, "1.0.0");

		const previous = updater.restorePrevious();
		assert.equal(previous.ok, true);
		assert.equal(previous.updated, true);
		assert.equal(resolveBuiltInExtensionPath("pi-deck-vision.ts", roots), join(overlayDir, "pi-deck-vision.ts"));
		assert.equal(readEffectiveBuiltInExtensionsVersion(roots), "1.0.1");
		assert.equal(updater.restorePrevious().ok, false);
	});
});

test("source=github 时 raw 直连优先；AtomGit 的 base64 解码必须字节精确", async () => {
	await withFixture(async (fixture) => {
		// 中文 + 换行：经 utf8 往返再丢一次编码就会让 sha256 校验失败，这里正好卡住字节精度
		const content = "export const todo = 1;\n// 中文注释：视觉桥接\n";
		const repoFiles = repoFilesOf(fixture, { "pi-deck-todo.ts": content }, "1.0.2");

		const githubRun = createUpdater(fixture, repoFiles, { source: () => "github" });
		const githubCheck = await githubRun.updater.checkRemote();
		assert.equal(githubCheck.ok, true);
		assert.ok(githubRun.network.calls[0].startsWith("https://raw.githubusercontent.com/ayuayue/PiDeck/"));
		assert.deepEqual([...githubCheck.changedFiles], ["pi-deck-todo.ts"]);

		const atomGitRun = createUpdater(fixture, repoFiles);
		const update = await atomGitRun.updater.update();
		assert.equal(update.ok, true);
		assert.equal(update.filesWritten, 3);
		// 落盘内容必须与远端字节一致，否则校验会挡下来（这里断言的是「确实一致」）
		assert.equal(
			readFileSync(join(resolveBuiltInExtensionsOverlayDir(fixture.userDataDir), "pi-deck-todo.ts"), "utf8"),
			content,
		);
	});
});

test("远端不可达时返回 network 失败且不触碰磁盘", async () => {
	await withFixture(async (fixture) => {
		const overlayDir = resolveBuiltInExtensionsOverlayDir(fixture.userDataDir);
		const updater = new BuiltInExtensionsUpdater({
			userDataDir: fixture.userDataDir,
			builtinExtensionsDir: fixture.builtinDir,
			fetchImpl: async () => {
				throw new Error("offline");
			},
		});
		const check = await updater.checkRemote();
		assert.equal(check.ok, false);
		assert.equal(check.code, "network");
		assert.equal(check.hasUpdate, false);
		const update = await updater.update();
		assert.equal(update.ok, false);
		assert.equal(update.code, "network");
		assert.equal(update.updated, false);
		assert.equal(existsSync(overlayDir), false);
	});
});

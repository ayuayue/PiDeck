/**
 * 内容包热更新器（BuiltinContentUpdater + PromptStoreUpdater 提示词域）回归测试。
 *
 * 提示词商店官方模板 / 内置技能复用了「resources 只读 → userData 覆盖层」机制，
 * 但内容域与扩展域有两个关键差异，必须单独断言：
 * 1. allowNewFiles=true——远端新增模板要能落盘并作为新 slug 出现（扩展注入代码不允许）；
 * 2. 覆盖层必须是完整快照——变化文件取远端、未变化文件从内置复制、清单一起写，
 *    查询侧（XuePromptManager）只认校验通过的覆盖层。
 *
 * 装载方式与其它主进程测试一致（tests/helpers/loadTsCommonJs.mjs），网络用 fetchImpl 注入。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const promptsModule = loadTsCommonJs("src/main/prompts/promptStoreUpdater.ts");

const { PromptStoreUpdater, PROMPT_OVERLAY_DIR_NAME, PROMPT_OVERLAY_BACKUP_DIR_NAME, PROMPTS_MANIFEST_FILE_NAME } = promptsModule;

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

function manifestText(files, version) {
	return `${JSON.stringify(buildManifest(files, version), null, 2)}\n`;
}

/** 假远端：AtomGit 走 OpenAPI contents（base64 包装），GitHub 走 raw 纯文本。
 * repoFiles 的 key 是仓库相对路径（如 `resources/prompts/enhance-prompt.md`）。 */
function makeNetwork(repoFiles) {
	const repoPath = Object.keys(repoFiles);
	const fetchImpl = async (url) => {
		const relPath = resolveRepoPath(url);
		const content = relPath ? repoFiles[relPath] : undefined;
		if (content === undefined) {
			return {
				ok: false,
				status: 404,
				async arrayBuffer() {
					return new ArrayBuffer(0);
				},
			};
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
				return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
			},
		};
	};
	return { fetchImpl, repoPath };
}

function resolveRepoPath(url) {
	const marker = "/contents/";
	const idx = url.indexOf(marker);
	if (idx >= 0) {
		const rest = url.slice(idx + marker.length);
		const query = rest.indexOf("?");
		return decodeURIComponent(query < 0 ? rest : rest.slice(0, query));
	}
	const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/);
	if (raw) return decodeURIComponent(raw[2]);
	return null;
}

/** 夹具：内置 prompts 目录 + userData（模拟随包分发的那一份资源）。 */
function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "pideck-prompt-store-"));
	const builtinDir = join(root, "resources", "prompts");
	const userDataDir = join(root, "userData");
	mkdirSync(builtinDir, { recursive: true });
	mkdirSync(userDataDir, { recursive: true });
	const files = {
		"enhance-prompt.md": "# 通用增强\n\n把草稿展开为更清晰的指令。\n",
		"plan-build.md": "# 计划与构建\n\n先计划后执行。\n",
	};
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(builtinDir, name), content);
	}
	writeFileSync(join(builtinDir, PROMPTS_MANIFEST_FILE_NAME), manifestText(files, "1.0.0"));
	return { root, builtinDir, userDataDir, files };
}

function createUpdater(fixture, repoFiles) {
	// 仓库相对路径 key 化：`enhance-prompt.md` → `resources/prompts/enhance-prompt.md`
	const remote = {};
	for (const [name, content] of Object.entries(repoFiles)) {
		remote[name.startsWith("resources/") ? name : `resources/prompts/${name}`] = content;
	}
	// 远端必须带着对应内容的清单（否则 404 → network 失败）；清单里的 name 是裸文件名
	remote[`resources/prompts/${PROMPTS_MANIFEST_FILE_NAME}`] = manifestText(repoFiles, "1.0.0");
	const network = makeNetwork(remote);
	const updater = new PromptStoreUpdater({
		userDataDir: fixture.userDataDir,
		builtinPromptsDir: fixture.builtinDir,
		fetchImpl: network.fetchImpl,
	});
	return { updater, network };
}

function overlayDir(fixture) {
	return join(fixture.userDataDir, PROMPT_OVERLAY_DIR_NAME);
}

test("checkRemote：内容变了但版本没 bump 也要检出（判据是逐文件 sha256）", async () => {
	const fixture = makeFixture();
	try {
		// 远端改了 plan-build.md 正文，版本仍 1.0.0
		const remote = { ...fixture.files, "plan-build.md": "# 计划与构建（v2）\n\n更详细的步骤。\n" };
		const { updater } = createUpdater(fixture, remote);

		const status0 = updater.getStatus();
		assert.equal(status0.effectiveVersion, "1.0.0");
		assert.equal(status0.overlay, null);

		const result = await updater.checkRemote();
		assert.equal(result.ok, true);
		assert.equal(result.hasUpdate, true);
		// loadTsCommonJs 的 VM 数组与测试上下文数组原型不同，用 join 断言内容
		assert.equal(result.changedFiles.join(","), "plan-build.md");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("update：覆盖层是完整快照（变化文件取远端 + 未变化从内置复制 + 清单），并允许远端新增文件", async () => {
	const fixture = makeFixture();
	try {
		// 远端：修改 plan-build.md + 新增 brand-new.md（allowNewFiles=true 的内容域语义）
		const remote = {
			...fixture.files,
			"plan-build.md": "# 计划与构建（v2）\n\n更详细的步骤。\n",
			"brand-new.md": "# 全新模板\n\n远端新增。\n",
		};
		const { updater } = createUpdater(fixture, remote);

		const result = await updater.update();
		assert.equal(result.ok, true);
		assert.equal(result.updated, true);
		assert.equal(result.version, "1.0.0");

		// 覆盖层三样都在：变化文件（远端内容）、未变化文件（内置复制）、新文件
		assert.equal(readFileSync(join(overlayDir(fixture), "plan-build.md"), "utf8"), remote["plan-build.md"]);
		assert.equal(readFileSync(join(overlayDir(fixture), "enhance-prompt.md"), "utf8"), fixture.files["enhance-prompt.md"]);
		assert.equal(readFileSync(join(overlayDir(fixture), "brand-new.md"), "utf8"), remote["brand-new.md"]);
		// 清单一起落盘，且目录里没有多余文件（去掉清单恰好 3 个 md）
		const entries = readdirSync(overlayDir(fixture)).sort();
		assert.deepEqual(entries, ["brand-new.md", "enhance-prompt.md", "plan-build.md", PROMPTS_MANIFEST_FILE_NAME]);

		// 查询侧：覆盖层生效后 effectiveVersion 与 overlayDir 可被 XuePromptManager 叠加
		const status = updater.getStatus();
		assert.equal(status.overlay?.version, "1.0.0");
		assert.equal(status.effectiveVersion, "1.0.0");
		assert.equal(status.overlayDir, overlayDir(fixture));
		assert.equal(updater.resolveEffectiveOverlayDir(), overlayDir(fixture));
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("远端清单校验失败（文件摘要与清单不符）时整份丢弃、不写覆盖层", async () => {
	const fixture = makeFixture();
	try {
		// 清单声称 plan-build.md 是 v2 的 sha，但 contents 接口实际返回旧内容——不一致即不可信
		const remote = {};
		for (const [name, content] of Object.entries(fixture.files)) {
			remote[`resources/prompts/${name}`] = content;
		}
		// 用裸名构造清单文本（远端清单的 files[].name 就是相对仓库的裸文件名，走 fileNamePattern 校验）
		const tamperedManifest = buildManifest({ ...fixture.files, "plan-build.md": "# 计划与构建（v2）\n\n更详细的步骤。\n" }, "1.0.0");
		const tampered = `${JSON.stringify(tamperedManifest, null, 2)}\n`;
		const fetchImpl = async (url) => {
			if (url.includes(PROMPTS_MANIFEST_FILE_NAME)) {
				return {
					ok: true,
					status: 200,
					async arrayBuffer() {
						const buffer = Buffer.from(tampered, "utf8");
						return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
					},
				};
			}
			return makeNetwork(remote).fetchImpl(url);
		};
		const updater = new PromptStoreUpdater({
			userDataDir: fixture.userDataDir,
			builtinPromptsDir: fixture.builtinDir,
			fetchImpl,
		});

		const result = await updater.update();
		// 内容与清单 sha 不符在下载-落盘内部被拦下（writeOverlay 抛错 → code=write）：
		// 无论归类如何，契约都是「不产生可用覆盖层」
		assert.equal(result.ok, false);
		assert.equal(result.code === "validation" || result.code === "write", true);
		// 覆盖层目录存在文件时也应有提示，但不应出现校验通过的覆盖层
		assert.equal(updater.resolveEffectiveOverlayDir(), null);
		assert.equal(existsSync(join(overlayDir(fixture), "plan-build.md")), false);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("restoreBuiltin 还原 + restorePrevious 恢复上一版（.bak 校验通过才写回）", async () => {
	const fixture = makeFixture();
	try {
		const remote = { ...fixture.files, "plan-build.md": "# 计划与构建（v2）\n\n更详细的步骤。\n" };
		const { updater } = createUpdater(fixture, remote);
		assert.equal((await updater.update()).ok, true);

		// 还原内置：覆盖层转 .bak，查询侧立即回到内置
		const restore = updater.restoreBuiltin();
		assert.equal(restore.ok, true);
		assert.equal(updater.resolveEffectiveOverlayDir(), null);
		assert.equal(updater.getStatus().hasBackup, true);
		assert.equal(existsSync(join(fixture.userDataDir, PROMPT_OVERLAY_BACKUP_DIR_NAME)), true);

		// 恢复上一版：.bak 校验通过，覆盖层重新生效
		const prev = updater.restorePrevious();
		assert.equal(prev.ok, true);
		assert.equal(updater.resolveEffectiveOverlayDir(), overlayDir(fixture));
		assert.equal(readFileSync(join(overlayDir(fixture), "plan-build.md"), "utf8"), remote["plan-build.md"]);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("覆盖层被外部改动/删文件后不再生效（半截覆盖层 = 校验不通过）", async () => {
	const fixture = makeFixture();
	try {
		const remote = { ...fixture.files, "plan-build.md": "# 计划与构建（v2）\n\n更详细的步骤。\n" };
		const { updater } = createUpdater(fixture, remote);
		assert.equal((await updater.update()).ok, true);

		// 外部把覆盖层里的 enhance-prompt.md 改掉（sha 失配）
		writeFileSync(join(overlayDir(fixture), "enhance-prompt.md"), "# 被外部篡改\n", "utf8");
		assert.equal(updater.resolveEffectiveOverlayDir(), null, "校验失败时不得被视为有效覆盖层");
		// getStatus 仍能看到「覆盖层有文件」，UI 提示用户可还原
		assert.equal(updater.getStatus().hasOverlayFiles, true);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

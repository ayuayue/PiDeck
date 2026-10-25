/**
 * BuiltinContentUpdater 校验记忆化测试（2027-02 性能修复）。
 *
 * 背景：readVerifiedArtifact 被 getStatus / effectiveManifest / localFileShas /
 * resolveEffectiveDir 反复调用，原先每次全量 readFileSync + sha256（内容 MB 级时
 * 每次 10-50ms 同步 IO，堵主进程事件循环——打开提示词/技能商店整页卡）。
 * 修复：清单与逐文件哈希按 (size, mtimeMs) 记忆化（与 builtInExtensionsManifest
 * 同构）。本测试锁住两个契约：命中路径不再读盘；内容变化经 stat 判据失效。
 *
 * 读盘计数用 fs 核心模块补丁观测：loadTsCommonJs 转译出的 CJS 每次调用都经
 * require("node:fs").readFileSync 属性访问，与测试侧 import 的是同一对象。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PromptStoreUpdater, PROMPTS_MANIFEST_FILE_NAME } = loadTsCommonJs("src/main/prompts/promptStoreUpdater.ts");

function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function manifestText(files, version) {
	const entries = Object.keys(files)
		.sort()
		.map((name) => ({ name, sha256: sha256(files[name]), bytes: Buffer.byteLength(files[name], "utf8") }));
	return `${JSON.stringify({ schemaVersion: 1, version, bundleSha256: "", fileCount: entries.length, files: entries }, null, 2)}\n`;
}

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "pideck-content-memo-"));
	const builtinDir = join(root, "resources", "prompts");
	const userDataDir = join(root, "userData");
	mkdirSync(builtinDir, { recursive: true });
	mkdirSync(userDataDir, { recursive: true });
	const files = {
		"a.md": "# a\n\n内容甲\n",
		"b.md": "# b\n\n内容乙\n",
	};
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(builtinDir, name), content);
	}
	writeFileSync(join(builtinDir, PROMPTS_MANIFEST_FILE_NAME), manifestText(files, "1.0.0"));
	// 把所有文件 mtime 推到新鲜窗口（50ms）之外：缓存判据可信任区间，
	// 否则首查就因 FRESH_FILE_MTIME_GUARD 拒绝写缓存，测试不稳定。
	const past = new Date(Date.now() - 10_000);
	for (const name of [...Object.keys(files), PROMPTS_MANIFEST_FILE_NAME]) {
		utimesSync(join(builtinDir, name), past, past);
	}
	return { root, builtinDir, userDataDir, files };
}

test("重复校验命中缓存：不再 readFileSync（只 stat）", () => {
	const fixture = makeFixture();
	try {
		const updater = new PromptStoreUpdater({ userDataDir: fixture.userDataDir, builtinPromptsDir: fixture.builtinDir });
		// 首次 getStatus：填缓存（会读盘）
		assert.notEqual(updater.getStatus().builtin, null);

		const realRead = fs.readFileSync;
		let readCalls = 0;
		fs.readFileSync = (...args) => {
			readCalls += 1;
			return realRead(...args);
		};
		try {
			for (let i = 0; i < 5; i += 1) {
				assert.notEqual(updater.getStatus().builtin, null, "缓存命中时校验照常通过");
				assert.notEqual(updater.resolveEffectiveOverlayDir(), fixture.builtinDir, "resolveEffectiveDir 依赖校验结果");
			}
		} finally {
			fs.readFileSync = realRead;
		}
		assert.equal(readCalls, 0, "命中路径不得 readFileSync（manifest 与内容文件都走 memo）");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("内容变化经 stat 判据失效：mtime 未变不动、变了必重算", () => {
	const fixture = makeFixture();
	try {
		const updater = new PromptStoreUpdater({ userDataDir: fixture.userDataDir, builtinPromptsDir: fixture.builtinDir });
		assert.notEqual(updater.getStatus().builtin, null, "前置：原始 artifact 有效");

		// 等字节数覆写 + mtime 停在旧刻度：这正是记忆化的盲区（分辨不出），
		// 但只要 mtime 变化（正常写盘必然发生），下一次校验必须发现内容不符。
		const target = join(fixture.builtinDir, "a.md");
		writeFileSync(target, "# a\n\n内容丙\n"); // 等长度（字节数相同）
		const bumped = new Date(Date.now() - 5_000); // 仍在新鲜窗口外、但与缓存值不同
		utimesSync(target, bumped, bumped);
		const status = updater.getStatus();
		assert.equal(status.builtin, null, "mtime 变化后必须重算并发现 sha 不符（artifact 失效）");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

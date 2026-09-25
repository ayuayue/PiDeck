import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// 纯函数 + 数据清单守卫：不碰网络、不下载真实二进制。
const load = createTsSandbox();
const manager = load("src/main/voice/WhisperRuntimeManager.ts");
const runtime = load("src/shared/types/whisperRuntime.ts");

test("isSafeArchiveEntry 拒绝绝对路径 / 盘符 / .. 逃逸（tar slip 防护）", () => {
	const dest = "/tmp/voice-runtime";
	assert.equal(manager.isSafeArchiveEntry(dest, "whisper.cpp/bin/whisper-cli"), true);
	assert.equal(manager.isSafeArchiveEntry(dest, "a/b/c.txt"), true);
	assert.equal(manager.isSafeArchiveEntry(dest, "/etc/passwd"), false);
	assert.equal(manager.isSafeArchiveEntry(dest, "C:\\Windows\\system32\\evil.exe"), false);
	assert.equal(manager.isSafeArchiveEntry(dest, "../escape"), false);
	assert.equal(manager.isSafeArchiveEntry(dest, "a/../../escape"), false);
	assert.equal(manager.isSafeArchiveEntry(dest, "sub\\..\\..\\up"), false);
});

test("resolveWhisperHostSupport 覆盖 win/linux 架构，macOS 只支持自定义路径", () => {
	// vm realm 返回对象，逐字段比较以避开跨 realm 原型差异（deepStrictEqual 会挂）。
	const win = runtime.resolveWhisperHostSupport("win32", "x64");
	assert.equal(win.autoRuntime, true);
	assert.equal(win.asset, "whisper-bin-x64.zip");
	assert.equal(win.format, "zip");
	assert.equal(runtime.resolveWhisperHostSupport("win32", "arm64").autoRuntime, true);
	assert.equal(runtime.resolveWhisperHostSupport("linux", "x64").format, "tar.gz");
	assert.equal(runtime.resolveWhisperHostSupport("linux", "arm64").autoRuntime, true);
	// macOS 官方无 CLI 预编译包：autoRuntime=false，UI 需引导用户手动指定 cliPath
	assert.equal(runtime.resolveWhisperHostSupport("darwin", "arm64").autoRuntime, false);
	// 未知架构返回 null（不假装能下载）
	assert.equal(runtime.resolveWhisperHostSupport("freebsd", "x64"), null);
});

test("模型清单数据锚点：id/文件名唯一、sha256 为 64 位小写 hex、字节数为正", () => {
	const ids = new Set();
	const files = new Set();
	for (const def of runtime.WHISPER_MODEL_CATALOG) {
		assert.equal(ids.has(def.id), false, `id 唯一: ${def.id}`);
		assert.equal(files.has(def.file), false, `file 唯一: ${def.file}`);
		ids.add(def.id);
		files.add(def.file);
		assert.match(def.sha256, /^[0-9a-f]{64}$/, `sha256 合法: ${def.id}`);
		assert.ok(def.bytes > 0, `字节数为正: ${def.id}`);
		assert.equal(runtime.getWhisperModelDef(def.id), def);
	}
	assert.equal(runtime.getWhisperModelDef("no-such-model"), undefined);
	assert.equal(runtime.getWhisperModelDef(undefined), undefined);
	// 默认模型必须在目录内
	assert.ok(runtime.getWhisperModelDef(runtime.DEFAULT_WHISPER_MODEL_ID));
});

test("模型下载候选：镜像优先、官方兜底；资产 URL 固定在 release tag 下", () => {
	const candidates = runtime.whisperModelUrlCandidates("ggml-base-q5_1.bin");
	assert.match(candidates[0], /^https:\/\/hf-mirror\.com\//);
	assert.match(candidates[1], /^https:\/\/huggingface\.co\//);
	assert.ok(runtime.whisperAssetUrl("whisper-bin-x64.zip").includes(runtime.WHISPER_CPP_RELEASE_TAG));
});

test("findWhisperCliBinary 在解出的目录树里找到可执行文件（新旧命名都认）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-whisper-find-"));
	try {
		// 深层目录 + 干扰文件，验证是递归查找而非只看顶层。
		const nested = join(dir, "whisper.cpp-build", "bin");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "whisper-cli.exe"), "x");
		assert.equal(manager.findWhisperCliBinary(dir, "win32"), join(nested, "whisper-cli.exe"));
		// 平台不匹配：win 只认 .exe，在 linux 下不应命中
		assert.equal(manager.findWhisperCliBinary(dir, "linux"), null);
		const posixDir = mkdtempSync(join(tmpdir(), "pideck-whisper-find-posix-"));
		try {
			writeFileSync(join(posixDir, "main"), "x"); // 旧版命名
			assert.equal(manager.findWhisperCliBinary(posixDir, "linux"), join(posixDir, "main"));
		} finally {
			rmSync(posixDir, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

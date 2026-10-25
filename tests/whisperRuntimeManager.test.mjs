import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
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

test("模型清单下限收在 Small：Tiny / Base 按实测效果下架，档位不得回流", () => {
	// vm realm 返回数组，逐值比较以避开跨 realm 原型差异（deepStrictEqual 会挂）。
	assert.equal(runtime.WHISPER_MODEL_CATALOG.map((def) => def.id).join(","), "small-q5_1,medium-q5_0,turbo-q5_0");
	// 下架的小档位再解析必须为空：设置页下拉与下载入口都以 getWhisperModelDef 为准。
	assert.equal(runtime.getWhisperModelDef("tiny-q5_1"), undefined);
	assert.equal(runtime.getWhisperModelDef("base-q5_1"), undefined);
	// 体积下限：清单里出现比 Small 更小的模型，即视为把下架的档位又加回来了。
	for (const def of runtime.WHISPER_MODEL_CATALOG) assert.ok(def.bytes >= 190_000_000, `档位体积不得低于 Small: ${def.id}`);
	// 默认档取下限，不让新用户在首次启用就要下载 500MB+。
	assert.equal(runtime.DEFAULT_WHISPER_MODEL_ID, "small-q5_1");
});

test("模型下载候选：镜像优先、官方兜底；资产 URL 固定在 release tag 下", () => {
	const candidates = runtime.whisperModelUrlCandidates("ggml-small-q5_1.bin");
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

test("findWhisperCliBinary 同名并存时优先 whisper-cli.exe（而非旧版 main.exe）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-whisper-prio-"));
	try {
		mkdirSync(join(dir, "Release"), { recursive: true });
		writeFileSync(join(dir, "Release", "main.exe"), "x");
		writeFileSync(join(dir, "Release", "whisper-cli.exe"), "x");
		assert.equal(manager.findWhisperCliBinary(dir, "win32"), join(dir, "Release", "whisper-cli.exe"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("运行时标记记录了失效的临时路径时，getStatus 扫描版本目录自愈（用户报「老是提示未配置」的根因）", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-whisper-selfheal-"));
	try {
		const runtimeRoot = join(root, "runtime");
		const versionDir = join(runtimeRoot, runtime.WHISPER_CPP_RELEASE_TAG);
		mkdirSync(join(versionDir, "Release"), { recursive: true });
		writeFileSync(join(versionDir, "Release", "whisper-cli.exe"), "x");
		writeFileSync(join(versionDir, "Release", "main.exe"), "x");
		// 坏标记：cliRelPath 指向安装后被清理掉的临时目录（正是线上那份 pideck-runtime.json 的形态）。
		writeFileSync(join(versionDir, "pideck-runtime.json"), JSON.stringify({ version: runtime.WHISPER_CPP_RELEASE_TAG, cliRelPath: "..\\tmp\\runtime-123\\Release\\main.exe", platform: "win32", arch: "x64" }), "utf8");
		const mgr = new manager.WhisperRuntimeManager({
			platform: "win32",
			arch: "x64",
			layout: { runtimeRoot, modelsRoot: join(root, "models"), tempRoot: join(root, "tmp") },
			download: async () => {},
		});
		const status = mgr.getStatus({ cliPath: "", localModelId: "small-q5_1" });
		assert.equal(status.cliReady, true);
		assert.equal(status.cliSource, "auto");
		// 死路径被回退扫描取代，且命中高优先级的 whisper-cli.exe。
		assert.equal(status.cliPath, join(versionDir, "Release", "whisper-cli.exe"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("标记文件缺失或损坏时，只要 CLI 在位就算已安装（点下载不再重下）", async () => {
	// 两种「标记不可用」形态：完全没有标记文件、标记不是合法 JSON。
	for (const markerContent of [null, "{ not json"]) {
		const root = mkdtempSync(join(tmpdir(), "pideck-whisper-reuse-"));
		const downloads = [];
		try {
			const runtimeRoot = join(root, "runtime");
			const versionDir = join(runtimeRoot, runtime.WHISPER_CPP_RELEASE_TAG);
			mkdirSync(join(versionDir, "bin"), { recursive: true });
			writeFileSync(join(versionDir, "bin", "whisper-cli.exe"), "x");
			if (markerContent !== null) writeFileSync(join(versionDir, "pideck-runtime.json"), markerContent, "utf8");
			const mgr = new manager.WhisperRuntimeManager({
				platform: "win32",
				arch: "x64",
				layout: { runtimeRoot, modelsRoot: join(root, "models"), tempRoot: join(root, "tmp") },
				download: async (_url, destPath) => {
					downloads.push(destPath);
				},
			});
			const label = markerContent === null ? "缺标记" : "坏标记";
			const status = mgr.getStatus({ cliPath: "", localModelId: undefined });
			assert.equal(status.cliReady, true, label);
			assert.equal(status.cliSource, "auto", label);
			assert.equal(status.runtimeVersion, runtime.WHISPER_CPP_RELEASE_TAG, label);

			const progress = [];
			const result = await mgr.installRuntime((value) => progress.push(value));
			assert.equal(result.ok, true, label);
			// 检测优先：复用已在位的二进制，一次下载都不该发生。
			assert.equal(downloads.length, 0, label);
			assert.equal(progress.at(-1).phase, "done", label);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

/**
 * 用「几 KB 的假模型」跑真实下载编排：目录被 stub 换成测试自定义的 def，
 * 字节数与 sha256 都由测试自己算，避免为了测续传去下载 500MB。
 */
function loadManagerWithFakeModel(def) {
	const load = createTsSandbox({
		stubs: {
			"../../shared/types/whisperRuntime": {
				...runtime,
				WHISPER_MODEL_CATALOG: [def],
				getWhisperModelDef: (id) => (id === def.id ? def : undefined),
			},
		},
	});
	return load("src/main/voice/WhisperRuntimeManager.ts");
}

test("模型下载断点续传：中断保留 .part，下次点击从已下载字节接着传", async () => {
	const content = Buffer.alloc(4096, 0x41);
	const def = { id: "fake-q5", file: "ggml-fake.bin", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), label: "Fake", multilingual: true };
	const fakeManager = loadManagerWithFakeModel(def);
	const root = mkdtempSync(join(tmpdir(), "pideck-whisper-resume-"));
	try {
		const tempRoot = join(root, "tmp");
		mkdirSync(tempRoot, { recursive: true });
		const modelsRoot = join(root, "models");
		const partPath = join(tempRoot, "ggml-fake.bin.part");
		writeFileSync(join(tempRoot, "ggml-fake.bin.1700000000000.part"), "legacy");
		const resumes = [];
		let networkDown = true;
		const mgr = new fakeManager.WhisperRuntimeManager({
			platform: "win32",
			arch: "x64",
			layout: { runtimeRoot: join(root, "runtime"), modelsRoot, tempRoot },
			download: async (_url, destPath, onProgress, _signal, options) => {
				const resumeFrom = options?.resumeFromBytes ?? 0;
				resumes.push(resumeFrom);
				// 断线现场：只落了 1024 字节，续传时已有部分不重写。
				if (resumeFrom === 0) writeFileSync(destPath, content.subarray(0, 1024));
				onProgress?.(Math.max(resumeFrom, 1024), content.length);
				if (networkDown) throw new Error("download aborted by remote");
				appendFileSync(destPath, content.subarray(resumeFrom));
				onProgress?.(content.length, content.length);
			},
		});

		const first = await mgr.installModel("fake-q5", () => {});
		assert.equal(first.ok, false);
		// 网络失败绝不清空断点：这正是「重新进来又要从头下 500MB」的根源。
		assert.equal(existsSync(partPath), true);
		assert.equal(statSync(partPath).size, 1024);
		// 旧命名（带时间戳）的断点既续不上也没删除入口，第一次下载就顺手收掉，不留磁盘垃圾
		assert.equal(existsSync(join(tempRoot, "ggml-fake.bin.1700000000000.part")), false);
		// 进度被记录下来，设置页即使重开也看得到「已下载多少」。
		assert.equal(mgr.getStatus({}).models[0].partialBytes, 1024);

		networkDown = false;
		const second = await mgr.installModel("fake-q5", () => {});
		assert.equal(second.ok, true);
		assert.ok(resumes.includes(1024), "续传起点应等于已落盘字节数");
		assert.equal(readFileSync(join(modelsRoot, "ggml-fake.bin")).length, content.length);
		assert.equal(existsSync(partPath), false, "落位后断点应被 rename 带走");
		assert.equal(mgr.getStatus({}).models[0].installed, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("内容校验失败的断点会被丢弃，不会每次都卡在同一份坏数据上", async () => {
	const content = Buffer.alloc(2048, 0x41);
	const def = { id: "fake-q5", file: "ggml-fake.bin", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), label: "Fake", multilingual: true };
	const fakeManager = loadManagerWithFakeModel(def);
	const root = mkdtempSync(join(tmpdir(), "pideck-whisper-corrupt-"));
	try {
		const tempRoot = join(root, "tmp");
		const mgr = new fakeManager.WhisperRuntimeManager({
			platform: "win32",
			arch: "x64",
			layout: { runtimeRoot: join(root, "runtime"), modelsRoot: join(root, "models"), tempRoot },
			// 尺寸完全对、内容全错（镜像被污染/HTML 错误页拼出来的字节）→ sha256-mismatch
			download: async (_url, destPath, onProgress) => {
				writeFileSync(destPath, Buffer.alloc(def.bytes, 0x42));
				onProgress?.(def.bytes, def.bytes);
			},
		});
		const result = await mgr.installModel("fake-q5", () => {});
		assert.equal(result.ok, false);
		assert.match(result.error, /sha256-mismatch/);
		assert.equal(existsSync(join(tempRoot, "ggml-fake.bin.part")), false, "坏断点必须丢弃");
		assert.equal(mgr.getStatus({}).models[0].partialBytes, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/** 卡住的下载器：先落一点字节再挂到 signal 被 abort（模拟几百 MB 传输中途点「取消」）。 */
function hangingDownloader(spy) {
	return (_url, destPath, onProgress, signal) =>
		new Promise((_resolve, reject) => {
			spy.push({ destPath, signal });
			writeFileSync(destPath, "partial-bytes");
			onProgress?.(1024, 2048);
			signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true });
		});
}

test("下载可以中止：abortInstall 取消当前任务、保留断点并释放串行槽位", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-whisper-abort-"));
	try {
		const tempRoot = join(root, "tmp");
		const started = [];
		const mgr = new manager.WhisperRuntimeManager({
			platform: "win32",
			arch: "x64",
			layout: { runtimeRoot: join(root, "runtime"), modelsRoot: join(root, "models"), tempRoot },
			download: hangingDownloader(started),
		});
		// 空闲时没有可中止的任务
		assert.equal(mgr.abortInstall(), false);

		const progress = [];
		const first = mgr.installModel("medium-q5_0", (value) => progress.push(value));
		await new Promise((resolveTick) => setImmediate(resolveTick));
		assert.equal(started.length, 1);

		// 同一时刻只允许一个下载：第二个任务直接拒，不起新下载也不覆盖 tmp
		const second = await mgr.installModel("turbo-q5_0", () => {});
		assert.equal(second.ok, false);
		assert.equal(second.error, "already-installing");
		assert.equal(started.length, 1, "被拒的任务不得发起下载");

		assert.equal(mgr.abortInstall(), true);
		const aborted = await first;
		assert.equal(aborted.ok, false);
		assert.equal(aborted.error, "cancelled");
		assert.equal(progress.at(-1).phase, "error");
		assert.equal(progress.at(-1).error, "cancelled");
		// 取消不是「作废」：已下载的字节留作断点，下次点下载接着传（否则用户等半小时的 547MB 白费）
		assert.deepEqual(
			readdirSync(tempRoot).filter((name) => name.endsWith(".part")),
			["ggml-medium-q5_0.bin.part"],
		);

		// 槽位必须随任务结束释放，否则一次取消会让安装永久不可用
		assert.equal(mgr.abortInstall(), false);
		// 用户主动「删除模型」= 不要这份下载，断点也要一起释放磁盘
		assert.equal(mgr.deleteModel("medium-q5_0").ok, true);
		assert.deepEqual(
			readdirSync(tempRoot).filter((name) => name.endsWith(".part")),
			[],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("运行时下载中止同样报 cancelled，而不是把 AbortError 当下载失败", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-whisper-abort-rt-"));
	try {
		const started = [];
		const mgr = new manager.WhisperRuntimeManager({
			platform: "win32",
			arch: "x64",
			layout: { runtimeRoot: join(root, "runtime"), modelsRoot: join(root, "models"), tempRoot: join(root, "tmp") },
			download: hangingDownloader(started),
		});
		const progress = [];
		const installing = mgr.installRuntime((value) => progress.push(value));
		await new Promise((resolveTick) => setImmediate(resolveTick));
		assert.equal(started.length, 1);
		assert.equal(mgr.abortInstall(), true);
		const result = await installing;
		assert.equal(result.error, "cancelled");
		assert.equal(progress.at(-1).target, "runtime");
		assert.equal(progress.at(-1).error, "cancelled");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("没有任何可用 CLI 文件时 getStatus 判为未就绪（不会假就绪）", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-whisper-empty-"));
	try {
		const runtimeRoot = join(root, "runtime");
		const versionDir = join(runtimeRoot, runtime.WHISPER_CPP_RELEASE_TAG);
		mkdirSync(versionDir, { recursive: true });
		writeFileSync(join(versionDir, "pideck-runtime.json"), JSON.stringify({ version: runtime.WHISPER_CPP_RELEASE_TAG, cliRelPath: "nope.exe", platform: "win32", arch: "x64" }), "utf8");
		const mgr = new manager.WhisperRuntimeManager({ platform: "win32", arch: "x64", layout: { runtimeRoot, modelsRoot: join(root, "models"), tempRoot: join(root, "tmp") }, download: async () => {} });
		const status = mgr.getStatus({ cliPath: "", localModelId: "small-q5_1" });
		assert.equal(status.cliReady, false);
		assert.equal(status.cliSource, "none");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

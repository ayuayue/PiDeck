/**
 * ChannelSwitchService 单测（Task 6 步骤 5，规格 §3）：
 * - 桩注入：netFetch 返回固定 releases / 3 块数据的下载 body；getTempDir 返回一次性 tmp；
 *   spawnInstaller / quitApp / sendToRenderer / registerQuitCleanup 全部收集器；无真实网络。
 * - query：dev 目标（当前 stable）返回 prerelease 最新并推 querying→available 快照；
 * - download：进度百分比单调，完成后 ready 快照带 installerPath，文件内容等于分块拼接；
 * - digest：匹配通过；缺失跳过不报错；不匹配报错并推 error 快照；
 * - 网络失败 → error 快照，含 releases 页地址作手动下载退化入口；
 * - 并发防护：downloading 期间重复 download / query 收 busy，下载中快照不被覆盖，完成后可再次下载。
 * 服务保持 electron-free，createTsSandbox 直载（getAppLogger 未注册时静默跳过）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const { ChannelSwitchService, INSTALLER_TEMP_DIR } = createTsSandbox()("src/main/update/ChannelSwitchService.ts");
const { RELEASES_URL } = createTsSandbox()("src/main/update/releaseRepo.ts");

/** 按当前测试平台返回「会被 selectTargetRelease 命中」的资产名/URL。 */
function platformAsset(version) {
	if (process.platform === "win32") return { name: `PiDeck-${version}-setup.exe`, url: `https://github.com/a/${version}-setup.exe` };
	if (process.platform === "darwin") {
		const suffix = process.arch === "arm64" ? "-arm64" : process.arch === "x64" ? "-x64" : `-${process.arch}`;
		return { name: `PiDeck-${version}${suffix}.dmg`, url: `https://github.com/a/${version}${suffix}.dmg` };
	}
	if (process.platform === "linux" && process.arch === "x64") return { name: `PiDeck-${version}-x64.AppImage`, url: `https://github.com/a/${version}.AppImage` };
	throw new Error(`unsupported test platform ${process.platform}/${process.arch}`);
}

/** releases JSON 文本（只含当前平台能命中的资产，version 由平台无关的语义决定）。 */
function releasesJson({ prereleaseVersion, stableVersion }) {
	const prereleaseAsset = platformAsset(prereleaseVersion);
	const stableAsset = platformAsset(stableVersion);
	return JSON.stringify([
		{
			tag_name: `v${stableVersion}`,
			prerelease: false,
			body: "stable notes",
			html_url: `https://github.com/ayuayue/PiDeck/releases/tag/v${stableVersion}`,
			assets: [{ name: stableAsset.name, browser_download_url: stableAsset.url }],
		},
		{
			tag_name: `v${prereleaseVersion}`,
			prerelease: true,
			body: "dev notes",
			html_url: `https://github.com/ayuayue/PiDeck/releases/tag/v${prereleaseVersion}`,
			assets: [{ name: prereleaseAsset.name, browser_download_url: prereleaseAsset.url, digest: "sha256:deadbeef" }],
		},
	]);
}

/** 下载响应 body 桩：getReader() 逐块吐出（与 DOM ReadableStream 同形，服务用 reader 循环读）。 */
function makeBody(chunks) {
	let index = 0;
	return {
		getReader() {
			return {
				read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
			};
		},
	};
}

/** 组装服务与收集器；每个用例独立 tmp 目录，测试结束清理。 */
function makeService(t, { netFetch }) {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-channel-switch-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));
	const cleanups = [];
	const sent = [];
	const launched = [];
	let quitRequested = false;
	const service = new ChannelSwitchService({
		currentChannel: () => "stable",
		netFetch,
		getTempDir: () => tempDir,
		spawnInstaller: (filePath) => launched.push(filePath),
		quitApp: () => {
			quitRequested = true;
		},
		sendToRenderer: (snapshot) => sent.push(snapshot),
		registerQuitCleanup: (name, fn) => cleanups.push({ name, fn }),
	});
	return { service, tempDir, cleanups, sent, launched, quitRequested: () => quitRequested };
}

/** 构造 query 响应桩（text() 供 JSON 解析；下载用不到）。 */
function makeQueryResponse(releases) {
	return { ok: true, status: 200, headers: { get: () => null }, text: async () => releases, body: null };
}

/** 构造可放行的 gate：release() 前 read() 挂起，用于真实保持「downloading 期间」。 */
function makeGate() {
	let releaseGate;
	const gate = new Promise((resolveGate) => {
		releaseGate = resolveGate;
	});
	return { gate, release: () => releaseGate() };
}

/** 受控下载桩：首个 read() 等 gate 放行后吐一块数据再结束（其余同 makeBody 形状）。 */
function makeGatedNetFetch(gate) {
	const total = DOWNLOAD_CHUNKS.reduce((sum, chunk) => sum + chunk.length, 0);
	return async () => ({
		ok: true,
		status: 200,
		headers: { get: () => String(total) },
		body: {
			getReader() {
				let reads = 0;
				return {
					read: async () => {
						if (reads > 0) return { done: true, value: undefined };
						reads += 1;
						await gate;
						return { done: false, value: DOWNLOAD_CHUNKS[0] };
					},
				};
			},
		},
	});
}

const DOWNLOAD_CHUNKS = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];

test("query：dev 目标（当前 stable）返回 prerelease 最新并推 querying→available 快照", async (t) => {
	const prerelease = platformAsset("0.8.0-beta.1");
	const { service, sent } = makeService(t, { netFetch: async () => makeQueryResponse(releasesJson({ prereleaseVersion: "0.8.0-beta.1", stableVersion: "0.7.5" })) });
	const release = await service.queryTargetChannelLatest();
	assert.equal(release.version, "0.8.0-beta.1");
	assert.equal(release.assetName, prerelease.name);
	assert.equal(release.digestSha256, "sha256:deadbeef");
	assert.deepEqual(
		sent.map((snapshot) => snapshot.phase),
		["querying", "available"],
	);
	assert.equal(sent[1].target.version, "0.8.0-beta.1");
	// getStatus 与最后推送一致（get-status handler 数据源）。
	assert.equal(service.getStatus().phase, "available");
});

test("query：网络失败 → error 快照，含 releases 页退化入口，并向上抛出结构化错误", async (t) => {
	const { service, sent } = makeService(t, {
		netFetch: async () => {
			throw new Error("network down");
		},
	});
	await assert.rejects(service.queryTargetChannelLatest(), /network down/);
	assert.equal(sent.at(-1).phase, "error");
	assert.ok(sent.at(-1).error.includes(RELEASES_URL), `error 应含 ${RELEASES_URL}`);
});

test("download：进度百分比单调，完成后 ready 快照带 installerPath，文件内容为分块拼接", async (t) => {
	const asset = platformAsset("0.8.0-beta.1");
	const total = DOWNLOAD_CHUNKS.reduce((sum, chunk) => sum + chunk.length, 0);
	const { service, tempDir, sent } = makeService(t, {
		netFetch: async (url) => {
			assert.equal(url, asset.url);
			return { ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(total) : null) }, body: makeBody(DOWNLOAD_CHUNKS) };
		},
	});
	const installerPath = await service.downloadInstaller({ version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, releasePageUrl: RELEASES_URL });
	const expectedPath = join(tempDir, INSTALLER_TEMP_DIR, asset.name);
	assert.equal(installerPath, expectedPath);
	assert.deepEqual(readFileSync(installerPath), Buffer.concat(DOWNLOAD_CHUNKS.map((chunk) => Buffer.from(chunk))));
	// 快照终态：ready + installerPath + percent 100。
	const last = sent.at(-1);
	assert.equal(last.phase, "ready");
	assert.equal(last.installerPath, expectedPath);
	assert.equal(last.percent, 100);
	// 进度快照（downloading 阶段的 percent）单调不减。
	const percents = sent.filter((snapshot) => snapshot.phase === "downloading").map((snapshot) => snapshot.percent);
	assert.ok(percents.length >= 1, "应有下载进度快照");
	for (let index = 1; index < percents.length; index += 1) {
		assert.ok(percents[index] >= percents[index - 1], `percent 应单调：${percents}`);
	}
});

test("download：digest 匹配校验通过（sha256:hex 对上实际内容）", async (t) => {
	const asset = platformAsset("0.8.0-beta.1");
	const digest = `sha256:${createHash("sha256")
		.update(Buffer.concat(DOWNLOAD_CHUNKS.map((chunk) => Buffer.from(chunk))))
		.digest("hex")}`;
	const { service, sent } = makeService(t, {
		netFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody(DOWNLOAD_CHUNKS) }),
	});
	const installerPath = await service.downloadInstaller({ version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, digestSha256: digest, releasePageUrl: RELEASES_URL });
	assert.equal(sent.at(-1).phase, "ready");
	assert.ok(installerPath.length > 0);
});

test("download：digest 缺失跳过校验不报错；digest 不匹配 → error 快照且抛错", async (t) => {
	const asset = platformAsset("0.8.0-beta.1");
	const fetchOk = async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody(DOWNLOAD_CHUNKS) });

	// 缺失：跳过校验。
	const missing = makeService(t, { netFetch: fetchOk });
	await missing.service.downloadInstaller({ version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, releasePageUrl: RELEASES_URL });
	assert.equal(missing.sent.at(-1).phase, "ready");

	// 不匹配：报错 + error 快照。
	const mismatch = makeService(t, { netFetch: fetchOk });
	await assert.rejects(mismatch.service.downloadInstaller({ version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, digestSha256: "sha256:0000", releasePageUrl: RELEASES_URL }), /digest mismatch/);
	assert.equal(mismatch.sent.at(-1).phase, "error");
});

test("download 失败（网络错误）→ error 快照保留 target 并抛错", async (t) => {
	const asset = platformAsset("0.8.0-beta.1");
	const { service, sent } = makeService(t, {
		netFetch: async () => {
			throw new Error("socket hang up");
		},
	});
	await assert.rejects(service.downloadInstaller({ version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, releasePageUrl: RELEASES_URL }), /socket hang up/);
	const last = sent.at(-1);
	assert.equal(last.phase, "error");
	assert.equal(last.target?.version, "0.8.0-beta.1");
});

test("download 并发防护：downloading 期间重复 download 抛 busy，快照不被覆盖，完成后可再次下载", async (t) => {
	const asset = platformAsset("0.8.0-beta.1");
	const { release, gate } = makeGate();
	const { service, sent } = makeService(t, { netFetch: makeGatedNetFetch(gate) });
	const assetArg = { version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, releasePageUrl: RELEASES_URL };
	const first = service.downloadInstaller(assetArg);
	// 首个下载已同步进入 downloading 态（push 已发生）：重复调用立即 busy，且不推 error 快照覆盖进度。
	await assert.rejects(service.downloadInstaller(assetArg), /busy/);
	assert.equal(sent.at(-1).phase, "downloading");
	// 放行后首个下载正常完成（ready），单飞标志复位：再次下载可用。
	release();
	await first;
	assert.equal(sent.at(-1).phase, "ready");
	await service.downloadInstaller(assetArg);
	assert.equal(sent.at(-1).phase, "ready");
});

test("query 并发防护：downloading 期间 query 抛 busy，下载中快照不被 querying 覆盖", async (t) => {
	const asset = platformAsset("0.8.0-beta.1");
	const { release, gate } = makeGate();
	const { service, sent } = makeService(t, { netFetch: makeGatedNetFetch(gate) });
	const first = service.downloadInstaller({ version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, releasePageUrl: RELEASES_URL });
	await assert.rejects(service.queryTargetChannelLatest(), /busy/);
	// 快照仍停在下载进度，未被 querying/available/error 覆盖。
	assert.equal(sent.at(-1).phase, "downloading");
	release();
	await first;
	assert.equal(sent.at(-1).phase, "ready");
});

test("launch：spawnInstaller 后 quitApp（规格 §3：启动安装器并退出应用）", (t) => {
	const { service, launched, quitRequested } = makeService(t, {
		netFetch: async () => {
			throw new Error("unused");
		},
	});
	service.launchInstaller("C:/tmp/installer.exe");
	assert.deepEqual(launched, ["C:/tmp/installer.exe"]);
	assert.ok(quitRequested());
});

test("quit 清理已登记：执行后删除临时安装包目录", async (t) => {
	const asset = platformAsset("0.8.0-beta.1");
	const { service, tempDir, cleanups } = makeService(t, {
		netFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody(DOWNLOAD_CHUNKS) }),
	});
	await service.downloadInstaller({ version: "0.8.0-beta.1", notesExcerpt: "", assetUrl: asset.url, assetName: asset.name, releasePageUrl: RELEASES_URL });
	const cleanup = cleanups.find((item) => item.name === INSTALLER_TEMP_DIR);
	assert.ok(cleanup, "构造时应登记 INSTALLER_TEMP_DIR 清理");
	assert.equal(typeof cleanup.fn, "function");
	// 真断言（前后对比）：下载产物存在 → 清理后目录被删除。若清理失效（目录仍在），existsSync 为 true 即红灯。
	const installerDir = join(tempDir, INSTALLER_TEMP_DIR);
	assert.equal(existsSync(installerDir), true, "下载后安装包目录应存在");
	cleanup.fn();
	assert.equal(existsSync(installerDir), false, "清理后目录应被删除");
});

/**
 * pi-ai 模型目录更新器（PiAiCatalogUpdater）单测。
 *
 * 覆盖：双源下载与 fallback、manifest 校验拦截坏数据、覆盖层原子写入与 .bak 备份、
 * 一键还原、恢复上一个覆盖版、检查更新比对、状态汇总（含无效覆盖标记）。
 * 全部使用临时目录 + fetch 替身，不触网。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiAiCatalogUpdater, CATALOG_UPDATE_ALLOWED_BRANCHES } = loadTsCommonJs("src/main/pi/PiAiCatalogUpdater.ts");

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 构造一份合法的 artifact 对（catalog + manifest），包版本与 schemaVersion 可指定。 */
// 远端夹具版本必须高于内置目录版本：写入走版本防降级守卫（writeWithVersionGuard），
// 远端不高于当前生效版本（内置 resources manifest）时不覆盖写。用高位号，避免每次刷 catalog 都要改夹具。
const REMOTE_OLD = "9.8.1-remote";
const REMOTE_NEW = "9.8.2-remote";
const REMOTE_NEWEST = "9.8.3-remote";

function makeArtifact(packageVersion = "9.9.9-remote", schemaVersion = 2) {
	const entries = [
		{ id: "overlay-alpha", name: "Overlay Alpha", provider: "demo", contextWindow: 1000 },
		{ id: "overlay-beta", name: "Overlay Beta", provider: "demo", contextWindow: 2000, reasoning: true },
	];
	const catalogRaw = JSON.stringify({ schemaVersion, entries });
	const manifestRaw = JSON.stringify({
		schemaVersion,
		catalogSha256: sha256(catalogRaw),
		entryCount: entries.length,
		source: {
			packageName: "@earendil-works/pi-ai",
			packageVersion,
			dataSha256: "a".repeat(64),
			fileCount: 1,
		},
	});
	return { catalogRaw, manifestRaw, entryCount: entries.length };
}

function okResponse(text) {
	return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

/**
 * fetch 替身：按 URL 识别 manifest/catalog 与源（jsDelivr 主源 / raw 备源）。
 * options.failCatalogOnCdn=true 时主源 catalog 抛错，用于测备源 fallback。
 */
function makeFetch(artifact, options = {}) {
	return async (url) => {
		const isCdn = url.includes("cdn.jsdelivr.net");
		const isManifest = url.includes(".manifest.");
		if (isManifest && isCdn && options.failManifestOnCdn) throw new Error("cdn manifest down");
		if (!isManifest && isCdn && options.failCatalogOnCdn) throw new Error("cdn catalog down");
		// 只接受已知两个源，陌生 URL 视为注入/拼错
		if (!isCdn && !url.includes("raw.githubusercontent.com")) throw new Error(`unexpected url ${url}`);
		return okResponse(isManifest ? artifact.manifestRaw : artifact.catalogRaw);
	};
}

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pideck-catalog-update-"));
}

function cleanup(dir) {
	rmSync(dir, { recursive: true, force: true });
}

test("catalog:update 成功：写入覆盖层并生效，状态可见", async () => {
	const dir = tempDir();
	try {
		const artifact = makeArtifact(REMOTE_OLD);
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeFetch(artifact),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.ok(existsSync(join(dir, "pi-ai-catalog.json")));
		assert.ok(existsSync(join(dir, "pi-ai-catalog.manifest.json")));
		// 首次更新无备份
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json.bak")), false);
		const status = updater.getStatus();
		assert.equal(status.overlay?.packageVersion, REMOTE_OLD);
		assert.equal(status.overlay?.entryCount, artifact.entryCount);
		// builtin 来自真实 resources（开发态 cwd 项目根可解析到），只要求非空结构
		assert.notEqual(status.builtin, null);
		assert.equal(status.hasOverlayFiles, true);
		assert.equal(status.hasBackup, false);
	} finally {
		cleanup(dir);
	}
});

test("catalog:update 覆盖已有覆盖层：旧文件备份为 .bak", async () => {
	const dir = tempDir();
	try {
		const artifact = makeArtifact(REMOTE_OLD);
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(artifact), timeoutMs: 200 });
		await updater.update("main");
		const next = makeArtifact(REMOTE_NEW);
		await new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(next), timeoutMs: 200 }).update("main");
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json.bak")), true);
		assert.equal(readFileSync(join(dir, "pi-ai-catalog.json.bak"), "utf8"), artifact.catalogRaw);
		assert.equal(updater.getStatus().overlay?.packageVersion, REMOTE_NEW);
	} finally {
		cleanup(dir);
	}
});

test("catalog:update 主源 catalog 失败：换备源成功", async () => {
	const dir = tempDir();
	try {
		const artifact = makeArtifact("9.9.9-remote");
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeFetch(artifact, { failCatalogOnCdn: true }),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(updater.getStatus().overlay?.packageVersion, "9.9.9-remote");
	} finally {
		cleanup(dir);
	}
});

test("catalog:update 全部源失败：返回 network 且不写任何文件", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: async () => {
				throw new Error("socket down");
			},
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, false);
		assert.equal(result.code, "network");
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json")), false);
		assert.equal(existsSync(join(dir, "pi-ai-catalog.manifest.json")), false);
	} finally {
		cleanup(dir);
	}
});

test("catalog:update manifest 与内容不匹配：返回 validation 且不写文件", async () => {
	const dir = tempDir();
	try {
		// 篡改：manifest 哈希对不上内容
		const artifact = makeArtifact("9.9.9-remote");
		artifact.catalogRaw = artifact.catalogRaw.replace("overlay-alpha", "tampered-alpha");
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeFetch(artifact),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, false);
		assert.equal(result.code, "validation");
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json")), false);
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json.bak")), false);
	} finally {
		cleanup(dir);
	}
});

test("catalog:restoreBuiltin 有覆盖时：覆盖文件转 .bak 回到内置", async () => {
	const dir = tempDir();
	try {
		const artifact = makeArtifact(REMOTE_OLD);
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(artifact), timeoutMs: 200 });
		await updater.update("main");
		const result = updater.restoreBuiltin();
		assert.equal(result.ok, true);
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json")), false);
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json.bak")), true);
		const status = updater.getStatus();
		assert.equal(status.overlay, null);
		assert.equal(status.hasOverlayFiles, false);
		assert.equal(status.hasBackup, true);
	} finally {
		cleanup(dir);
	}
});

test("catalog:restoreBuiltin 无覆盖时：视为成功（幂等）", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(makeArtifact()), timeoutMs: 200 });
		assert.equal(updater.restoreBuiltin().ok, true);
		assert.equal(updater.getStatus().hasOverlayFiles, false);
	} finally {
		cleanup(dir);
	}
});

test("catalog:restorePrevious 从 .bak 恢复；无备份返回 no-backup", async () => {
	const dir = tempDir();
	try {
		const artifact = makeArtifact(REMOTE_OLD);
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(artifact), timeoutMs: 200 });
		await updater.update("main");
		const newer = makeArtifact(REMOTE_NEWEST);
		await new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(newer), timeoutMs: 200 }).update("main");
		// 回滚到 9.8.1
		const result = updater.restorePrevious();
		assert.equal(result.ok, true);
		assert.equal(updater.getStatus().overlay?.packageVersion, REMOTE_OLD);
		// 再恢复一次：.bak 已是 9.8.1，与当前一致仍视为成功（幂等可失败语义：有备份即恢复）
		const second = updater.restorePrevious();
		assert.equal(second.ok, true);
		// 换一个无备份目录：no-backup
		const emptyDir = tempDir();
		try {
			const emptyUpdater = new PiAiCatalogUpdater({ userDataDir: emptyDir, fetchImpl: makeFetch(artifact), timeoutMs: 200 });
			const missing = emptyUpdater.restorePrevious();
			assert.equal(missing.ok, false);
			assert.equal(missing.code, "no-backup");
		} finally {
			cleanup(emptyDir);
		}
	} finally {
		cleanup(dir);
	}
});

test("catalog:checkRemote 版本不同 = hasUpdate；相同 = 最新；网络失败 = network", async () => {
	const dir = tempDir();
	try {
		// 远端 2.0.0，本地（真实内置 0.85.0 或覆盖）不同 → hasUpdate
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(makeArtifact("2.0.0-remote")), timeoutMs: 200 });
		const checked = await updater.checkRemote("main");
		assert.equal(checked.ok, true);
		assert.equal(checked.hasUpdate, true);
		assert.equal(checked.remoteVersion, "2.0.0-remote");
		// 版本一致场景：先更新到 2.0.0，再查同名远端
		await updater.update("main");
		const same = await updater.checkRemote("main");
		assert.equal(same.ok, true);
		assert.equal(same.hasUpdate, false);
		// 网络失败
		const offline = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: async () => {
				throw new Error("offline");
			},
			timeoutMs: 200,
		});
		const failed = await offline.checkRemote("main");
		assert.equal(failed.ok, false);
		assert.equal(failed.code, "network");
	} finally {
		cleanup(dir);
	}
});

test("catalog:update 远端 schemaVersion 高于本地支持：返回 incompatible（不是 validation）且不写文件", async () => {
	const dir = tempDir();
	try {
		// issue #343 回归：main 若先发了 v3 产物而读端还没放宽，必须提示「需先升级 PiDeck」，
		// 不能共用 validation 报成误导性的「仓库文件可能异常」。
		const artifact = makeArtifact("9.9.9-remote", 3);
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(artifact), timeoutMs: 200 });
		const result = await updater.update("main");
		assert.equal(result.ok, false);
		assert.equal(result.code, "incompatible");
		assert.match(result.message, /schemaVersion 3/);
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json")), false);
		assert.equal(existsSync(join(dir, "pi-ai-catalog.manifest.json")), false);
	} finally {
		cleanup(dir);
	}
});

test("catalog:checkRemote 远端 schemaVersion 与本地不等（新或旧）：返回 incompatible", async () => {
	const dir = tempDir();
	try {
		const newer = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(makeArtifact("9.9.9-remote", 3)), timeoutMs: 200 });
		const checked = await newer.checkRemote("main");
		assert.equal(checked.ok, false);
		assert.equal(checked.code, "incompatible");
		assert.match(checked.message, /schemaVersion 3/);
		// 远端更旧（v1）同样算不兼容：读端只接受等值
		const older = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(makeArtifact("9.9.9-remote", 1)), timeoutMs: 200 });
		const olderChecked = await older.checkRemote("main");
		assert.equal(olderChecked.ok, false);
		assert.equal(olderChecked.code, "incompatible");
	} finally {
		cleanup(dir);
	}
});

test("catalog:getStatus 无效覆盖文件：overlay=null 且 hasOverlayFiles=true（提示还原）", async () => {
	const dir = tempDir();
	try {
		// 预置一份篡改的覆盖文件（哈希不匹配）
		const artifact = makeArtifact("9.9.9-remote");
		writeFileSync(join(dir, "pi-ai-catalog.json"), artifact.catalogRaw.replace("overlay-alpha", "x"), "utf8");
		writeFileSync(join(dir, "pi-ai-catalog.manifest.json"), artifact.manifestRaw, "utf8");
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(artifact), timeoutMs: 200 });
		const status = updater.getStatus();
		assert.equal(status.overlay, null);
		assert.equal(status.hasOverlayFiles, true);
	} finally {
		cleanup(dir);
	}
});

test("catalog: 分支白名单存在 main/dev", () => {
	assert.ok(CATALOG_UPDATE_ALLOWED_BRANCHES.includes("main"));
	assert.ok(CATALOG_UPDATE_ALLOWED_BRANCHES.includes("dev"));
});

test("catalog:resolveEffectiveCatalogPath 覆盖层优先，无覆盖回落内置", async () => {
	const dir = tempDir();
	try {
		// 无覆盖：回落内置（开发态 cwd 项目 resources 真实存在）
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(makeArtifact()), timeoutMs: 200 });
		const builtinPath = updater.resolveEffectiveCatalogPath();
		assert.notEqual(builtinPath, null);
		assert.ok(builtinPath.endsWith("pi-ai-catalog.json"));
		// 覆盖后：指向 userData 覆盖层
		await updater.update("main");
		const overlayPath = updater.resolveEffectiveCatalogPath();
		assert.equal(overlayPath, join(dir, "pi-ai-catalog.json"));
	} finally {
		cleanup(dir);
	}
});

test("catalog: 无效覆盖时 openFile 解析回落内置（不指向坏文件）", async () => {
	const dir = tempDir();
	try {
		const artifact = makeArtifact("9.9.9-remote");
		// 预置损坏覆盖文件（内容与 manifest 不匹配）
		writeFileSync(join(dir, "pi-ai-catalog.json"), '{"schemaVersion":2,"entries":[]}', "utf8");
		writeFileSync(join(dir, "pi-ai-catalog.manifest.json"), artifact.manifestRaw, "utf8");
		const updater = new PiAiCatalogUpdater({ userDataDir: dir, fetchImpl: makeFetch(artifact), timeoutMs: 200 });
		const path = updater.resolveEffectiveCatalogPath();
		assert.notEqual(path, null);
		assert.equal(path.endsWith("pi-ai-catalog.json"), true);
		assert.equal(path.includes(dir), false, "坏的覆盖层不应被打开，应指向内置");
	} finally {
		cleanup(dir);
	}
});

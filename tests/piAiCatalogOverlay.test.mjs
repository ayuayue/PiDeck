/**
 * pi-ai 模型目录覆盖层读取优先级单测。
 *
 * 覆盖：setPiAiCatalogUserDataDir 后 getPiAiCatalogIndex 优先读覆盖层；
 * 覆盖层无效（校验失败）自动落回内置 resources；还原（目录切换）后索引
 * 缓存失效并重新加载。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const catalog = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");
const {
	PI_AI_CATALOG_MANIFEST_FILE_NAME,
	getPiAiCatalogIndex,
	invalidatePiAiCatalogIndex,
	loadPiAiCatalogEntries,
	parsePiAiCatalogArtifact,
	resetPiAiCatalogIndexForTests,
	resolvePiAiCatalogArtifactCandidates,
	setPiAiCatalogUserDataDir,
} = catalog;

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 写一份覆盖层 artifact 到 dir，返回条目数。 */
function writeOverlay(dir, packageVersion = "9.9.9-overlay") {
	const entries = [
		{ id: "overlay-only", name: "Overlay Only", provider: "demo", contextWindow: 999 },
	];
	const catalogRaw = JSON.stringify({ schemaVersion: 1, entries });
	const manifestRaw = JSON.stringify({
		schemaVersion: 1,
		catalogSha256: sha256(catalogRaw),
		entryCount: entries.length,
		source: {
			packageName: "@earendil-works/pi-ai",
			packageVersion,
			dataSha256: "b".repeat(64),
			fileCount: 1,
		},
	});
	writeFileSync(join(dir, "pi-ai-catalog.json"), catalogRaw, "utf8");
	writeFileSync(join(dir, PI_AI_CATALOG_MANIFEST_FILE_NAME), manifestRaw, "utf8");
	return entries.length;
}

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pideck-catalog-overlay-"));
}

test("getPiAiCatalogIndex 覆盖层优先：返回覆盖层条目", () => {
	// 先重置全局状态，避免其它测试残留（模块级 single-file，仅本文件共享）
	setPiAiCatalogUserDataDir(undefined);
	resetPiAiCatalogIndexForTests();
	const overlayDir = tempDir();
	try {
		const count = writeOverlay(overlayDir, "9.9.9-overlay");
		setPiAiCatalogUserDataDir(overlayDir);
		const index = getPiAiCatalogIndex();
		assert.equal(index.entries.length, count);
		assert.ok(index.byProviderId.get("demo")?.has("overlay-only"));
	} finally {
		setPiAiCatalogUserDataDir(undefined);
		resetPiAiCatalogIndexForTests();
		rmSync(overlayDir, { recursive: true, force: true });
	}
});

test("覆盖层无效（哈希不匹配）时自动落回内置", () => {
	setPiAiCatalogUserDataDir(undefined);
	resetPiAiCatalogIndexForTests();
	const overlayDir = tempDir();
	try {
		// 篡改内容使 manifest 哈希不匹配
		writeOverlay(overlayDir, "9.9.9-overlay");
		writeFileSync(join(overlayDir, "pi-ai-catalog.json"), '{"schemaVersion":1,"entries":[]}', "utf8");
		setPiAiCatalogUserDataDir(overlayDir);
		const index = getPiAiCatalogIndex();
		// 内置 resources 真实存在（>=1290 条旧目录基线…… 以存在且>1000 断言）
		assert.ok(index.entries.length > 1000, `expected builtin fallback, got ${index.entries.length}`);
		// 覆盖层的 overlay-only 不应混入
		assert.equal(index.byProviderId.get("demo")?.has("overlay-only"), undefined);
	} finally {
		setPiAiCatalogUserDataDir(undefined);
		resetPiAiCatalogIndexForTests();
		rmSync(overlayDir, { recursive: true, force: true });
	}
});

test("invalidatePiAiCatalogIndex 后重新读取", () => {
	setPiAiCatalogUserDataDir(undefined);
	resetPiAiCatalogIndexForTests();
	const first = getPiAiCatalogIndex();
	const overlayDir = tempDir();
	try {
		writeOverlay(overlayDir, "9.9.9-overlay");
		setPiAiCatalogUserDataDir(overlayDir);
		invalidatePiAiCatalogIndex();
		const second = getPiAiCatalogIndex();
		assert.equal(second.entries.length, 1);
	} finally {
		setPiAiCatalogUserDataDir(undefined);
		resetPiAiCatalogIndexForTests();
		rmSync(overlayDir, { recursive: true, force: true });
	}
});

test("loadPiAiCatalogEntries 候选列表：首个有效候选生效，坏候选跳过", () => {
	const badDir = tempDir();
	const goodDir = tempDir();
	try {
		writeFileSync(join(badDir, "pi-ai-catalog.json"), "not json", "utf8");
		writeFileSync(join(badDir, PI_AI_CATALOG_MANIFEST_FILE_NAME), "not json", "utf8");
		writeOverlay(goodDir, "9.9.9-overlay");
		const entries = loadPiAiCatalogEntries([
			{ catalogPath: join(badDir, "pi-ai-catalog.json"), manifestPath: join(badDir, PI_AI_CATALOG_MANIFEST_FILE_NAME) },
			{ catalogPath: join(goodDir, "pi-ai-catalog.json"), manifestPath: join(goodDir, PI_AI_CATALOG_MANIFEST_FILE_NAME) },
		]);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].id, "overlay-only");
	} finally {
		rmSync(badDir, { recursive: true, force: true });
		rmSync(goodDir, { recursive: true, force: true });
	}
});

test("resolvePiAiCatalogArtifactCandidates：覆盖层在 resources 前（注入目录后）", () => {
	setPiAiCatalogUserDataDir(undefined);
	resetPiAiCatalogIndexForTests();
	const overlayDir = tempDir();
	try {
		writeOverlay(overlayDir, "9.9.9-overlay");
		setPiAiCatalogUserDataDir(overlayDir);
		const candidates = resolvePiAiCatalogArtifactCandidates();
		assert.ok(candidates.length >= 1);
		assert.ok(candidates[0].catalogPath.includes("pi-ai-catalog.json"));
		assert.equal(candidates[0].catalogPath.includes(tmpdir()), true, "首个候选应为 userData 覆盖层");
	} finally {
		setPiAiCatalogUserDataDir(undefined);
		resetPiAiCatalogIndexForTests();
		rmSync(overlayDir, { recursive: true, force: true });
	}
});

test("parsePiAiCatalogArtifact 对覆盖层产物与内置同标准（回归）", () => {
	const overlayDir = tempDir();
	try {
		const raw = writeOverlay(overlayDir, "9.9.9-overlay");
		const entries = parsePiAiCatalogArtifact(
			readFileSync(join(overlayDir, "pi-ai-catalog.json"), "utf8"),
			readFileSync(join(overlayDir, PI_AI_CATALOG_MANIFEST_FILE_NAME), "utf8"),
		);
		assert.equal(entries.length, raw);
	} finally {
		rmSync(overlayDir, { recursive: true, force: true });
	}
});

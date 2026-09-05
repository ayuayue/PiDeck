import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	generatePiAiCatalog,
	PI_AI_CATALOG_FILE_NAME,
	PI_AI_CATALOG_MANIFEST_FILE_NAME,
	sha256,
} from "../scripts/generate-pi-ai-catalog.mjs";

function createPiAiFixture(root) {
	const sourceDir = join(root, "pi-ai");
	const dataDir = join(sourceDir, "dist", "providers", "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(sourceDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-ai", version: "9.9.9-test" }),
	);
	// 文件名倒序写入，生成器必须自行排序为 a.json → z.json。
	writeFileSync(
		join(dataDir, "z.json"),
		JSON.stringify({
			"openai-completions": {
				zeta: {
					id: "zeta",
					provider: "demo",
					contextWindow: 0,
					input: ["text", "audio", "image"],
					cost: { input: 999 },
					compat: { shouldNotShip: true },
				},
			},
		}),
	);
	writeFileSync(
		join(dataDir, "a.json"),
		JSON.stringify({
			"openai-completions": {
				alpha: {
					id: "alpha",
					name: " Alpha ",
					provider: "demo",
					api: "openai-completions",
					baseUrl: "https://example.test/v1 ",
					contextWindow: 128000,
					maxTokens: 8192,
					reasoning: true,
					input: ["text", "image", "video"],
					thinkingLevelMap: { off: null, high: "high", future: "keep-for-runtime-validation" },
					cost: { input: 123 },
				},
				invalid: { provider: "demo" },
			},
		}),
	);
	return sourceDir;
}

test("生成器裁剪 pi-ai catalog、写入可验证的确定性 artifact", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ai-catalog-"));
	try {
		const sourceDir = createPiAiFixture(root);
		const outDir = join(root, "resources");
		const first = generatePiAiCatalog({ sourceDir, outDir });
		assert.equal(first.ok, true);
		assert.equal(first.changed, true);
		assert.equal(first.sourceVersion, "9.9.9-test");
		assert.equal(first.entryCount, 2);

		const catalogPath = join(outDir, PI_AI_CATALOG_FILE_NAME);
		const manifestPath = join(outDir, PI_AI_CATALOG_MANIFEST_FILE_NAME);
		const catalogRaw = readFileSync(catalogPath, "utf8");
		const catalog = JSON.parse(catalogRaw);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		assert.deepEqual(catalog, {
			schemaVersion: 1,
			entries: [
				{
					id: "alpha",
					name: " Alpha ",
					provider: "demo",
					api: "openai-completions",
					baseUrl: "https://example.test/v1 ",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 128000,
					maxTokens: 8192,
					thinkingLevelMap: { off: null, high: "high", future: "keep-for-runtime-validation" },
				},
				{ id: "zeta", provider: "demo", input: ["text", "image"] },
			],
		});
		assert.equal(manifest.source.packageName, "@earendil-works/pi-ai");
		assert.equal(manifest.source.packageVersion, "9.9.9-test");
		assert.equal(manifest.source.fileCount, 2);
		assert.equal(manifest.entryCount, 2);
		assert.equal(manifest.catalogSha256, sha256(catalogRaw));

		const before = `${catalogRaw}\n${readFileSync(manifestPath, "utf8")}`;
		const second = generatePiAiCatalog({ sourceDir, outDir });
		assert.equal(second.changed, false, "相同输入不应产生资源 churn");
		assert.equal(
			`${readFileSync(catalogPath, "utf8")}\n${readFileSync(manifestPath, "utf8")}`,
			before,
		);
		assert.equal(generatePiAiCatalog({ sourceDir, outDir, check: true }).ok, true);

		writeFileSync(catalogPath, "tampered\n");
		assert.equal(generatePiAiCatalog({ sourceDir, outDir, check: true }).ok, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("生成器拒绝缺失或损坏的上游 catalog", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ai-catalog-invalid-"));
	try {
		assert.throws(
			() => generatePiAiCatalog({ sourceDir: join(root, "missing"), outDir: join(root, "out") }),
			/package\.json not found/,
		);

		const sourceDir = createPiAiFixture(root);
		writeFileSync(join(sourceDir, "dist", "providers", "data", "broken.json"), "{not-json");
		assert.throws(
			() => generatePiAiCatalog({ sourceDir, outDir: join(root, "out") }),
			/failed to parse pi-ai catalog file broken\.json/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

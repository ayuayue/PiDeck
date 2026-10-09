import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePiAiCatalog, PI_AI_CATALOG_FILE_NAME, PI_AI_CATALOG_MANIFEST_FILE_NAME, sha256 } from "../scripts/generate-pi-ai-catalog.mjs";

function createPiAiFixture(root) {
	const sourceDir = join(root, "pi-ai");
	const dataDir = join(sourceDir, "dist", "providers", "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "9.9.9-test" }));
	// 文件名倒序写入，生成器必须自行排序为 a.json → z.json。
	writeFileSync(
		join(dataDir, "z.json"),
		JSON.stringify({
			"openrouter-images": {
				"image:zeta": {
					type: "image",
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
				"chat:alpha": {
					type: "chat",
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

/**
 * 生成器透传官方字段、写入可验证的确定性 artifact 单测。
 *
 * 核心契约（2026-10 变更）：不再按白名单裁剪字段。旧版只留 9 个字段，把 `type`
 * 一并丢掉，导致 image / classifier 模型混进聊天能力补全，且每次要用新字段都得改
 * 一次生成器。现在条目按官方原字段透传（含 type / cost / compat 等），只做最小
 * 结构校验（无 id 丢弃）与紧凑序列化。
 */
test("生成器透传官方全字段、不再白名单裁剪", () => {
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
		assert.equal(catalog.schemaVersion, 2, "schemaVersion 2 = 全字段产物；v1 产物无法在读取时区分模型类型");
		assert.deepEqual(catalog, {
			schemaVersion: 2,
			entries: [
				{
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
					// 下列字段在旧版白名单里被丢弃；现在必须原样保留，供将来消费。
					type: "chat",
					cost: { input: 123 },
				},
				{ id: "zeta", provider: "demo", type: "image", contextWindow: 0, input: ["text", "audio", "image"], cost: { input: 999 }, compat: { shouldNotShip: true } },
			],
		});
		assert.equal(manifest.schemaVersion, 2);
		assert.equal(manifest.source.packageName, "@earendil-works/pi-ai");
		assert.equal(manifest.source.packageVersion, "9.9.9-test");
		assert.equal(manifest.source.fileCount, 2);
		assert.equal(manifest.entryCount, 2);
		assert.equal(manifest.catalogSha256, sha256(catalogRaw));
		// 紧凑序列化：条目现在带官方全字段，缩进会让产物从 ~0.9MB 膨胀到 ~1.7MB。
		assert.equal(catalogRaw.includes("\n  "), false, "产物必须紧凑序列化");

		const before = `${catalogRaw}\n${readFileSync(manifestPath, "utf8")}`;
		const second = generatePiAiCatalog({ sourceDir, outDir });
		assert.equal(second.changed, false, "相同输入不应产生资源 churn");
		assert.equal(`${readFileSync(catalogPath, "utf8")}\n${readFileSync(manifestPath, "utf8")}`, before);
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
		assert.throws(() => generatePiAiCatalog({ sourceDir: join(root, "missing"), outDir: join(root, "out") }), /package\.json not found/);

		const sourceDir = createPiAiFixture(root);
		writeFileSync(join(sourceDir, "dist", "providers", "data", "broken.json"), "{not-json");
		assert.throws(() => generatePiAiCatalog({ sourceDir, outDir: join(root, "out") }), /failed to parse pi-ai catalog file broken\.json/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

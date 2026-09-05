import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { generatePiAiCatalog } from "../scripts/generate-pi-ai-catalog.mjs";

const CATALOG_RESOURCE = "pi-ai-catalog.json";
const MANIFEST_RESOURCE = "pi-ai-catalog.manifest.json";

test("PiDeck 将主进程 pi-ai catalog 作为构建期资源分发", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(
		pkg.dependencies?.["@earendil-works/pi-ai"],
		undefined,
		"主进程不应以 production dependency 携带完整 pi-ai SDK",
	);
	assert.equal(
		pkg.devDependencies?.["@earendil-works/pi-ai"],
		"0.85.0",
		"构建期输入必须精确锁定，避免 catalog 静默漂移",
	);
	assert.match(pkg.scripts?.build ?? "", /generate:pi-ai-catalog/);
	assert.match(pkg.scripts?.["build:fast"] ?? "", /generate:pi-ai-catalog/);

	const resourceTargets = new Set((pkg.build?.extraResources ?? []).map((entry) => entry.to));
	assert.equal(resourceTargets.has(CATALOG_RESOURCE), true);
	assert.equal(resourceTargets.has(MANIFEST_RESOURCE), true);
	assert.equal(existsSync(join("resources", CATALOG_RESOURCE)), true);
	assert.equal(existsSync(join("resources", MANIFEST_RESOURCE)), true);
	assert.equal(
		generatePiAiCatalog({ check: true }).ok,
		true,
		"提交的 artifact 必须与精确锁定的 pi-ai 输入一致",
	);
});

test("主进程 catalog loader 不再从 node_modules 探测 pi-ai 数据", () => {
	const source = readFileSync("src/main/pi/piAiBuiltinCatalog.ts", "utf8");
	assert.doesNotMatch(source, /resolvePiAiCatalogDataDir/);
	assert.doesNotMatch(source, /"@earendil-works", "pi-ai", "dist", "providers", "data"/);
	assert.match(source, /pi-ai-catalog\.json/);
	assert.match(source, /pi-ai-catalog\.manifest\.json/);

	const verifier = readFileSync("scripts/verify-asar-runtime.js", "utf8");
	assert.match(verifier, /pi-ai-catalog\.json/);
	assert.match(verifier, /pi-ai-catalog\.manifest\.json/);
	assert.match(verifier, /catalog 来源 pi-ai/);

	const analyzer = readFileSync("scripts/analyze-asar-waste.js", "utf8");
	assert.doesNotMatch(analyzer, /"@earendil-works\/pi-ai",/);
	assert.match(analyzer, /asar 内实际打入的 package\.json/);

	const fastPack = readFileSync("scripts/dist-fast.js", "utf8");
	assert.match(fastPack, /npm run build:fast/);
});

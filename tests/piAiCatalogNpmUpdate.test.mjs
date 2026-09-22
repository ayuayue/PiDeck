/**
 * pi-ai 目录更新单测（分支主源 + 镜像代理 + npm 回退 + 防降级）。
 *
 * 背景：目录下载/检测原以 npm latest 为主源，但 npm 数据文件走 jsDelivr CDN，
 * 国内不稳定；且 npm registry 与仓库分支 manifest 可能错位（分支已推 0.85.1
 * 而 npm latest 仍是 0.85.0）。修复：主源改为仓库分支预生成件（直连或经
 * GitHub 镜像代理，与应用更新同源），分支全挂时回退 npm latest；版本比较
 * 仍用语义版本，远端不高于当前生效版本时 hasUpdate=false / update 不写（防降级）。
 *
 * 测试用 fetch 替身模拟分支 manifest/catalog、镜像代理 URL、npm registry + jsDelivr，不触网。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiAiCatalogUpdater } = loadTsCommonJs("src/main/pi/PiAiCatalogUpdater.ts");
const { generatePiAiCatalogFromFiles } = loadTsCommonJs("src/main/pi/piAiCatalogGenerate.ts");

function okResponse(text) {
	return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

/**
 * AtomGit OpenAPI contents 响应：base64 信封装文件内容。
 * 客户端必须解码信封才能拿到文件正文（直接当文本用会 JSON.parse 失败）。
 */
function contentsEnvelopeResponse(text) {
	return okResponse(
		JSON.stringify({
			type: "file",
			encoding: "base64",
			content: Buffer.from(text, "utf8").toString("base64"),
		}),
	);
}

/** 构造一份合法的来源数据文件内容（{ group: { modelId: model } }）。 */
function demoDataFileContent(modelId = "model-a") {
	return JSON.stringify({
		demo: {
			[modelId]: {
				id: modelId,
				name: "Model A",
				provider: "demo",
				contextWindow: 1000,
			},
		},
	});
}

/**
 * npm 源 fetch 替身：只认识 npm registry latest、jsDelivr flat 列表、jsDelivr 单文件。
 * version 为 latest 返回的版本号；dataFiles 为 flat 列表里的文件名（不含目录前缀）。
 */
function makeNpmFetch(version, dataFiles) {
	return async (url) => {
		if (url.includes("registry.npmmirror.com") || url.includes("registry.npmjs.org")) {
			if (!url.endsWith("/latest")) throw new Error(`unexpected npm url ${url}`);
			return okResponse(JSON.stringify({ version }));
		}
		if (url.includes("data.jsdelivr.com") && url.endsWith("/flat")) {
			const files = dataFiles.map((name) => ({ name: `/dist/providers/data/${name}` }));
			return okResponse(JSON.stringify({ files }));
		}
		if (url.includes("cdn.jsdelivr.net")) {
			const after = url.split("pi-ai@")[1] ?? "";
			const name = after.split("/").slice(1).join("/"); // dist/providers/data/<file>
			const file = name.slice("dist/providers/data/".length);
			if (!dataFiles.includes(file)) throw new Error(`unexpected file ${url}`);
			return okResponse(demoDataFileContent(file));
		}
		throw new Error(`unexpected url ${url}`);
	};
}

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pideck-catalog-npm-"));
}

function cleanup(dir) {
	rmSync(dir, { recursive: true, force: true });
}

test("catalog:update npm latest 高于本地（9.9.9）：写入覆盖层并生效", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("9.9.9", ["demo.json"]),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, true);
		const status = updater.getStatus();
		assert.equal(status.overlay?.packageVersion, "9.9.9");
		assert.equal(status.overlay?.entryCount, 1);
		assert.ok(existsSync(join(dir, "pi-ai-catalog.json")));
	} finally {
		cleanup(dir);
	}
});

test("catalog: 防降级 —— npm latest 0.85.0 不高于本地内置 0.85.1：不写不覆盖", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("0.85.0", ["demo.json"]),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, false, "远端不高于本地时不得覆盖写");
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json")), false, "未发生降级写，仍用内置");
		assert.equal(existsSync(join(dir, "pi-ai-catalog.manifest.json")), false);
	} finally {
		cleanup(dir);
	}
});

test("catalog: 检查更新 —— 远端 0.85.0 相对本地 0.85.1 应 hasUpdate=false（修掉误报降级）", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("0.85.0", ["demo.json"]),
			timeoutMs: 200,
		});
		const checked = await updater.checkRemote("main");
		assert.equal(checked.ok, true);
		assert.equal(checked.remoteVersion, "0.85.0");
		assert.equal(checked.hasUpdate, false, "0.85.0 比本地 0.85.1 旧，不应报新版本");
	} finally {
		cleanup(dir);
	}
});

test("catalog: 检查更新 —— 远端 9.9.9 高于本地应 hasUpdate=true", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("9.9.9", ["demo.json"]),
			timeoutMs: 200,
		});
		const checked = await updater.checkRemote("main");
		assert.equal(checked.ok, true);
		assert.equal(checked.remoteVersion, "9.9.9");
		assert.equal(checked.hasUpdate, true);
	} finally {
		cleanup(dir);
	}
});

test("catalog: 已有覆盖层时，npm latest 不高于覆盖层也不覆盖", async () => {
	const dir = tempDir();
	try {
		// 先用分支回退源写入一个高版本覆盖层，再验证 npm 低版本不覆盖。
		// 这里直接用一个能写覆盖层的路径：npm 9.9.9 写入。
		const newer = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("9.9.9", ["demo.json"]),
			timeoutMs: 200,
		});
		await newer.update("main");
		// 再模拟 npm 返回 1.0.0（低于覆盖层 9.9.9）：不得覆盖。
		const downgrade = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("1.0.0", ["demo.json"]),
			timeoutMs: 200,
		});
		const result = await downgrade.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, false);
		assert.equal(downgrade.getStatus().overlay?.packageVersion, "9.9.9", "覆盖层仍为更高版本");
	} finally {
		cleanup(dir);
	}
});

/**
 * 分支源 fetch 替身：认识 GitHub raw 与镜像代理前缀两种 manifest/catalog URL，
 * 其它 URL 一律抛错（模拟分支源是主路径、npm 源未接通的场景）。
 */
function makeBranchFetch(catalogText, manifestText) {
	return async (url) => {
		if (url.endsWith("pi-ai-catalog.manifest.json")) return okResponse(manifestText);
		if (url.endsWith("pi-ai-catalog.json")) return okResponse(catalogText);
		throw new Error(`unexpected branch url ${url}`);
	};
}

/** 用来源文件生成一份合法的 catalog/manifest 对（版本号可指定）。 */
function generateArtifact(version, modelId = "model-a") {
	return generatePiAiCatalogFromFiles([{ name: "demo.json", content: demoDataFileContent(modelId) }], version);
}

test("catalog:update 走仓库分支预生成件（主源，直连 GitHub raw）", async () => {
	const dir = tempDir();
	try {
		const { catalogText, manifestText } = generateArtifact("9.9.9");
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeBranchFetch(catalogText, manifestText),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, true, "分支源高于本地内置时应写入覆盖层");
		assert.equal(updater.getStatus().overlay?.packageVersion, "9.9.9");
	} finally {
		cleanup(dir);
	}
});

test("catalog:checkRemote 走仓库分支 manifest（主源）", async () => {
	const dir = tempDir();
	try {
		const { catalogText, manifestText } = generateArtifact("9.9.9");
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeBranchFetch(catalogText, manifestText),
			timeoutMs: 200,
		});
		const checked = await updater.checkRemote("main");
		assert.equal(checked.ok, true);
		assert.equal(checked.remoteVersion, "9.9.9", "检测远端应取分支 manifest 版本");
		assert.equal(checked.hasUpdate, true);
	} finally {
		cleanup(dir);
	}
});

test("catalog: 镜像源（atomgit）优先走 AtomGit contents API 并生效", async () => {
	const dir = tempDir();
	try {
		const { catalogText, manifestText } = generateArtifact("9.9.9");
		const seen = [];
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			source: () => "atomgit",
			fetchImpl: async (url) => {
				seen.push(url);
				if (url.includes("pi-ai-catalog.manifest.json")) return contentsEnvelopeResponse(manifestText);
				if (url.includes("pi-ai-catalog.json")) return contentsEnvelopeResponse(catalogText);
				throw new Error(`unexpected url ${url}`);
			},
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, true);
		// <host>/<owner>/<repo>/raw/<ref>/<path> 已被 GitCode 前端接管（返回 SPA HTML + 验证码 SDK），
		// 因此镜像源改走 AtomGit OpenAPI contents（base64 信封，客户端需解码）。
		assert.ok(
			seen.some((u) => u.startsWith("https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/resources/pi-ai-catalog.manifest.json?ref=main")),
			`分支请求应优先走 AtomGit contents API，实际: ${JSON.stringify(seen)}`,
		);
		assert.equal(updater.getStatus().overlay?.packageVersion, "9.9.9");
	} finally {
		cleanup(dir);
	}
});

test("catalog: atomgit 返回非 JSON（SPA HTML）时回落 GitHub raw 并生效", async () => {
	const dir = tempDir();
	try {
		const { catalogText, manifestText } = generateArtifact("9.9.9");
		const seen = [];
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			source: () => "atomgit",
			fetchImpl: async (url) => {
				seen.push(url);
				if (url.startsWith("https://api.atomgit.com/")) return okResponse("<!doctype html><html><body>GitCode</body></html>");
				if (url.includes("pi-ai-catalog.manifest.json")) return okResponse(manifestText);
				if (url.includes("pi-ai-catalog.json")) return okResponse(catalogText);
				throw new Error(`unexpected url ${url}`);
			},
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true, "AtomGit 形态不识别时不应整单失败");
		assert.equal(result.updated, true);
		assert.ok(
			seen.some((u) => u.startsWith("https://raw.githubusercontent.com/ayuayue/PiDeck/main/resources/")),
			`应回落到 GitHub raw，实际: ${JSON.stringify(seen)}`,
		);
		assert.equal(updater.getStatus().overlay?.packageVersion, "9.9.9");
	} finally {
		cleanup(dir);
	}
});

test("catalog: 未知源 id 仍按「AtomGit 优先 → GitHub raw」取件", async () => {
	const dir = tempDir();
	try {
		const { catalogText, manifestText } = generateArtifact("9.9.9");
		const seen = [];
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			// "custom"/前缀代理镜像已随 268e620f 退役；未知 id 一律归为非 github 源 → AtomGit 优先。
			// 该测试同时证明：自定义镜像主机不再参与目录下载（参数已从选项里移除）。
			source: () => "custom",
			fetchImpl: async (url) => {
				seen.push(url);
				const body = url.includes("pi-ai-catalog.manifest.json") ? manifestText : catalogText;
				if (url.startsWith("https://api.atomgit.com/")) return contentsEnvelopeResponse(body);
				if (url.startsWith("https://raw.githubusercontent.com/")) return okResponse(body);
				throw new Error(`unexpected url ${url}`);
			},
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.ok(seen[0].startsWith("https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/"), `非 github 源应 AtomGit OpenAPI 优先，实际首个请求: ${seen[0]}`);
	} finally {
		cleanup(dir);
	}
});

test("catalog: 分支源全挂时回退 npm latest", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: async (url) => {
				// 分支源（raw / jsDelivr gh）一律失败，模拟不可达
				if (url.includes("raw.githubusercontent.com") || url.includes("cdn.jsdelivr.net/gh/")) {
					throw new Error(`branch down ${url}`);
				}
				return makeNpmFetch("9.9.9", ["demo.json"])(url);
			},
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, true, "分支失败应回退 npm 并写入");
		assert.equal(updater.getStatus().overlay?.packageVersion, "9.9.9");
	} finally {
		cleanup(dir);
	}
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * piPackageCatalog 单测：pi.dev 扩展商店（HTML 解析 + 缓存 fetch）。
 *
 * 与 importer 测试同款做法：TS 源转译成 CJS 后在 vm 沙箱运行，无 electron 依赖。
 * 解析用真实抓取的目录页 fixture（tests/fixtures/piDevPackagesPage1.html，type=extension&page=1），
 * 保证解析逻辑对真实页面结构可用；fetch 用注入的 mock 验证缓存/超时/回退行为。
 */

function loadTranspiled(sourcePath, sandbox) {
	const source = readFileSync(sourcePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
	return sandbox.exports;
}

function loadModule() {
	return loadTranspiled("src/main/extensions/piPackageCatalog.ts", {
		exports: {},
		require,
		process,
		console,
		URL,
		setTimeout,
		clearTimeout,
		AbortController,
		URLSearchParams,
	});
}

function fixtureHtml() {
	return readFileSync("tests/fixtures/piDevPackagesPage1.html", "utf8");
}

test("parsePackageCatalogHtml 解析真实目录页：卡片数量与字段完整", () => {
	const mod = loadModule();
	const items = mod.parsePackageCatalogHtml(fixtureHtml());
	// 真实页 50 张卡片，全部应被解析
	assert.equal(items.length, 50);
	const first = items[0];
	assert.equal(first.name, "pi-mcp-adapter");
	assert.equal(first.description, "MCP (Model Context Protocol) adapter extension for Pi coding agent");
	assert.equal(first.author, "nicopreme");
	// vm 跨 realm：数组原型不同，deepEqual 会报 reference-equal，用 join 比较
	assert.equal(first.types.join(","), "extension");
	assert.equal(first.downloadsPerMonth, 761442);
	assert.equal(typeof first.publishedAt, "number");
	assert.ok(first.publishedAt > 0);
	assert.equal(first.npmUrl, "https://www.npmjs.com/package/pi-mcp-adapter");
	assert.equal(first.githubUrl, "https://github.com/nicobailon/pi-mcp-adapter");
	assert.equal(first.installSource, "npm:pi-mcp-adapter");
	assert.ok(first.pageUrl.includes("/packages/pi-mcp-adapter"));
	assert.ok(first.searchText.includes("pi-mcp-adapter"));
});

test("parsePackageCatalogHtml 空 HTML 返回空数组", () => {
	const mod = loadModule();
	assert.equal(mod.parsePackageCatalogHtml("").length, 0);
	assert.equal(mod.parsePackageCatalogHtml("<html><body>no cards</body></html>").length, 0);
});

test("parsePackageCatalogHtml 跳过缺 name 的卡片且不抛错", () => {
	const mod = loadModule();
	const html = `<article data-package-card="true" data-package-search="x"><div class="packages-card-body"></div></article>
<article data-package-card="true" data-package-name="ok-pkg" data-package-types="extension" data-package-downloads="10">
  <div class="packages-card-body"><h3 class="packages-name"><a href="/packages/ok-pkg">ok-pkg</a></h3>
  <p class="packages-desc">desc</p><div class="packages-meta"><span>author</span><span>10/mo</span><span>1d ago</span></div>
  <div class="packages-links"><a href="https://www.npmjs.com/package/ok-pkg">npm</a><a href="https://github.com/a/b">repo</a></div>
  <div class="packages-install"><code>pi install npm:ok-pkg</code></div></div></article>`;
	const items = mod.parsePackageCatalogHtml(html);
	assert.equal(items.length, 1);
	assert.equal(items[0].name, "ok-pkg");
});

test("parsePackageCatalogHtml 解码 HTML 实体（&amp; 与 &#x27;）", () => {
	const mod = loadModule();
	const html = `<article data-package-card="true" data-package-name="a&amp;b" data-package-types="extension">
  <div class="packages-card-body"><h3 class="packages-name"><a href="/packages/a&amp;b">a&amp;b</a></h3>
  <p class="packages-desc">x &amp; y</p><div class="packages-meta"><span>a &#x27;b&#x27;</span></div></div></article>`;
	const items = mod.parsePackageCatalogHtml(html);
	assert.equal(items[0].name, "a&b");
	assert.equal(items[0].description, "x & y");
	assert.equal(items[0].author, "a 'b'");
});

test("parseCatalogIndexMeta 取真实页的 total / lastPage", () => {
	const mod = loadModule();
	const meta = mod.parseCatalogIndexMeta(fixtureHtml());
	// 真实页：1-50 / 3112 (of 5291)，翻页链接最大 page=63
	assert.equal(meta.rangeStart, 1);
	assert.equal(meta.rangeEnd, 50);
	assert.equal(meta.total, 3112);
	assert.equal(meta.lastPage, 63);
});

test("parseCatalogIndexMeta 无计数时 lastPage 兜底为 1", () => {
	const mod = loadModule();
	// vm 跨 realm：对象原型不同，逐字段断言避免 deepEqual 原型比较失败
	const meta = mod.parseCatalogIndexMeta("<html></html>");
	assert.equal(meta.lastPage, 1);
	assert.equal(meta.total, undefined);
});

test("catalogPageUrl 按查询参数拼 URL，默认值不重复携带", () => {
	const mod = loadModule();
	assert.equal(mod.catalogPageUrl({}), "https://pi.dev/packages");
	assert.equal(mod.catalogPageUrl({ page: 1 }), "https://pi.dev/packages");
	assert.equal(mod.catalogPageUrl({ page: 2, query: "mcp", type: "extension", sort: "downloads" }), "https://pi.dev/packages?page=2&name=mcp&type=extension");
	assert.equal(mod.catalogPageUrl({ query: "mcp", sort: "recent" }), "https://pi.dev/packages?name=mcp&sort=recent");
});

test("getPiPackageCatalog 首屏正常返回并填充 total/lastPage/pageSize", async () => {
	const mod = loadModule();
	mod.resetPiPackageCatalogCache();
	let called = 0;
	const fetchImpl = async (url) => {
		called += 1;
		assert.equal(url, "https://pi.dev/packages?type=extension");
		return {
			ok: true,
			status: 200,
			text: async () => fixtureHtml(),
		};
	};
	const catalog = await mod.getPiPackageCatalog({ page: 1, type: "extension", fetchImpl, now: () => 1_000_000 });
	assert.equal(called, 1);
	assert.equal(catalog.items.length, 50);
	assert.equal(catalog.total, 3112);
	assert.equal(catalog.lastPage, 63);
	assert.equal(catalog.pageSize, 50);
	assert.equal(catalog.fromCache, false);
	assert.equal(catalog.generatedAt, 1_000_000);
});

test("getPiPackageCatalog 缓存命中：同参数二次请求不再发网络", async () => {
	const mod = loadModule();
	mod.resetPiPackageCatalogCache();
	let called = 0;
	const fetchImpl = async () => {
		called += 1;
		return { ok: true, status: 200, text: async () => fixtureHtml() };
	};
	await mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 });
	const second = await mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 + 60_000 });
	assert.equal(called, 1);
	assert.equal(second.fromCache, true);
});

test("getPiPackageCatalog 缓存过期后重新请求；refresh 强制跳过缓存", async () => {
	const mod = loadModule();
	mod.resetPiPackageCatalogCache();
	let called = 0;
	const fetchImpl = async () => {
		called += 1;
		return { ok: true, status: 200, text: async () => fixtureHtml() };
	};
	await mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 });
	// 超过 10 分钟 TTL → 重新请求
	await mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 + 11 * 60_000 });
	assert.equal(called, 2);
	// refresh=true 即使未过期也重新请求
	await mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 + 60_000, refresh: true });
	assert.equal(called, 3);
});

test("getPiPackageCatalog 网络失败但有旧缓存 → 回退缓存", async () => {
	const mod = loadModule();
	mod.resetPiPackageCatalogCache();
	let fail = false;
	const fetchImpl = async () => {
		if (fail) throw new Error("network down");
		return { ok: true, status: 200, text: async () => fixtureHtml() };
	};
	await mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 });
	fail = true;
	const fallback = await mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 + 60_000 });
	assert.equal(fallback.fromCache, true);
	assert.equal(fallback.items.length, 50);
});

test("getPiPackageCatalog 无缓存且失败 → 抛错", async () => {
	const mod = loadModule();
	mod.resetPiPackageCatalogCache();
	const fetchImpl = async () => {
		throw new Error("network down");
	};
	await assert.rejects(mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 }), /network down/);
});

test("getPiPackageCatalog 首屏 0 卡片视为目录不可用 → 抛错且不缓存", async () => {
	const mod = loadModule();
	mod.resetPiPackageCatalogCache();
	let called = 0;
	const fetchImpl = async () => {
		called += 1;
		return { ok: true, status: 200, text: async () => "<html><body>empty</body></html>" };
	};
	await assert.rejects(mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 }), /contained no packages/);
	// 失败不写缓存：再次调用仍发网络
	await assert.rejects(mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 + 60_000 }), /contained no packages/);
	assert.equal(called, 2);
});

test("getPiPackageCatalog HTTP 非 2xx 抛错", async () => {
	const mod = loadModule();
	mod.resetPiPackageCatalogCache();
	const fetchImpl = async () => ({ ok: false, status: 503, text: async () => "" });
	await assert.rejects(mod.getPiPackageCatalog({ page: 1, fetchImpl, now: () => 1_000_000 }), /status 503/);
});

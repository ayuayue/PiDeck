/**
 * `readVerifiedArtifact` 逐文件哈希记忆化回归测试。
 *
 * 钉住四类风险：
 * 1. memo 必须真的被写入并被复用（否则「同会话内第二次起零哈希」的提速目标落空）——命中时
 *    既要返回同一份清单对象，也要做到零读盘（以 readFileSync 计数证明没重算）；
 * 2. memo **不得固化过期结果**——校验通过后文件被等字节数覆写（时间戳同时变化）时，
 *    再次校验必须返回 null，否则被篡改的扩展仍会被当作有效覆盖层注入；mtime 还落在 50ms
 *    保护窗口内的「新鲜」条目一律不进 memo，把「同刻度 + 等字节数」覆写的残留窗口关死；
 * 3. 失效入口必须接线：`invalidateVerifiedArtifactFileHashCache` 与
 *    `invalidateBuiltInExtensionsOverlayCache`（热更新写盘/还原后调用）都要清空 memo。
 *
 * 装载方式与其它主进程测试一致（tests/helpers/loadTsCommonJs.mjs）：
 * builtInExtensions.ts 必须与测试共享同一个 manifest 模块实例，否则它内部的
 * invalidate 接线无法从测试侧观测，故用 stubs 把 "./builtInExtensionsManifest"
 * 指向同一份加载结果。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const manifestModule = loadTsCommonJs("src/main/extensions/builtInExtensionsManifest.ts");
const builtInModule = loadTsCommonJs("src/main/extensions/builtInExtensions.ts", {
	stubs: { "./builtInExtensionsManifest": manifestModule },
});

const { EXTENSIONS_MANIFEST_FILE_NAME, getVerifiedArtifactFileHashCacheSize, invalidateVerifiedArtifactFileHashCache, readVerifiedArtifact } = manifestModule;
const { invalidateBuiltInExtensionsOverlayCache } = builtInModule;

/** 夹具文件统一用的「旧」时间戳：让 memo 的 stat 判据能走到命中分支。 */
const OLD_MTIME = new Date("2020-01-01T00:00:00Z");
/** 等字节数覆写后显式改成的另一个时间戳（保证与缓存条目可区分）。 */
const TAMPERED_MTIME = new Date("2021-06-15T12:00:00Z");

function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function buildManifest(files, version) {
	const entries = Object.keys(files)
		.sort()
		.map((name) => ({
			name,
			sha256: sha256(files[name]),
			bytes: Buffer.byteLength(files[name], "utf8"),
		}));
	const bundleSha256 = createHash("sha256")
		.update(entries.map((entry) => `${entry.name}:${entry.sha256}`).join("\n"))
		.digest("hex");
	return { schemaVersion: 1, version, bundleSha256, fileCount: entries.length, files: entries };
}

/** 造一个「清单 + 若干 .ts」的自洽目录，全部文件时间戳推到 2020 年。 */
function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "pideck-verified-artifact-"));
	const dir = join(root, "extensions");
	mkdirSync(dir, { recursive: true });
	const files = {
		"pi-deck-todo-state.ts": "export const state = 1;\n",
		"pi-deck-todo.ts": "import './pi-deck-todo-state';\nexport const todo = 1;\n",
		"pi-deck-vision.ts": "export const vision = 1;\n",
	};
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	writeFileSync(join(dir, EXTENSIONS_MANIFEST_FILE_NAME), `${JSON.stringify(buildManifest(files, "1.0.0"), null, 2)}\n`);
	for (const name of [...Object.keys(files), EXTENSIONS_MANIFEST_FILE_NAME]) {
		utimesSync(join(dir, name), OLD_MTIME, OLD_MTIME);
	}
	return { root, dir, files };
}

/**
 * 加载一份带 readFileSync 计数的 manifest 模块独立实例。
 *
 * 缓存条目数只能证明「没新增 key」，证不了「没重算」；读盘次数才是 memo 是否真被复用的
 * 直接证据。共享实例的 fs 引用已经绑死，只能另起一份沙箱实例来计数。
 */
function loadCountingManifestModule() {
	let reads = 0;
	const loaded = loadTsCommonJs("src/main/extensions/builtInExtensionsManifest.ts", {
		stubs: {
			"node:fs": {
				existsSync: (...args) => existsSync(...args),
				readFileSync: (...args) => {
					reads += 1;
					return readFileSync(...args);
				},
				readdirSync: (...args) => readdirSync(...args),
				statSync: (...args) => statSync(...args),
			},
		},
	});
	return { readVerifiedArtifact: loaded.readVerifiedArtifact, getVerifiedArtifactFileHashCacheSize: loaded.getVerifiedArtifactFileHashCacheSize, readCount: () => reads };
}

function withFixture(fn) {
	const fixture = makeFixture();
	try {
		fn(fixture);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
		invalidateVerifiedArtifactFileHashCache();
	}
}

test("readVerifiedArtifact 校验通过时把逐文件 sha256 写进 memo", () => {
	withFixture((fixture) => {
		invalidateVerifiedArtifactFileHashCache();
		const manifest = readVerifiedArtifact(fixture.dir);
		assert.ok(manifest);
		assert.equal(manifest.version, "1.0.0");
		assert.ok(getVerifiedArtifactFileHashCacheSize() > 0, "校验通过后 memo 必须有条目");
	});
});

test("memo 命中时二次校验复用上次结果：同一份清单对象且不再读盘", () => {
	withFixture((fixture) => {
		const counting = loadCountingManifestModule();
		const first = counting.readVerifiedArtifact(fixture.dir);
		assert.ok(first);
		const readsAfterFirst = counting.readCount();
		const cacheSizeAfterFirst = counting.getVerifiedArtifactFileHashCacheSize();

		const second = counting.readVerifiedArtifact(fixture.dir);
		// 同一份对象引用：manifest 复用缓存条目里存的那次解析产物，而不是重新 parse 出的副本
		assert.equal(second, first, "memo 命中必须返回同一份清单对象");
		assert.equal(counting.getVerifiedArtifactFileHashCacheSize(), cacheSizeAfterFirst, "命中不得新增缓存项");
		assert.equal(counting.readCount(), readsAfterFirst, "命中后不得再读盘（manifest 与逐文件哈希都不重算）");
	});
});

test("刚写入（新鲜 mtime）的条目不进 memo", () => {
	withFixture((fixture) => {
		invalidateVerifiedArtifactFileHashCache();
		// 重写一个文件让它的 mtime 落进 50ms 保护窗口（内容不变，校验仍应通过）
		writeFileSync(join(fixture.dir, "pi-deck-vision.ts"), "export const vision = 1;\n");
		assert.ok(readVerifiedArtifact(fixture.dir), "内容未变，仍应通过校验");
		// 计数只覆盖逐文件哈希 memo（manifest 解析 memo 是另一个 Map）：三个 .ts 里只有刚写的那个该被跳过
		assert.equal(getVerifiedArtifactFileHashCacheSize(), 2, "新鲜 mtime 的条目不得写入 memo");
	});
});

test("invalidateVerifiedArtifactFileHashCache 清空 memo 后重新校验可恢复", () => {
	withFixture((fixture) => {
		assert.ok(readVerifiedArtifact(fixture.dir));
		invalidateVerifiedArtifactFileHashCache();
		assert.equal(getVerifiedArtifactFileHashCacheSize(), 0);
		const manifest = readVerifiedArtifact(fixture.dir);
		assert.ok(manifest, "清空后必须重新校验并通过");
		assert.equal(manifest.version, "1.0.0");
		assert.ok(getVerifiedArtifactFileHashCacheSize() > 0, "重新校验后 memo 要重新填充");
	});
});

test("等字节数覆写扩展文件后再次校验必须返回 null（memo 不得固化过期结果）", () => {
	withFixture((fixture) => {
		assert.ok(readVerifiedArtifact(fixture.dir));
		// 同一字节数的内容替换：只有 mtime/sha256 能区分，bytes 完全一致
		const target = join(fixture.dir, "pi-deck-vision.ts");
		writeFileSync(target, "export const vision = 2;\n");
		utimesSync(target, TAMPERED_MTIME, TAMPERED_MTIME);
		assert.equal(readVerifiedArtifact(fixture.dir), null, "被篡改的目录不得再通过校验");

		// 还原内容并再换一个时间戳：memo 必须按新 stat 重算并恢复有效判定
		writeFileSync(target, "export const vision = 1;\n");
		utimesSync(target, OLD_MTIME, OLD_MTIME);
		assert.ok(readVerifiedArtifact(fixture.dir), "还原后应重新通过校验");
	});
});

test("invalidateBuiltInExtensionsOverlayCache 同时清空 manifest 模块的哈希 memo", () => {
	withFixture((fixture) => {
		assert.ok(readVerifiedArtifact(fixture.dir));
		assert.ok(getVerifiedArtifactFileHashCacheSize() > 0);
		invalidateBuiltInExtensionsOverlayCache();
		assert.equal(getVerifiedArtifactFileHashCacheSize(), 0, "覆盖层缓存失效必须带上哈希 memo");
	});
});

/**
 * dshProjectionCache 读取上界回归（稳定性约束 3：会话扫描要有大小上限）。
 *
 * 缺陷（红测复现）：readSessionProjectionTitles 无界 readFileSync + JSON.parse。
 * session_projcache.json 位于 DSH_HOME（外部 dsh-web 也会写它），损坏或异常增长时，
 * 后台扫描路径整读 → 主进程内存尖峰/OOM——同型于 SessionScanner「打开大会话即闪退」
 * 事故与生图 BLOB 读取上界修复。标题是增强数据：超限应整体跳过（空表），
 * 让扫描回退到既有的「日志折叠取标题」路径，而不是崩掉主进程。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readSessionProjectionTitles, parseProjectionTitles, DSH_PROJECTION_CACHE_RELATIVE, DSH_PROJECTION_CACHE_MAX_BYTES } = loadTsCommonJs("src/main/dsh/dshProjectionCache.ts");

function makeDshHome() {
	return mkdtempSync(join(tmpdir(), "dsh-projcache-bounds-"));
}

test("readSessionProjectionTitles: 超限文件整体跳过（空表），不整读内存", () => {
	const home = makeDshHome();
	try {
		const filePath = join(home, DSH_PROJECTION_CACHE_RELATIVE);
		mkdirSync(join(home, "storages"), { recursive: true });
		writeFileSync(filePath, "{}", "utf8");
		// truncate 扩展成逻辑大文件（不真实占盘）：stat.size 超上界即应拒绝读取。
		truncateSync(filePath, DSH_PROJECTION_CACHE_MAX_BYTES + 1);
		const titles = readSessionProjectionTitles(home);
		assert.equal(titles.size, 0, "超限的投影缓存必须整体跳过（标题降级到日志折叠），不得整读");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("readSessionProjectionTitles: 上界内的正常缓存照常解析", () => {
	const home = makeDshHome();
	try {
		const filePath = join(home, DSH_PROJECTION_CACHE_RELATIVE);
		mkdirSync(join(home, "storages"), { recursive: true });
		writeFileSync(filePath, JSON.stringify({ tables: { sessions: { "s-1": { rows: { title: { val: "正常标题" } } } } } }), "utf8");
		const titles = readSessionProjectionTitles(home);
		assert.equal(titles.get("s-1"), "正常标题");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("parseProjectionTitles: 纯函数路径不受上界影响（已读入字符串的解析契约不变）", () => {
	const titles = parseProjectionTitles(JSON.stringify({ tables: { sessions: { "s-2": { rows: { title: { val: " ok " } } } } } }));
	assert.equal(titles.get("s-2"), "ok");
});

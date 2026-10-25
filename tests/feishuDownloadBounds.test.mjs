import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 飞书资源下载字节上界回归（2026-12 修复）：
 * streamToBuffer 过去无上界整流进内存，且文件型 50MiB 拦截发生在全量下载之后、
 * 图片路径完全没有检查——飞书侧一个超大附件即可打爆主进程内存（与 filesReadContent
 * 无界读同族）。修复契约：64MiB 统一上界 + 流式累计超限即抛 + 中止后销毁底层流。
 * 契约用空白容忍正则（AGENTS.md：源码扫描测试必须空白容忍）。
 */
const source = readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");

function streamToBufferBody() {
	const start = source.indexOf("private async streamToBuffer");
	assert.ok(start !== -1, "streamToBuffer 方法必须存在");
	const next = source.indexOf("private async ", start + 10);
	return source.slice(start, next === -1 ? source.length : next);
}

test("下载必须有 64MiB 统一上界常量（图片与文件同闸）", () => {
	assert.match(source, /MAX_RESOURCE_DOWNLOAD_BYTES\s*=\s*64\s*\*\s*1024\s*\*\s*1024/, "上界常量必须存在且为 64MiB");
});

test("两条流路径（getReadableStream / asyncIterator）都必须流式累计并在超限时抛错", () => {
	const body = streamToBufferBody();
	const branches = body.match(/for\s+await\s*\(/g) ?? [];
	assert.ok(branches.length >= 2, `应有两处 for-await 流收集，实际 ${branches.length}`);
	const totalChecks = body.match(/total\s*\+=\s*piece\.length/g) ?? [];
	assert.ok(totalChecks.length >= 2, "每条流路径都必须累计字节");
	const capChecks = body.match(/total\s*>\s*cap/g) ?? [];
	assert.ok(capChecks.length >= 2, "每条流路径都必须有超限判定");
	const throws = body.match(/throw new Error\(\s*`FEISHU_RESOURCE_TOO_LARGE:\$\{total\}`\s*\)/g) ?? [];
	assert.ok(throws.length >= 2, "超限必须抛结构化错误（供调用方 UX 分流）");
});

test("超限中止后必须销毁底层流（getReadableStream 路径）", () => {
	const body = streamToBufferBody();
	assert.match(body, /destroyable\.destroy\?\.\s*\(new Error\("resource exceeds download budget"\)\)/, "中止后必须 destroy 底层流防泄漏");
});

test("超限抛错必须发生在收集循环内部（不得等全量收完再判定）", () => {
	const body = streamToBufferBody();
	const firstCapPos = body.indexOf("total > cap");
	const concatPos = body.indexOf("Buffer.concat(chunks)");
	assert.ok(firstCapPos !== -1 && concatPos !== -1, "上界判定与 concat 必须共存");
	assert.ok(firstCapPos < concatPos, "超限判定必须在收集循环内，concat 之前");
});

test("文件型 50MiB UX 拦截与 64MiB 下载闸并存（闸 ≥ UX 上限）", () => {
	assert.match(source, /fileData\.length\s*>\s*50\s*\*\s*1024\s*\*\s*1024/, "50MiB 文件 UX 拦截必须保留");
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * createNetDownloader 的 Range 续传语义（真实网络层最容易写错的地方）：
 * 带 Range → 206 追加；服务端忽略 Range → 200 必须覆盖写（否则整份内容接在半截之后）；
 * 416 → 起点无效，从 0 重来。
 */
const served = { requests: [], respond: null };

const { createNetDownloader } = loadTsCommonJs("src/main/dsh/runtime/dshRuntimeIo.ts", {
	stubs: {
		electron: {
			net: {
				request: (url) => {
					const listeners = {};
					const request = {
						url,
						headers: {},
						setHeader(name, value) {
							request.headers[String(name).toLowerCase()] = value;
						},
						on(event, callback) {
							(listeners[event] ||= []).push(callback);
							return request;
						},
						removeAllListeners() {},
						abort() {},
						end() {
							served.requests.push({ url, headers: { ...request.headers } });
							served.respond(request, listeners);
						},
					};
					return request;
				},
			},
		},
	},
});

/** 用一段内容回应请求：按 Range 头切片，`ignoreRange` 模拟不支持分段的服务器。 */
function serveContent(content, { ignoreRange = false, rejectRange = false } = {}) {
	return (_request, listeners) => {
		const range = /bytes=(\d+)-/.exec(_request.headers.range ?? "");
		const offset = range && !ignoreRange ? Number.parseInt(range[1] ?? "0", 10) : 0;
		let response;
		if (rejectRange && range) {
			response = Readable.from([]);
			response.statusCode = 416;
			response.headers = {};
		} else if (range && !ignoreRange) {
			response = Readable.from([content.subarray(offset)]);
			response.statusCode = 206;
			response.headers = { "content-length": [String(content.length - offset)], "content-range": [`bytes ${offset}-${content.length - 1}/${content.length}`] };
		} else {
			response = Readable.from([content]);
			response.statusCode = 200;
			response.headers = { "content-length": [String(content.length)] };
		}
		listeners.response[0](response);
	};
}

test("续传：带 Range 头、206 只写剩余部分，落盘是完整文件", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-resume-"));
	try {
		const full = Buffer.from("0123456789");
		const dest = join(root, "model.part");
		writeFileSync(dest, full.subarray(0, 4));
		served.requests.length = 0;
		served.respond = serveContent(full);
		const progress = [];
		await createNetDownloader()("https://example.com/model.bin", dest, (received, total) => progress.push([received, total]), undefined, { resumeFromBytes: 4 });
		assert.equal(served.requests[0].headers.range, "bytes=4-");
		assert.equal(readFileSync(dest).toString(), "0123456789");
		// 进度对调用方是「累计 / 整份」，续传段不会从 0 重来
		assert.deepEqual(progress.at(-1), [10, 10]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("服务端忽略 Range 回 200 全量时覆盖写，不能把整份内容追加在半截之后", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-resume-200-"));
	try {
		const full = Buffer.from("0123456789");
		const dest = join(root, "model.part");
		writeFileSync(dest, full.subarray(0, 4));
		served.requests.length = 0;
		served.respond = serveContent(full, { ignoreRange: true });
		await createNetDownloader()("https://example.com/model.bin", dest, undefined, undefined, { resumeFromBytes: 4 });
		assert.equal(served.requests[0].headers.range, "bytes=4-");
		assert.equal(statSync(dest).size, full.length);
		assert.equal(readFileSync(dest).toString(), "0123456789");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("416（起点超出远端长度）从 0 重来，不带 Range 再发一次", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-resume-416-"));
	try {
		const full = Buffer.from("0123456789");
		const dest = join(root, "model.part");
		writeFileSync(dest, full.subarray(0, 4));
		served.requests.length = 0;
		served.respond = serveContent(full, { rejectRange: true });
		await createNetDownloader()("https://example.com/model.bin", dest, undefined, undefined, { resumeFromBytes: 4 });
		assert.equal(served.requests.length, 2, "416 后应重发一次");
		assert.equal(served.requests[0].headers.range, "bytes=4-");
		assert.equal(served.requests[1].headers.range, undefined);
		assert.equal(readFileSync(dest).toString(), "0123456789");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("断点文件已经不在（被清理）时按全量下载，不写坏 Range", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-resume-missing-"));
	try {
		const full = Buffer.from("0123456789");
		const dest = join(root, "model.part");
		served.requests.length = 0;
		served.respond = serveContent(full);
		await createNetDownloader()("https://example.com/model.bin", dest, undefined, undefined, { resumeFromBytes: 4 });
		assert.equal(served.requests[0].headers.range, undefined);
		assert.equal(readFileSync(dest).toString(), "0123456789");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

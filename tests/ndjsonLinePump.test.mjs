/**
 * ndjsonLinePump（Buffer 分段行泵）单元测试。
 * 覆盖：跨 chunk 多字节字符、块边界 LF、CRLF 剥离、onLine 返回 false 中止、
 * end() 残行吐出、reset 清空与 bufferedBytes 可见性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createNdjsonLinePump } = loadTsCommonJs("src/main/ndjsonLinePump.ts");

test("跨 chunk 切分：多字节字符与 LF 落在任意块边界都完整切行", () => {
	const lines = [];
	const pump = createNdjsonLinePump((line) => {
		lines.push(line);
	});
	const frame = Buffer.from('{"text":"中文日本語한국어🚀"}\n{"two":"第二行"}\n{"tail":"半行"', "utf8");
	// 7 字节一块：多字节序列与 LF 都会跨块
	for (let offset = 0; offset < frame.length; offset += 7) {
		pump.push(frame.subarray(offset, Math.min(offset + 7, frame.length)));
	}
	assert.deepEqual(lines, ['{"text":"中文日本語한국어🚀"}', '{"two":"第二行"}']);
	assert.ok(pump.bufferedBytes > 0, "半行残端保留在缓冲");
	// 补 LF 收尾
	pump.push(Buffer.from("}\n", "utf8"));
	assert.deepEqual(lines[2], '{"tail":"半行"}');
	assert.equal(pump.bufferedBytes, 0);
});

test("CRLF 行尾剥离；空行照常分发；string chunk 与 Buffer 等价", () => {
	const lines = [];
	const pump = createNdjsonLinePump((line) => lines.push(line));
	pump.push(Buffer.from("a\r\n\r\n", "utf8"));
	pump.push("b\n");
	assert.deepEqual(lines, ["a", "", "b"]);
});

test("onLine 返回 false 中止切行（消费方关闭场景），剩余缓冲保留", () => {
	const seen = [];
	let stop = false;
	const pump = createNdjsonLinePump((line) => {
		seen.push(line);
		return !stop;
	});
	pump.push(Buffer.from("one\ntwo\nthree\n", "utf8"));
	assert.deepEqual(seen, ["one", "two", "three"]);
	stop = true;
	pump.push(Buffer.from("four\nfive\n", "utf8"));
	assert.deepEqual(seen, ["one", "two", "three", "four"], "five 之前中止");
	assert.ok(pump.bufferedBytes > 0, "中止后剩余缓冲不清空（调用方决定 reset）");
});

test("end() 把残行作为最后一行吐出；reset() 返回丢弃字节数并清零", () => {
	const lines = [];
	const pump = createNdjsonLinePump((line) => lines.push(line));
	pump.push(Buffer.from("partial-without-lf", "utf8"));
	assert.equal(lines.length, 0);
	pump.end();
	assert.deepEqual(lines, ["partial-without-lf"]);
	assert.equal(pump.bufferedBytes, 0);

	pump.push(Buffer.from("abcdef", "utf8"));
	assert.equal(pump.reset(), 6);
	assert.equal(pump.bufferedBytes, 0);
	pump.end();
	assert.equal(lines.length, 1, "reset 后 end 无残行可吐");
});

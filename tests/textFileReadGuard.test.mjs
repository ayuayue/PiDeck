import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 模拟异常大小、非文本和读取失败；不依赖真实透明加密驱动，
// 也不把异常元数据或非 UTF-8 内容当作密文的充分证据。

const guard = loadTsCommonJs("src/main/files/textFileRead.ts");
const { MAX_TRUSTED_STAT_BYTES, assertTrustedStatSize, looksNonText, readTextFileGuarded } = guard;

function withTempFile(name, data) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-text-guard-"));
	const path = join(dir, name);
	writeFileSync(path, data);
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("正常 UTF-8 源码必须原样读出（中文/制表符/CRLF 不得被误判为非文本）", async () => {
	const source = "<template>\r\n\t<div>中文标题</div>\r\n</template>\r\n";
	const { path, cleanup } = withTempFile("App.vue", source);
	try {
		assert.equal(await readTextFileGuarded(path, 5 * 1024 * 1024), source);
	} finally {
		cleanup();
	}
});

test("密文/二进制内容必须抛 FILE_NOT_TEXT（阻止乱码进编辑器后自动保存覆写）", async () => {
	// 0x80-0xFF 字节区间是合法 UTF-8 之外的散乱字节，等价于驱动返回的加密载荷。
	const ciphertext = Buffer.alloc(512);
	for (let index = 0; index < ciphertext.length; index += 1) ciphertext[index] = 0x80 + (index % 0x80);
	const { path, cleanup } = withTempFile("App.vue", ciphertext);
	try {
		await assert.rejects(
			() => readTextFileGuarded(path),
			(error) => {
				assert.match(error.message, /^FILE_NOT_TEXT:\d+$/, "必须是结构化前缀，渲染层据此走 i18n 文案");
				const bytes = Number(error.message.split(":")[1]);
				assert.ok(bytes > 0, "前缀必须携带实际字节数用于提示");
				return true;
			},
		);
	} finally {
		cleanup();
	}
});

test("超预算文件仍走既有 FILE_TOO_LARGE 协议（size:max 两个字段都不能丢）", async () => {
	const { path, cleanup } = withTempFile("big.ts", "x".repeat(4096));
	try {
		await assert.rejects(
			() => readTextFileGuarded(path, 1024),
			(error) => {
				assert.match(error.message, /^FILE_TOO_LARGE:4096:1024$/);
				return true;
			},
		);
	} finally {
		cleanup();
	}
});

test("stat 假大小必须判不可信并抛 FILE_SIZE_UNREADABLE（0xAA… 填充值）", () => {
	assert.equal(MAX_TRUSTED_STAT_BYTES, 1024 ** 4, "可信上界必须是 1TiB：真实文本文件不可能更大，0xAA… 假值约 1.2e19");
	// VSCode 把该值显示成 11184810.67 TB = 0xAAAA_AAAA_AAAA_AAAA。
	const forgedSize = 11184810.67 * 1024 ** 4;
	assert.throws(
		() => assertTrustedStatSize(Math.round(forgedSize)),
		(error) => {
			assert.match(error.message, /^FILE_SIZE_UNREADABLE:\d+$/);
			return true;
		},
	);
	// 边界内不得误伤：4GiB 的合法大文件仍按普通大文件处理。
	assert.doesNotThrow(() => assertTrustedStatSize(4 * 1024 ** 3));
});

for (const phase of ["stat", "readFile"]) {
	for (const code of ["EACCES", "EPERM", "EBUSY", "EIO"]) {
		test(`${phase} ${code}：转换为文件访问错误`, async () => {
			const failure = Object.assign(new Error("access blocked"), { code });
			const { readTextFileGuarded: read } = loadTsCommonJs("src/main/files/textFileRead.ts", {
				stubs: {
					"node:fs/promises": {
						...fs,
						stat: async () => {
							if (phase === "stat") throw failure;
							return { size: 4 };
						},
						readFile: async () => {
							throw failure;
						},
					},
				},
			});
			await assert.rejects(read("source.vue", 1024), { message: `FILE_ACCESS_DENIED:${code}` });
		});
	}
}

test("looksNonText 只拦真乱码：ANSI 转义日志与短片段不得误判，UTF-16 必须判非文本", () => {
	assert.equal(looksNonText("\x1b[31mERROR\x1b[0m 编译失败：模块缺失\n\x1b[32mok\x1b[0m\n"), false, "带 ANSI 转义的日志仍是文本");
	assert.equal(looksNonText("短"), false, "过短内容不做判决");
	assert.equal(looksNonText(Buffer.from("hello world this is utf16 text", "utf16le").toString("utf8")), true, "UTF-16 解码出的 NUL 必须判非文本");
});

test("任何非法 UTF-8（包括正文末尾单个坏字节）都拒绝有损解码，合法替换字符保留", async () => {
	for (const data of [Buffer.from([0xff]), Buffer.concat([Buffer.from("x".repeat(70 * 1024)), Buffer.from([0xff])])]) {
		const { path, cleanup } = withTempFile("invalid.vue", data);
		try {
			await assert.rejects(readTextFileGuarded(path), { message: `FILE_NOT_TEXT:${data.byteLength}` });
		} finally {
			cleanup();
		}
	}
	const { path, cleanup } = withTempFile("valid.txt", "�");
	try {
		assert.equal(await readTextFileGuarded(path), "�");
	} finally {
		cleanup();
	}
});

test("异常 stat 大小在读取内容前被拒绝", async () => {
	for (const size of [NaN, -1, Infinity, 1024 ** 4 + 1, Math.round(11184810.67 * 1024 ** 4)]) {
		let reads = 0;
		const { readTextFileGuarded: read } = loadTsCommonJs("src/main/files/textFileRead.ts", {
			stubs: {
				"node:fs/promises": {
					stat: async () => ({ size }),
					readFile: async () => {
						reads += 1;
						return Buffer.from("text");
					},
				},
			},
		});
		await assert.rejects(read("source.vue", 1024), { message: `FILE_SIZE_UNREADABLE:${size}` });
		assert.equal(reads, 0);
	}
});

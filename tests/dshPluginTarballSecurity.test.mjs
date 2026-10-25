import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 回归背景（2026-12 extractTgz 加固）：解包缺条目数/总字节上限（tar-bomb 磁盘耗尽
// DoS），且 filter 只查路径文本不查成员类型（符号链接成员 = tar-slip 变体攻击面）。
// 修复契约：>512 条目抛 TARBALL_TOO_MANY_ENTRIES；总字节 >256MiB 抛 TARBALL_TOO_LARGE；
// SymbolicLink/Link 成员跳过不落盘；绝对路径与 .. 段成员拒收（原有契约保持）。
// 实现注意：预算在 filter 里以「拒收」表达（不在 filter 内 throw——isaacs tar 会把
// filter 异常重抛为未捕获异步错误绕过 promise），tar.x 结束后统一抛结构化错。
const { extractTgz } = loadTsCommonJs("src/main/dsh/dshPluginTarball.ts");

function makeRoot() {
	return mkdtempSync(join(tmpdir(), "pideck-tgz-sec-"));
}

function tarHeader(path, opts = {}) {
	const size = opts.size ?? 0;
	const typeflag = opts.typeflag ?? "0";
	const header = Buffer.alloc(512);
	header.write(path, 0, 100); // name
	header.write("0000644\0", 100, 8); // mode
	header.write("0000000\0", 108, 8); // uid
	header.write("0000000\0", 116, 8); // gid
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12); // size
	header.write("00000000000\0", 136, 12); // mtime
	header.write("        ", 148, 8); // checksum 占位空格
	header.write(typeflag, 156, 1);
	if (opts.linkname) header.write(opts.linkname, 157, 100); // symlink 目标
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
	return header;
}

/** 成员数据补齐到 512 块边界 + tar 规范要求的双零结尾块 */
function memberData(raw) {
	const padded = Buffer.alloc(Math.ceil(raw.length / 512) * 512);
	raw.copy(padded);
	return padded;
}
const endBlocks = Buffer.alloc(1024);

function writeTgz(path, ...blocks) {
	writeFileSync(path, gzipSync(Buffer.concat([...blocks, endBlocks]), { level: 1 }), "utf8");
}

test("正常小插件 tgz 解包成功（防护不误伤）", async () => {
	const root = makeRoot();
	try {
		const pkg = join(root, "src");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "index.js"), "export default 1;", "utf8");
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "ok", version: "1.0.0", main: "index.js" }), "utf8");
		const tgz = join(root, "ok.tgz");
		tar.c({ sync: true, cwd: root, file: tgz }, ["src"]);
		const dest = join(root, "out");
		await extractTgz(tgz, dest);
		assert.equal(existsSync(join(dest, "index.js")), true, "strip 1 后 index.js 应落位");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("条目数超限抛 TARBALL_TOO_MANY_ENTRIES（tar-bomb 闸）", async () => {
	const root = makeRoot();
	try {
		const pkg = join(root, "pkg");
		mkdirSync(pkg, { recursive: true });
		// 600 个零字节成员：npm 真实包条目数远低于 512，超限即恶意
		for (let i = 0; i < 600; i++) writeFileSync(join(pkg, `f${i}.txt`), "");
		const tgz = join(root, "bomb.tgz");
		tar.c({ sync: true, cwd: root, file: tgz, gzip: true }, ["pkg"]);
		await assert.rejects(() => extractTgz(tgz, join(root, "out")), /TARBALL_TOO_MANY_ENTRIES/);
		// 已落盘条目不得超过预算（后续成员拒收而非全量写入）
		let extracted = 0;
		for (const name of readdirSync(join(root, "out"))) extracted += 1;
		assert.ok(extracted <= 512, `落盘条目 ${extracted} 不得超过 512`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("总字节超限抛 TARBALL_TOO_LARGE（真实 300MiB 数据，落盘前的预算即拦截）", async () => {
	const root = makeRoot();
	try {
		// 预算判定依据 tar 头字段累计：两条 150MiB 成员合计触闸（单包不超 256MiB 闸）
		const half = 150 * 1024 * 1024;
		const tgz = join(root, "huge.tgz");
		// 零数据 gzip 压缩率 ~1000x：产物仅几百 KB，解压后由 tar 流式跳读
		writeTgz(tgz, tarHeader("pkg/huge1.bin", { size: half }), Buffer.alloc(half), tarHeader("pkg/huge2.bin", { size: half }), Buffer.alloc(half));
		await assert.rejects(() => extractTgz(tgz, join(root, "out")), /TARBALL_TOO_LARGE/);
		// 预算闸语义：预算内成员（150MiB）合法落盘，把累计值推过 256MiB 闸的成员拒收
		assert.equal(existsSync(join(root, "out", "huge2.bin")), false, "触闸成员不得落盘");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("符号链接成员被跳过（tar-slip 变体防御，头字段构造免特权）", async () => {
	const root = makeRoot();
	try {
		const tgz = join(root, "lnk.tgz");
		const data = Buffer.from("data", "utf8");
		writeTgz(tgz, tarHeader("pkg/real.txt", { size: data.length }), memberData(data), tarHeader("pkg/evil-link", { typeflag: "2", linkname: "real.txt" }));
		const dest = join(root, "out");
		await extractTgz(tgz, dest);
		assert.equal(existsSync(join(dest, "evil-link")), false, "符号链接成员不得被解出");
		assert.equal(existsSync(join(dest, "real.txt")), true, "正常成员照常落位");
		assert.equal(lstatSync(dest).isSymbolicLink(), false, "dest 根不得是符号链接");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("绝对路径与 .. 段成员仍被拒收（既有契约保持）", async () => {
	const root = makeRoot();
	try {
		const slipTgz = join(root, "slip.tgz");
		const absTgz = join(root, "abs.tgz");
		writeTgz(slipTgz, tarHeader("pkg/../../escape.txt", { size: 0 }));
		writeTgz(absTgz, tarHeader("/abs-escape.txt", { size: 0 }));
		await extractTgz(slipTgz, join(root, "out1"));
		await extractTgz(absTgz, join(root, "out2"));
		assert.equal(existsSync(join(root, "escape.txt")), false, ".. 段成员不得逃逸");
		assert.equal(existsSync("/abs-escape.txt"), false, "绝对路径成员不得落盘");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

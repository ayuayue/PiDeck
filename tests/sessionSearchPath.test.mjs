/**
 * 会话内查找（sessions:search-in-session）的 IPC 边界校验。
 *
 * 回归背景：边界曾只认正斜杠（`/[\/]/`），而 Windows 的会话路径由 path.join 生成
 * 反斜杠（catalog 的 SessionRecord.filePath 也是反斜杠），导致 Windows 上每次查找
 * 都在边界被判 null，浮层永远显示「索引尚未就绪」。
 *
 * 校验口径：只放行「绝对路径 + .jsonl」；分隔符两种都认；相对路径/非 JSONL/超长一律拒绝。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isSessionSearchFilePath } = loadTsCommonJs("src/main/sessions/sessionSearchPath.ts");

test("Windows 反斜杠绝对路径放行（Windows 上 record.filePath 的默认形态）", () => {
	assert.equal(isSessionSearchFilePath("C:\\Users\\u\\.pi\\agent\\sessions\\a.jsonl"), true);
});

test("Windows 正斜杠与不同盘符大小写的绝对路径同样放行", () => {
	assert.equal(isSessionSearchFilePath("C:/Users/u/.pi/sessions/a.jsonl"), true);
	assert.equal(isSessionSearchFilePath("d:\\sessions\\a.jsonl"), true);
});

test("POSIX 与 WSL 绝对路径放行", () => {
	assert.equal(isSessionSearchFilePath("/home/u/.pi/agent/sessions/a.jsonl"), true);
	assert.equal(isSessionSearchFilePath("/mnt/c/Users/u/.pi/sessions/a.jsonl"), true);
});

test("UNC 路径放行（宿主解析后的网络/共享会话目录）", () => {
	assert.equal(isSessionSearchFilePath("\\\\server\\share\\sessions\\a.jsonl"), true);
});

test("非绝对路径一律拒绝：相对路径、只有文件名、盘符相对路径", () => {
	assert.equal(isSessionSearchFilePath("sessions/a.jsonl"), false);
	assert.equal(isSessionSearchFilePath("a.jsonl"), false);
	assert.equal(isSessionSearchFilePath("a\\b.jsonl"), false);
	assert.equal(isSessionSearchFilePath("C:a.jsonl"), false);
	assert.equal(isSessionSearchFilePath("C:relative\\a.jsonl"), false);
});

test("非会话文件与越界输入拒绝：扩展名不符、空串、超长", () => {
	assert.equal(isSessionSearchFilePath("C:\\sessions\\a.txt"), false);
	assert.equal(isSessionSearchFilePath("C:\\sessions\\a.jsonl.bak"), false);
	assert.equal(isSessionSearchFilePath(""), false);
	assert.equal(isSessionSearchFilePath(`${"C:\\".concat("x".repeat(4100))}.jsonl`), false);
});

test("扩展名大小写不敏感（.JSONL 也是会话文件）", () => {
	assert.equal(isSessionSearchFilePath("C:\\sessions\\A.JSONL"), true);
});

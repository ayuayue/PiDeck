import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { fileLoadErrorMessage } = loadTsCommonJs("src/renderer/src/components/app/fileLoadErrorMessage.ts");

test("读写错误经过同一翻译器：IPC 包装也能识别，不裸露结构化前缀", () => {
	for (const [message, snippets] of [
		["FILE_TOO_LARGE:2097152:1048576", ["2.0MB", "1MB"]],
		["FILE_SIZE_UNREADABLE:12297829382473034000", ["大小异常", "12297829382473034000"]],
		["FILE_SIZE_UNREADABLE:NaN", ["大小异常", "NaN"]],
		["FILE_ACCESS_DENIED:EACCES", ["文件访问失败", "EACCES"]],
		["FILE_NOT_TEXT:11681", ["UTF-8", "11.4 KB", "未开启编辑或自动保存"]],
		["FILE_WRITE_BLOCKED_ENCRYPTED:11681", ["已阻止保存", "11.4 KB", "本次未写入"]],
	]) {
		const wrapped = new Error(`Error invoking remote method 'files:read-content': Error: ${message}`);
		const result = fileLoadErrorMessage(wrapped);
		assert.equal(result.includes("FILE_"), false);
		for (const snippet of snippets) assert.ok(result.includes(snippet), `${message}: ${result}`);
	}
});

test("未知错误保留原始诊断，不被误识别为加密文件", () => {
	assert.equal(fileLoadErrorMessage(new Error("unexpected failure")), "unexpected failure");
	assert.equal(fileLoadErrorMessage("failure"), "failure");
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #560：ACP 会话附加根目录的归一化（主进程收窄渲染层入参、渲染层提交前预检共用同一套规则）。
 */
const { ACP_ADDITIONAL_DIRECTORIES_MAX, normalizeAcpAdditionalDirectories } = loadTsCommonJs("src/shared/acpAdditionalDirectories.ts");

test("只保留绝对路径，相对路径与空白项丢弃", () => {
	assert.deepEqual([...normalizeAcpAdditionalDirectories(["D:/demo/lib", "relative/dir", "  ", "\\\\server\\share"])], ["D:/demo/lib", "\\\\server\\share"]);
	assert.deepEqual([...normalizeAcpAdditionalDirectories(["/opt/shared", "~/home"])], ["/opt/shared"]);
});

test("去重：Windows 大小写与分隔符不敏感，保留第一次出现的写法", () => {
	assert.deepEqual([...normalizeAcpAdditionalDirectories(["D:/Demo/Lib", "d:\\demo\\lib", "D:/demo/lib/"])], ["D:/Demo/Lib"]);
});

test("与会话 cwd 相同的目录没有意义，去掉", () => {
	assert.deepEqual([...normalizeAcpAdditionalDirectories(["D:/proj", "D:/demo/lib"], "D:\\proj\\")], ["D:/demo/lib"]);
});

test("空列表 / 全部非法 / 非数组 = 没有额外根目录（清空）", () => {
	assert.equal(normalizeAcpAdditionalDirectories([]), null);
	assert.equal(normalizeAcpAdditionalDirectories(["relative"]), null);
	assert.equal(normalizeAcpAdditionalDirectories(null), null);
	assert.equal(normalizeAcpAdditionalDirectories("D:/demo"), null);
});

test("条数上限：超出部分丢弃，顺序保留", () => {
	const many = Array.from({ length: ACP_ADDITIONAL_DIRECTORIES_MAX + 5 }, (_, index) => `/d${index}`);
	const result = normalizeAcpAdditionalDirectories(many);
	assert.equal(result.length, ACP_ADDITIONAL_DIRECTORIES_MAX);
	assert.equal(result[0], "/d0");
	assert.equal(result.at(-1), `/d${ACP_ADDITIONAL_DIRECTORIES_MAX - 1}`);
});

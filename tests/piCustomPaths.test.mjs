import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 用户自加的 pi 候选路径：清洗/去重/限额（设置页「我添加的」分组的写入闸门）。
 *
 * 这是设置页列表的输入边界：字符串来自输入框与文件选择器之外的路径（含手工改过的 settings.json），
 * 写入前必须保证「绝对路径或 wsl 标记、去重、有上限」，否则列表与设置文件会被脏数据撑坏。
 */

const load = createTsSandbox();
const { sanitizePiCustomPaths, removePiCustomPath, upsertPiCustomPath, isAcceptablePiCustomPath, PI_CUSTOM_PATHS_LIMIT } = load("src/main/pi/piCustomPaths.ts");

const host = (value) => JSON.parse(JSON.stringify(value));

test("只接受绝对路径或 wsl:// 标记，其余一律拒绝", () => {
	assert.equal(isAcceptablePiCustomPath("/usr/local/bin/pi"), true);
	assert.equal(isAcceptablePiCustomPath("D:\\tools\\pi.cmd"), true);
	assert.equal(isAcceptablePiCustomPath("\\\\server\\share\\pi.exe"), true);
	assert.equal(isAcceptablePiCustomPath("wsl://Ubuntu/root/home/dev/.nvm/bin/pi"), true);
	assert.equal(isAcceptablePiCustomPath("./pi"), false);
	assert.equal(isAcceptablePiCustomPath("pi"), false);
	assert.equal(isAcceptablePiCustomPath("~/.local/bin/pi"), false);
});

test("清洗：去空白、丢非法项、按平台去重、超长丢弃", () => {
	const result = sanitizePiCustomPaths([" /opt/pi ", "relative/pi", 42, "", "/opt/pi", `${"/deep".repeat(2000)}`], "linux");
	assert.deepEqual(host(result.paths), ["/opt/pi"]);
	assert.equal(result.rejected.length, 4);
});

test("Windows 下去重大小写不敏感，Linux 下区分大小写", () => {
	assert.deepEqual(host(sanitizePiCustomPaths(["/opt/Pi", "/opt/pi"], "linux").paths), ["/opt/Pi", "/opt/pi"]);
	assert.deepEqual(host(sanitizePiCustomPaths(["C:\\Pi\\pi.cmd", "c:\\pi\\PI.CMD"], "win32").paths), ["C:\\Pi\\pi.cmd"]);
});

test("非数组输入当空列表处理（渲染层未初始化时不炸）", () => {
	assert.deepEqual(host(sanitizePiCustomPaths(undefined).paths), []);
	assert.deepEqual(host(sanitizePiCustomPaths(null).paths), []);
	assert.deepEqual(host(sanitizePiCustomPaths("pi").paths), []);
});

test("有条数上限，超出的部分被截断", () => {
	const many = Array.from({ length: PI_CUSTOM_PATHS_LIMIT + 5 }, (_, index) => `/opt/pi-${index}/pi`);
	assert.equal(sanitizePiCustomPaths(many).paths.length, PI_CUSTOM_PATHS_LIMIT);
});

test("upsert 保留原位置；remove 大小写不敏感", () => {
	const paths = ["/a/pi", "/b/pi", "/c/pi"];
	assert.deepEqual(host(upsertPiCustomPath(paths, "/b/pi")), ["/a/pi", "/b/pi", "/c/pi"]);
	assert.deepEqual(host(upsertPiCustomPath(paths, "/d/pi")), ["/a/pi", "/b/pi", "/c/pi", "/d/pi"]);
	assert.deepEqual(host(removePiCustomPath(paths, "/b/pi")), ["/a/pi", "/c/pi"]);
	assert.deepEqual(host(removePiCustomPath(["C:\\Pi\\pi.cmd"], "c:\\pi\\PI.CMD", "win32")), []);
});

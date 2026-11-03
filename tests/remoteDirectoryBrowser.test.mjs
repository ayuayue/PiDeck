import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 项目登记不再要求用户手打绝对路径：目录浏览器替换输入框，但选中后仍走 canonical 确认。
// SSH 与 WSL 共用一个浏览器（DirectoryBrowser），因此「认得哪条链路」的判定留在各自调用方。
const dialog = readFileSync("src/renderer/src/components/sidebar/RemoteProjectEnrollDialog.tsx", "utf8");
const browser = readFileSync("src/renderer/src/components/sidebar/DirectoryBrowser.tsx", "utf8");

test("enrollment uses the picker for both existing and create flows", () => {
	assert.doesNotMatch(dialog, /id="remote-enroll-path"/);
	assert.match(dialog, /<DirectoryBrowser key=\{`existing-\$\{state\.hostId\}\`}/);
	assert.match(dialog, /<DirectoryBrowser\s+key=\{`create-\$\{state\.hostId\}`\}/);
	assert.match(dialog, /id="remote-enroll-leaf"/);
	// 新建模式要父目录 + 合法叶名才允许提交。
	assert.match(dialog, /const createPathReady = createParent !== "" && isValidNewLeaf\(leaf\)/);
	assert.match(dialog, /state\.mode === "create" \? !createPathReady : state\.path\.trim\(\) === ""/);
});

test("remote dialog owns the SSH transport and its error copy", () => {
	assert.match(dialog, /desktopApi\.remoteHosts\.listDirs\(hostId, path\)/);
	assert.match(dialog, /SSH_HOST_NOT_READY/);
	assert.match(dialog, /REMOTE_LIST_DIRS_NOT_A_DIRECTORY/);
});

test("browser is transport-agnostic and read-only", () => {
	// 不认识 IPC / SSH / WSL：只吃注入的 load 与 describeError（没有 desktopApi 调用，也没有通道常量）。
	assert.doesNotMatch(browser, /desktopApi\.|ipcChannels|wslCommand/);
	assert.match(browser, /await loadRef\.current\(target\)/);
	assert.match(browser, /isVisibleRemoteDirectory\(entry\.name, showHidden\)/);
	assert.match(browser, /joinRemotePath\(current, entry\.name\)/);
	assert.match(browser, /dirParent/);
	assert.match(browser, /dirTruncated/);
	// 「目标不是目录」时退回父目录是两条链路共用的行为，码集合在这里合并。
	assert.match(browser, /NOT_A_DIRECTORY_CODES/);
	// 不提供写入/读取内容的入口。
	assert.doesNotMatch(browser, /readProject|upload|createDirectory/);
});

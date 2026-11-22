import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { latestRemoteFolderReveal, publishRemoteFolderReveal, subscribeRemoteFolderReveal } from "../src/renderer/src/utils/remoteFolderReveal.ts";

// 远端目录链接没有本机文件管理器入口：App 侧切到文件抽屉并发布「定位这个目录」请求，
// 由该项目的远端目录树消费。请求必须带 projectId（抽屉跟随当前项目）与 nonce
// （同一目录连点两次也要再次定位，只比路径会让第二次静默失效）。

test("定位请求保留最近一次并通知订阅者，nonce 递增", () => {
	const seen = [];
	const unsubscribe = subscribeRemoteFolderReveal((request) => seen.push(request));
	publishRemoteFolderReveal("project-1", "src/main");
	publishRemoteFolderReveal("project-1", "src/main");
	publishRemoteFolderReveal("project-2", "");
	unsubscribe();

	assert.deepEqual(
		seen.map((request) => [request.projectId, request.relativePath]),
		[
			["project-1", "src/main"],
			["project-1", "src/main"],
			["project-2", ""],
		],
	);
	// 同一目录连点两次：nonce 必须不同，否则消费方会把它当成同一次请求吞掉
	assert.ok(seen[1].nonce > seen[0].nonce);
	// 面板可能在请求之后才挂载：最近一次请求可补消费
	const latest = latestRemoteFolderReveal();
	assert.equal(latest.projectId, "project-2");
	assert.equal(latest.relativePath, "");
	assert.equal(latest.nonce, seen[2].nonce);
});

test("没有项目身份的请求直接丢弃，退订后不再投递", () => {
	const before = latestRemoteFolderReveal()?.nonce ?? 0;
	publishRemoteFolderReveal("", "src");
	assert.equal(latestRemoteFolderReveal()?.nonce ?? 0, before);

	let calls = 0;
	const unsubscribe = subscribeRemoteFolderReveal(() => {
		calls += 1;
	});
	publishRemoteFolderReveal("project-3", "docs");
	assert.equal(calls, 1);
	unsubscribe();
	publishRemoteFolderReveal("project-3", "docs");
	assert.equal(calls, 1);
});

const treeSource = readFileSync("src/renderer/src/hooks/useRemoteFileTree.ts", "utf8");
const linkSource = readFileSync("src/renderer/src/hooks/workspace/useSessionFileLinks.ts", "utf8");
const openerSource = readFileSync("src/renderer/src/hooks/useSessionFilePathOpener.ts", "utf8");

test("目录树只消费自己项目的请求：先补 recent 再订阅，同一 nonce 只展开一次", () => {
	assert.match(treeSource, /const pending = latestRemoteFolderReveal\(\);/);
	assert.match(treeSource, /return subscribeRemoteFolderReveal\(consume\);/);
	assert.match(treeSource, /if \(request\.projectId !== projectId \|\| request\.nonce === handledNonce\) return;/);
	assert.match(treeSource, /void reveal\(request\.relativePath\);/);
});

test("会话链接路由：远端目录切到文件抽屉并发布定位请求，opener 不再走 files:open", () => {
	// 抽屉已是文件面板时不得再调 openDrawer（它是「再点一次收起」语义）
	assert.match(linkSource, /if \(workspace\.drawer !== "files" \|\| workspace\.drawerCollapsed\) workspace\.openDrawer\("files"\);/);
	assert.match(linkSource, /publishRemoteFolderReveal\(target\.projectId, target\.relativePath\);/);
	assert.match(linkSource, /onOpenRemoteDirectory: openRemoteDirectory \}\)/);
	// 远端目录在 opener 里被接管：不能再落到本机 shell.openPath（必然 UNSUPPORTED_CAPABILITY）
	assert.match(openerSource, /if \(typeof path !== "string"\) \{\s*\n\s*onOpenRemoteDirectory\(path\);\s*\n\s*return;/);
});

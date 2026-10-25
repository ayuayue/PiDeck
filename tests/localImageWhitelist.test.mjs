import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isInsideAnyRoot } = loadTsCommonJs("src/main/media/localImageAccess.ts");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const planDoc = readFileSync("docs/markdown-image-rendering-plan.md", "utf8");

/**
 * 白名单根的组装契约（2026-10-21 真机事故）。
 *
 * 会话里贴的图被降级成「图片加载失败 · <路径>」，查下来是协议层 403：
 * `~/Desktop/PiDeck-Settings-triage/x.png` 存在、形态合法、体积远低于上限，
 * 但**桌面不在白名单**——而桌面正是人和 agent 最常放截图/设计稿的地方。
 *
 * 这里守两件事：根列表必须含桌面（且用 Electron 的桌面路径而不是拼 home），
 * 以及文档要同步说明（否则下一个人会把它当「任意本地图可读」再改回去）。
 */

test('白名单根必须包含桌面，且用 app.getPath("desktop")', () => {
	assert.match(mainIndex, /app\.getPath\("desktop"\)/, '桌面根必须走 app.getPath("desktop")（跟随用户重定向）');
	assert.match(mainIndex, /app\.getPath\("userData"\)/, "userData 根保留");
	assert.match(mainIndex, /join\(app\.getPath\("temp"\), "pideck-shots"\)/, "专属临时图目录保留（不放行整个 %TEMP%）");
});

test("桌面子目录里的图片能通过边界判定", () => {
	const desktop = ["C:", "Users", "Administrator", "Desktop"].join(sep);
	assert.equal(isInsideAnyRoot([desktop, "PiDeck-Settings-triage", "03-advanced.png"].join(sep), [desktop]), true);
	assert.equal(isInsideAnyRoot(["C:", "Users", "Administrator", "DesktopX", "a.png"].join(sep), [desktop]), false);
});

test("计划文档必须写明桌面在白名单内", () => {
	assert.match(planDoc, /桌面/, "文档要说明桌面已放行，避免后续把它当漏洞改回去");
});

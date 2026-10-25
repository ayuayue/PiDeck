import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const shared = loadTsCommonJs("src/shared/localImage.ts");
const access = loadTsCommonJs("src/main/media/localImageAccess.ts");

/**
 * `pideck-file://` 协议契约（2026-10 对话内图片渲染改造）。
 *
 * 这个协议把「渲染层能不能读某个本地文件」实体化了，判据必须钉死：
 * 形态（绝对路径 + 图片扩展名）→ 真实路径边界（白名单根）→ 体积。
 * 纯函数部分在这里测；I/O 分支（realpath/stat/read）由 smoke 覆盖。
 *
 * 回归来历：`app.getPath("temp")` 在 Windows 上返回 8.3 短名（`C:\Users\ADMINI~1\…`），
 * 消息里的路径是长名（`C:\Users\Administrator\…`）——两侧不 realpath 就永远不相等，
 * 白名单内的临时图片全被判 403（2026-10-19 真机 smoke 暴露，见 canonicalizeRoots 用例）。
 */

const { LOCAL_IMAGE_MAX_BYTES, localImageUrl, parseLocalImageUrl, localImageMimeType, isLocalImageExtension } = shared;
const { canonicalizeRoots, classifyLocalImagePath, isInsideAnyRoot, isInsideRoot, isLocalImageSizeAllowed } = access;

// 跨平台根目录：Windows 上是 <当前盘>:\pideck-root，POSIX 上是 /pideck-root
const ROOT = path.resolve(`${path.sep}pideck-root`);
const OTHER_ROOT = `${ROOT}-other`;
const child = (...segments) => path.join(ROOT, ...segments);

/** 判定结果来自 vm 沙箱里的另一个 realm，跨 realm 对象用 deepStrictEqual 会因原型不同而假红。 */
const verdict = (rawPath) => {
	const result = classifyLocalImagePath(rawPath);
	return result.ok ? "ok" : result.status;
};

test("URL 往返：盘符/空格/中文都能原样回来", () => {
	for (const absolutePath of [child("a b", "截图.png"), path.join(OTHER_ROOT, "x.webp")]) {
		assert.equal(parseLocalImageUrl(localImageUrl(absolutePath)), absolutePath);
	}
	assert.equal(localImageUrl(child("a.png")).startsWith("pideck-file://local/?path="), true);
});

test("解析只认 pideck-file://local/，其它 host/协议/缺参数一律 null", () => {
	assert.equal(parseLocalImageUrl("pideck-file://evil/?path=%2Ftmp%2Fa.png"), null);
	assert.equal(parseLocalImageUrl("pideck-img://blob/a.png"), null);
	assert.equal(parseLocalImageUrl("pideck-file://local/?file=%2Ftmp%2Fa.png"), null);
	assert.equal(parseLocalImageUrl("not a url"), null);
});

test("扩展名白名单与 MIME 映射：未知扩展名拒绝", () => {
	assert.equal(localImageMimeType("a.PNG"), "image/png");
	assert.equal(localImageMimeType("a.svg"), "image/svg+xml");
	assert.equal(localImageMimeType("a.txt"), null);
	assert.equal(localImageMimeType("no-extension"), null);
	assert.equal(isLocalImageExtension("a.avif"), true);
	assert.equal(isLocalImageExtension("a.exe"), false);
});

test("形态闸：空/相对路径 400，控制字符 400，UNC 与非图片 403", () => {
	assert.equal(verdict(null), 400);
	assert.equal(verdict(""), 400);
	assert.equal(verdict("relative/a.png"), 400);
	assert.equal(verdict(child("a\u0000.png")), 400);
	assert.equal(verdict("//server/share/a.png"), 403);
	assert.equal(verdict(child("a.txt")), 403);
	assert.equal(verdict(child("sub", "a.PNG")), "ok");
});

test("边界闸：白名单外拒绝，白名单内放行", () => {
	assert.equal(isInsideAnyRoot(child("sub", "a.PNG"), [ROOT]), true);
	assert.equal(isInsideAnyRoot(path.join(OTHER_ROOT, "a.png"), [ROOT]), false);
	assert.equal(isInsideAnyRoot(child("a.png"), []), false);
});

test("isInsideRoot：同目录、子目录通过；同前缀兄弟目录与 .. 逃逸拒绝", () => {
	assert.equal(isInsideRoot(ROOT, ROOT), true);
	assert.equal(isInsideRoot(ROOT, child("a", "b.png")), true);
	// 前缀陷阱：F:\pideck-root-other 不是 F:\pideck-root 的子目录
	assert.equal(isInsideRoot(ROOT, path.join(`${ROOT}-other`, "a.png")), false);
	assert.equal(isInsideRoot(ROOT, path.join(ROOT, "..", "a.png")), false);
	assert.equal(isInsideRoot("", child("a.png")), false);
});

test("canonicalizeRoots：Windows 8.3 短名与长名归一后才算同一个根", async () => {
	const shortRoot = "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\pideck-shots";
	const longRoot = "C:\\Users\\Administrator\\AppData\\Local\\Temp\\pideck-shots";
	const longFile = `${longRoot}\\a.png`;
	const fakeRealpath = async (value) => (value.toLowerCase() === shortRoot.toLowerCase() ? longRoot : value);

	// 未归一：字符串不同 → 不在根内（这正是线上事故：白名单内的图被判 403）
	assert.equal(isInsideAnyRoot(longFile, [shortRoot]), false);
	// 归一后：同一目录，放行
	const canonical = await canonicalizeRoots([shortRoot], fakeRealpath);
	assert.equal(isInsideAnyRoot(longFile, canonical), true);
});

test("canonicalizeRoots：realpath 失败退回原值，重复根去重", async () => {
	const failing = async () => {
		throw new Error("ENOENT");
	};
	const result = await canonicalizeRoots([ROOT, ROOT, ""], failing);
	assert.equal(result.length, 1);
	assert.equal(result[0], ROOT);
});

test("体积闸：未知大小与超限都拒绝", () => {
	assert.equal(isLocalImageSizeAllowed(0), true);
	assert.equal(isLocalImageSizeAllowed(LOCAL_IMAGE_MAX_BYTES), true);
	assert.equal(isLocalImageSizeAllowed(LOCAL_IMAGE_MAX_BYTES + 1), false);
	assert.equal(isLocalImageSizeAllowed(undefined), false);
	assert.equal(isLocalImageSizeAllowed(Number.NaN), false);
});

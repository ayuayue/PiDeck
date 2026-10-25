import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { imageDownloadName, imageFileExtension } = loadTsCommonJs("src/shared/imageFilename.ts");

/**
 * 图片落盘名契约（2026-10-20 review P2-1）。
 *
 * 来历：这条映射原先在 `imageActions`（附件图/生图）与 `MarkdownImageActions`（正文图）
 * 各写一份，且**两份不一致**——前者只认 jpeg/webp/gif，svg/avif/bmp 全被存成 `.png`。
 * 合并后这里守住：扩展名按真实 MIME、文件名裁掉路径与 Windows 非法字符、空名有兜底。
 */

test("扩展名按真实 MIME，而不是 URL 后缀", () => {
	assert.equal(imageFileExtension("image/png"), "png");
	assert.equal(imageFileExtension("image/jpeg"), "jpg");
	assert.equal(imageFileExtension("image/jpg"), "jpg");
	assert.equal(imageFileExtension("image/webp"), "webp");
	assert.equal(imageFileExtension("image/gif"), "gif");
	assert.equal(imageFileExtension("image/svg+xml"), "svg");
	assert.equal(imageFileExtension("image/avif"), "avif");
	assert.equal(imageFileExtension("image/bmp"), "bmp");
	// provider 偶发返回 octet-stream：按 png 兜底
	assert.equal(imageFileExtension("application/octet-stream"), "png");
	assert.equal(imageFileExtension(""), "png");
});

test("文件名：裁掉路径与 Windows 非法字符，保留中文", () => {
	assert.equal(imageDownloadName("架构图", "image/png"), "架构图.png");
	assert.equal(imageDownloadName("C:\\tmp\\a:b*c?.jpg", "image/jpeg"), "Ctmpabc.jpg");
	assert.equal(imageDownloadName("  spaced  ", "image/webp"), "spaced.webp");
});

test("文件名为空时用兜底名", () => {
	assert.equal(imageDownloadName("", "image/png"), "pideck-image.png");
	assert.equal(imageDownloadName("///", "image/gif"), "pideck-image.gif");
	assert.equal(imageDownloadName("", "image/png", "截图"), "截图.png");
});

test("超长名字截断到 40 字符（避免超过文件系统上限）", () => {
	const name = imageDownloadName("图".repeat(120), "image/png");
	assert.equal(name.endsWith(".png"), true);
	assert.equal(name.length, 44);
});

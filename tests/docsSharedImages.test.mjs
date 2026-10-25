/**
 * README 与官网共用图片（docs/images → 站点 /images）的契约测试。
 *
 * 背景：README 用仓库相对路径 `docs/images/wechat-qrcode.png`，官网用站点根路径
 * `/images/wechat-qrcode.png`。两者指向不同物理位置，靠 VitePress 插件把源图同步进
 * `docs-site/public/images/`（生成物，已 gitignore）。这里守护四件事，任一条失守都会表现为
 * 「官网首页挂着一张破图」或「README 换了图官网没换」：
 *   1. 唯一数据源真实存在（否则构建期才会报错）；
 *   2. 生成的副本不进版本库（避免又变回两份需要手工同步的图）；
 *   3. README / 官网引用路径与源文件一致，且各自用对前缀；
 *   4. 同步函数在源图缺失时硬失败，不静默跳过。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SHARED_README_IMAGES, resolveSharedImageSource, syncSharedReadmeImages } from "../docs-site/.vitepress/sharedReadmeImages.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DOCS_IMAGES_DIR = join(REPO_ROOT, "docs", "images");

test("共用图片源文件存在于 docs/images（唯一数据源）", () => {
	for (const name of SHARED_README_IMAGES) {
		const source = resolveSharedImageSource(name, DOCS_IMAGES_DIR);
		assert.ok(existsSync(source), `缺少 docs/images/${name}，构建产物会引用到不存在的图片`);
	}
});

test("生成副本被 gitignore，不会退化回两份手工同步的图", () => {
	const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
	for (const name of SHARED_README_IMAGES) {
		// 逐行比对而不是 includes：避免注释里提到文件名也算通过
		const ignored = gitignore.split("\n").some((line) => line.trim() === `docs-site/public/images/${name}`);
		assert.ok(ignored, `.gitignore 未忽略 docs-site/public/images/${name}`);
	}
});

test("README 中英文与官网首页都用同一张微信群二维码图", () => {
	// 中英文 README 与 zh/en 首页四处必须一致；只改一边就是「一半文档挂旧二维码」
	const expectations = [
		["README.md", "docs/images/wechat-qrcode.png"],
		["README.en.md", "docs/images/wechat-qrcode.png"],
		[join("docs-site", "index.md"), "/images/wechat-qrcode.png"],
		[join("docs-site", "en", "index.md"), "/images/wechat-qrcode.png"],
	];
	for (const [file, expected] of expectations) {
		const content = readFileSync(join(REPO_ROOT, file), "utf8");
		assert.ok(content.includes(expected), `${file} 未引用 ${expected}`);
	}
});

test("官网首页用站点相对路径、README 用仓库相对路径（交叉引用会变破图）", () => {
	const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
	assert.ok(!readme.includes('src="/images/wechat-qrcode.png"'), "README 里不能用站点根路径");

	const siteIndex = readFileSync(join(REPO_ROOT, "docs-site", "index.md"), "utf8");
	assert.ok(!siteIndex.includes("docs/images/wechat-qrcode.png"), "官网首页里不能用仓库相对路径");
});

test("微信号与 QQ 群号在 README 和官网都对用户可见", () => {
	// 用户需求是「QQ 群同级加上微信号」：只补二维码、不写微信号等于把加好友入口藏进图片里
	for (const file of ["README.md", "README.en.md", join("docs-site", "index.md"), join("docs-site", "en", "index.md")]) {
		const content = readFileSync(join(REPO_ROOT, file), "utf8");
		assert.ok(content.includes("1026218644"), `${file} 丢失 QQ 群号`);
		assert.ok(content.includes("caoayu97"), `${file} 丢失微信号`);
	}
});

test("小店价目表图：README 与官网首页引用同一张共用图", () => {
	// 小店价目表会随行情改（价格/套餐），两边各存一份就会变成「README 是新价、官网还挂着旧价」。
	const expectations = [
		["README.md", "docs/images/gpt-recharge-price.png"],
		[join("docs-site", "index.md"), "/images/gpt-recharge-price.png"],
	];
	for (const [file, expected] of expectations) {
		const content = readFileSync(join(REPO_ROOT, file), "utf8");
		assert.ok(content.includes(expected), `${file} 未引用 ${expected}`);
	}
	assert.ok(SHARED_README_IMAGES.includes("gpt-recharge-price.png"), "价目表图必须在共用图片白名单里，否则站点 404");
});

test("syncSharedReadmeImages 把源图复制进 publicDir/images", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pideck-shared-img-"));
	try {
		const sourceDir = join(tmp, "source");
		const publicDir = join(tmp, "public");
		mkdirSync(sourceDir, { recursive: true });
		for (const name of SHARED_README_IMAGES) {
			writeFileSync(join(sourceDir, name), `fake-${name}`);
		}

		syncSharedReadmeImages(publicDir, sourceDir);

		for (const name of SHARED_README_IMAGES) {
			const target = join(publicDir, "images", name);
			assert.ok(existsSync(target), `未同步 ${name}`);
			assert.equal(readFileSync(target, "utf8"), `fake-${name}`);
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("源图缺失时硬失败，不静默跳过", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pideck-shared-img-missing-"));
	try {
		const emptySource = join(tmp, "empty");
		mkdirSync(emptySource, { recursive: true });

		assert.throws(() => syncSharedReadmeImages(join(tmp, "public"), emptySource), /缺少共用图片/, "缺图必须抛错，否则线上会发一张破图");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

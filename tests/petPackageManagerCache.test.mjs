import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PetPackageScanner, petSpriteUrl } from "../src/main/pet/petPackageScanner.ts";

/**
 * PetPackageScanner 缓存契约：
 * - spritesheet 指纹（mtime+size）未变时 list() 必须零 IO 复用缓存；
 * - manifest 只携带 pideck-pet:// 协议 URL（不内嵌 base64 大图）；
 * - petdex 的 spritesheetPath 不得逃逸 petsRoot（协议 handler 依赖此白名单）。
 */

/** 创建临时宠物库：1 个内置（sprite.bin 内容 A）+ 1 个 petdex 包（sprite.bin 内容 B） */
async function makeFixture() {
	const root = await mkdtemp(join(tmpdir(), "petscanner-"));
	const builtinDir = join(root, "builtin");
	const petdexDir = join(root, "petdex");
	await mkdir(builtinDir, { recursive: true });
	await mkdir(join(petdexDir, "capy"), { recursive: true });

	const builtinSprite = join(builtinDir, "spritesheet.bin");
	const petdexSprite = join(petdexDir, "capy", "sprite.bin");
	await writeFile(builtinSprite, "BUILTIN-A");
	await writeFile(petdexSprite, "PETDEX-B");
	await writeFile(
		join(petdexDir, "capy", "pet.json"),
		JSON.stringify({
			id: "capy",
			displayName: "Capy",
			spritesheetPath: "sprite.bin",
		}),
	);

	const scanner = new PetPackageScanner([{ id: "clawd", displayName: "Clawd", description: "", spritePath: builtinSprite }], petdexDir);
	return { root, builtinSprite, petdexDir, scanner };
}

test("first list scans builtin + petdex with lightweight protocol URLs", async () => {
	const { root, scanner } = await makeFixture();
	try {
		const list = await scanner.list();
		assert.equal(list.length, 2);
		const clawd = list.find((m) => m.id === "clawd");
		const capy = list.find((m) => m.id === "capy");
		// manifest 只带协议 URL，不内嵌 base64 图片数据（IPC 传输保持 KB 级）
		assert.equal(clawd.spritesheetUrl, petSpriteUrl("clawd"));
		assert.equal(capy.spritesheetUrl, petSpriteUrl("capy"));
		assert.equal(clawd.source, "builtin");
		assert.equal(capy.source, "petdex");
		// resolveSpritePath 提供协议 handler 所需的磁盘路径
		assert.equal(await scanner.resolveSpritePath("clawd"), join(root, "builtin", "spritesheet.bin"));
		assert.equal(await scanner.resolveSpritePath("capy"), join(root, "petdex", "capy", "sprite.bin"));
		assert.equal(await scanner.resolveSpritePath("unknown"), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("unchanged fingerprints reuse cached result even if file content changed under same mtime+size", async () => {
	const { root, builtinSprite, scanner } = await makeFixture();
	try {
		// 先把 mtime 规整到秒级对齐的整数毫秒（文件系统会截断小数，需先规整再取指纹）
		const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
		await utimes(builtinSprite, t0, t0);

		const first = await scanner.list();
		assert.equal(first.find((m) => m.id === "clawd").spritesheetUrl, petSpriteUrl("clawd"));

		// 等长替换内容并回滚 mtime：指纹不变 → 必须返回缓存（不重读文件）
		await writeFile(builtinSprite, "BUILTIN-X");
		await utimes(builtinSprite, t0, t0);

		const second = await scanner.list();
		assert.equal(second, first, "指纹未变应复用缓存");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("mtime change invalidates cache and rescans", async () => {
	const { root, builtinSprite, scanner } = await makeFixture();
	try {
		// 规整 mtime，保证后续变化可被指纹捕获
		const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
		await utimes(builtinSprite, t0, t0);
		await scanner.list();

		// 内容 + mtime 都变化（writeFile 更新 mtime，再显式前移确保差异）
		await writeFile(builtinSprite, "BUILTIN-Y");
		await utimes(builtinSprite, new Date(Date.now() + 1000), new Date(Date.now() + 5000));

		const list = await scanner.list();
		assert.equal(list.find((m) => m.id === "clawd").spritesheetUrl, petSpriteUrl("clawd"), "mtime 变化应重扫");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("new petdex package invalidates cache and appears in the list", async () => {
	const { root, petdexDir, scanner } = await makeFixture();
	try {
		const first = await scanner.list();
		assert.equal(
			first.some((m) => m.id === "capy"),
			true,
		);

		// 新增社区包目录
		await mkdir(join(petdexDir, "octo"), { recursive: true });
		await writeFile(join(petdexDir, "octo", "sprite.bin"), "OCTO-C");
		await writeFile(
			join(petdexDir, "octo", "pet.json"),
			JSON.stringify({
				id: "octo",
				displayName: "Octo",
				spritesheetPath: "sprite.bin",
			}),
		);

		const second = await scanner.list();
		assert.equal(
			second.some((m) => m.id === "octo"),
			true,
			"新增目录应触发重扫",
		);
		assert.equal(await scanner.resolveSpritePath("octo"), join(petdexDir, "octo", "sprite.bin"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent list calls share one result and cache is stable across calls", async () => {
	const { root, scanner } = await makeFixture();
	try {
		const [a, b, c] = await Promise.all([scanner.list(), scanner.list(), scanner.list()]);
		assert.equal(a.length, 2);
		assert.equal(b.length, 2);
		assert.equal(c.length, 2);
		// 缓存命中：第二次 list 与第一次返回同一数组引用（未重扫）
		const again = await scanner.list();
		assert.equal(again, a, "指纹未变时返回同一缓存引用");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("builtin sprite removal is reflected after fingerprint change", async () => {
	const { root, builtinSprite, scanner } = await makeFixture();
	try {
		const first = await scanner.list();
		assert.equal(
			first.some((m) => m.id === "clawd"),
			true,
		);
		await rm(builtinSprite);
		const second = await scanner.list();
		assert.equal(
			second.some((m) => m.id === "clawd"),
			false,
			"文件删除应触发重扫并移除",
		);
		assert.equal(await scanner.resolveSpritePath("clawd"), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("petdex spritesheetPath cannot escape petsRoot (protocol whitelist safety)", async () => {
	const { root, petdexDir, scanner } = await makeFixture();
	try {
		// 逃逸包：spritesheetPath 指向 petsRoot（petdex）之外的文件（协议 handler 依赖此白名单）
		const outside = join(root, "outside.bin");
		await writeFile(outside, "SECRET");
		await mkdir(join(petdexDir, "evil"), { recursive: true });
		await writeFile(
			join(petdexDir, "evil", "pet.json"),
			JSON.stringify({
				id: "evil",
				displayName: "Evil",
				spritesheetPath: "../../outside.bin",
			}),
		);

		const list = await scanner.list();
		assert.equal(
			list.some((m) => m.id === "evil"),
			false,
			"逃逸路径的包必须被跳过",
		);
		assert.equal(await scanner.resolveSpritePath("evil"), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

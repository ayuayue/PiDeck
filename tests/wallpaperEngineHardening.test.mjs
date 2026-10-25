import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Wallpaper Engine 视频壁纸加固（在第一期之上）：
 * - project.json 尾部 NUL 填充容错；
 * - 手选目录（Steam 根 / steamapps / workshop/content）归一化到 .../431960；
 * - 列表阶段 canPlayType 判定 + <video> error 回退到预览图或无壁纸并提示。
 */

const shared = loadTsCommonJs("src/shared/wallpaperEngine.ts");
const lib = loadTsCommonJs("src/main/wallpaperEngine/wallpaperEngineLibrary.ts", { globals: { Response, Request, ReadableStream, URL } });

test("project.json with trailing NUL padding (and BOM) still parses and lists", async () => {
	const raw = `\uFEFF${JSON.stringify({ title: "Padded", type: "video", file: "a.mp4" })}\0\0\0\n\0`;
	const item = shared.parseWallpaperEngineProject("42", raw);
	assert.equal(item?.title, "Padded");
	// 中间内容不被改动：字符串里的 \0 转义保持原样
	assert.equal(shared.parseWallpaperEngineProject("43", `${JSON.stringify({ title: "a\u0000b", type: "video", file: "a.mp4" })}\0`)?.title, "a\u0000b");
	const dir = mkdtempSync(join(tmpdir(), "we-nul-"));
	try {
		mkdirSync(join(dir, "42"));
		writeFileSync(join(dir, "42", "project.json"), raw);
		const result = await lib.listWallpaperEngineItems(dir);
		assert.deepEqual(
			Array.from(result.items, (i) => i.id),
			["42"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("picked folder is normalized from Steam root / steamapps / workshop / content to .../431960", async () => {
	const root = mkdtempSync(join(tmpdir(), "we-steam-"));
	try {
		const content = join(root, "steamapps", "workshop", "content", "431960");
		mkdirSync(join(content, "7"), { recursive: true });
		writeFileSync(join(content, "7", "project.json"), JSON.stringify({ title: "T", type: "video", file: "a.mp4" }));
		for (const picked of [root, join(root, "steamapps"), join(root, "steamapps", "workshop"), join(root, "steamapps", "workshop", "content"), content]) {
			assert.equal(await lib.resolveWorkshopContentDir(picked), content, picked);
		}
		// 不相关目录原样返回（可能是自建条目目录）
		const other = mkdtempSync(join(tmpdir(), "we-other-"));
		assert.equal(await lib.resolveWorkshopContentDir(other), other);
		rmSync(other, { recursive: true, force: true });
		assert.equal(await lib.resolveWorkshopContentDir(""), "");
		// 纯函数：候选顺序从深到浅，最后是原目录
		assert.deepEqual(Array.from(shared.wallpaperEngineDirCandidates("/s", (...p) => p.join("/"))), ["/s/steamapps/workshop/content/431960", "/s/workshop/content/431960", "/s/content/431960", "/s/431960", "/s"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("IPC: pick-dir and list go through the folder normalization", async () => {
	const { readFileSync } = await import("node:fs");
	const ipc = readFileSync("src/main/ipc/wallpaperEngineIpc.ts", "utf8");
	assert.match(ipc, /return picked \? resolveWorkshopContentDir\(picked\) : ""/);
	assert.match(ipc, /listWallpaperEngineItems\(await resolveWorkshopContentDir\(/);
});

test("codec probe: list-time playability from canPlayType (headless Electron answers recorded in codec-probe.log)", () => {
	// 模拟无 GPU 的 Electron：mp4/webm 可播，quicktime 不可播
	const answers = { "video/mp4": "maybe", "video/webm": "maybe", "video/quicktime": "" };
	const canPlayType = (mime) => answers[mime] ?? "";
	assert.equal(shared.wallpaperEnginePlayability("a.mp4", canPlayType), "maybe");
	assert.equal(shared.wallpaperEnginePlayability("a.webm", canPlayType), "maybe");
	assert.equal(shared.wallpaperEnginePlayability("a.mov", canPlayType), "unsupported");
	assert.equal(
		shared.wallpaperEnginePlayability("a.exe", () => "probably"),
		"unsupported",
	);
	assert.equal(
		shared.wallpaperEnginePlayability("a.mp4", () => "probably"),
		"probably",
	);
});

test("codec fallback: video error → preview image → no wallpaper", () => {
	const videoWallpaper = loadTsCommonJs("src/renderer/src/hooks/appearance/videoWallpaper.ts");
	assert.equal(videoWallpaper.videoWallpaperRender({ videoFailed: false, previewFailed: false }), "video");
	assert.equal(videoWallpaper.videoWallpaperRender({ videoFailed: true, previewFailed: false }), "preview");
	assert.equal(videoWallpaper.videoWallpaperRender({ videoFailed: true, previewFailed: true }), "none");
});

test("codec wiring: layer handles <video> error with a toast + preview, settings marks unsupported items", async () => {
	const { readFileSync } = await import("node:fs");
	const layer = readFileSync("src/renderer/src/components/app/wallpaper/WallpaperVideoLayer.tsx", "utf8");
	assert.match(layer, /onError=\{\(\) => \{\s*setFailedSrc\(src\);\s*toast\.warning\(t\("settings\.wallpaperEnginePlaybackFailed"\)\);/);
	assert.match(layer, /<img key=\{src\} src=\{wallpaperEnginePreviewUrl\(settings\.weWallpaperId\)\} alt="" onError=\{\(\) => setPreviewFailedSrc\(src\)\}/);
	const section = readFileSync("src/renderer/src/components/app/settings/WallpaperEngineSection.tsx", "utf8");
	assert.match(section, /wallpaperEnginePlayability\(item\.file, canPlayType\) === "unsupported"/);
	assert.match(section, /t\("settings\.wallpaperEngineUnsupported"\)/);
	for (const locale of ["zh-CN", "en-US", "zh-TW"]) {
		const copy = readFileSync(`src/renderer/src/i18n/rendererCopy.${locale}.ts`, "utf8");
		assert.match(copy, /"settings\.wallpaperEngineUnsupported":/, locale);
		assert.match(copy, /"settings\.wallpaperEnginePlaybackFailed":/, locale);
	}
});

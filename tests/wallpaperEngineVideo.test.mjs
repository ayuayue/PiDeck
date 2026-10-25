import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Wallpaper Engine 视频壁纸（第一期，仅 type=video）。
 * - project.json 只取 title/type/file/preview，只接受 video，拒绝 scene/web/application 与逃逸路径；
 * - pideck-we:// 处理器：Range 流式（206）、ID 白名单、符号链接逃逸 403、非 video 404；
 * - 视频壁纸开启时沿用壁纸模式的面板半透明档位，且不再挂静态图；
 * - 失焦/最小化暂停；接线：协议 stream:true、CSP media-src、IPC 只有三条窄通道。
 */

const shared = loadTsCommonJs("src/shared/wallpaperEngine.ts");
// loadTsCommonJs 的 VM 沙箱不自带 Fetch 全局：把宿主的 Response/ReadableStream 交给它
const lib = loadTsCommonJs("src/main/wallpaperEngine/wallpaperEngineLibrary.ts", { globals: { Response, Request, ReadableStream, URL } });
const videoWallpaper = loadTsCommonJs("src/renderer/src/hooks/appearance/videoWallpaper.ts");

function makeLibrary() {
	const dir = mkdtempSync(join(tmpdir(), "we-lib-"));
	const item = (id, project, files = {}) => {
		mkdirSync(join(dir, id), { recursive: true });
		writeFileSync(join(dir, id, "project.json"), typeof project === "string" ? project : JSON.stringify(project));
		for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, id, name), data);
	};
	return { dir, item, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("project.json: keeps only title/type/file/preview and accepts only video", () => {
	const ok = shared.parseWallpaperEngineProject("123", JSON.stringify({ title: " Rain ", type: "Video", file: "rain.mp4", preview: "preview.gif", general: { properties: { x: 1 } }, workshopid: "123" }));
	assert.deepEqual({ ...ok }, { id: "123", title: "Rain", type: "video", file: "rain.mp4", preview: "preview.gif" });
	for (const type of ["scene", "web", "application", ""]) {
		assert.equal(shared.parseWallpaperEngineProject("1", JSON.stringify({ type, file: "a.mp4" })), null, type);
	}
	for (const file of ["../x.mp4", "/etc/x.mp4", "C:/x.mp4", "a/../../x.mp4", "a\\..\\x.mp4", "x.exe", ""]) {
		assert.equal(shared.parseWallpaperEngineProject("1", JSON.stringify({ type: "video", file })), null, file);
	}
	assert.equal(shared.parseWallpaperEngineProject("../1", JSON.stringify({ type: "video", file: "a.mp4" })), null);
	assert.equal(shared.parseWallpaperEngineProject("1", "{not json"), null);
	assert.equal(shared.parseWallpaperEngineProject("1", "\uFEFF" + JSON.stringify({ type: "video", file: "a.webm" })).title, "1");
	assert.equal(shared.wallpaperEngineVideoUrl("42"), "pideck-we://video/42");
	assert.equal(shared.wallpaperEngineVideoUrl("../42"), "");
});

test("library: lists only video items from the workshop folder", async () => {
	const L = makeLibrary();
	try {
		L.item("200", { title: "B video", type: "video", file: "b.mp4" });
		L.item("100", { title: "A video", type: "video", file: "a.webm" });
		L.item("300", { title: "Scene", type: "scene", file: "scene.json" });
		L.item("400", { title: "Web", type: "web", file: "index.html" });
		mkdirSync(join(L.dir, "not-an-id"));
		const res = await lib.listWallpaperEngineItems(L.dir);
		assert.deepEqual([...res.items.map((i) => i.id)], ["100", "200"]);
		assert.equal(res.error, undefined);
		assert.equal((await lib.listWallpaperEngineItems("")).error, "no-dir");
		assert.equal((await lib.listWallpaperEngineItems(join(L.dir, "missing"))).error, "unreadable");
	} finally {
		L.cleanup();
	}
});

test("pideck-we:// handler streams video with Range and refuses escapes", async () => {
	const L = makeLibrary();
	const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
	try {
		L.item("111", { type: "video", file: "clip.mp4", preview: "p.png" }, { "clip.mp4": bytes, "p.png": Buffer.from([137, 80, 78, 71]) });
		L.item("222", { type: "scene", file: "scene.pkg" }, { "scene.pkg": "x" });
		writeFileSync(join(L.dir, "secret.mp4"), "secret");
		mkdirSync(join(L.dir, "333"));
		// 符号链接在无开发者模式的 Windows 上创建会被拒（EPERM）：此时跳过逃逸断言（与
		// projectFileAccess.test.mjs 的 skip 惯例一致），其余 Range/404/403 断言照常执行。
		let symlinkReady = true;
		try {
			symlinkSync(join(L.dir, "secret.mp4"), join(L.dir, "333", "link.mp4"));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") symlinkReady = false;
			else throw error;
		}
		writeFileSync(join(L.dir, "333", "project.json"), JSON.stringify({ type: "video", file: "link.mp4" }));
		const handle = lib.createWallpaperEngineHandler(() => L.dir);

		const full = await handle(new Request("pideck-we://video/111"));
		assert.equal(full.status, 200);
		assert.equal(full.headers.get("content-type"), "video/mp4");
		assert.equal(full.headers.get("accept-ranges"), "bytes");
		assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

		const part = await handle(new Request("pideck-we://video/111", { headers: { range: "bytes=10-19" } }));
		assert.equal(part.status, 206);
		assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
		assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));

		const open = await handle(new Request("pideck-we://video/111", { headers: { range: "bytes=990-" } }));
		assert.equal(open.status, 206);
		assert.equal((await open.arrayBuffer()).byteLength, 10);

		assert.equal((await handle(new Request("pideck-we://preview/111"))).status, 200);
		assert.equal((await handle(new Request("pideck-we://video/222"))).status, 404, "scene is not served");
		if (symlinkReady) assert.equal((await handle(new Request("pideck-we://video/333"))).status, 403, "symlink escape is refused");
		assert.equal((await handle(new Request("pideck-we://video/..%2F111"))).status, 403);
		assert.equal((await handle(new Request("pideck-we://other/111"))).status, 403);
		assert.equal((await lib.createWallpaperEngineHandler(() => "")(new Request("pideck-we://video/111"))).status, 404);
	} finally {
		L.cleanup();
	}
});

test("video wallpaper is active only with a folder and a numeric id; pauses when unfocused or hidden", () => {
	assert.equal(videoWallpaper.isVideoWallpaperActive({ weWorkshopDir: "/w", weWallpaperId: "12" }), true);
	assert.equal(videoWallpaper.isVideoWallpaperActive({ weWorkshopDir: "", weWallpaperId: "12" }), false);
	assert.equal(videoWallpaper.isVideoWallpaperActive({ weWorkshopDir: "/w", weWallpaperId: "" }), false);
	assert.equal(videoWallpaper.isVideoWallpaperActive({ weWorkshopDir: "/w", weWallpaperId: "a/b" }), false);
	assert.equal(videoWallpaper.shouldPlayVideoWallpaper({ hidden: false, focused: true }), true);
	assert.equal(videoWallpaper.shouldPlayVideoWallpaper({ hidden: false, focused: false }), false);
	assert.equal(videoWallpaper.shouldPlayVideoWallpaper({ hidden: true, focused: true }), false);
});

// ── useAppAppearance：视频壁纸沿用壁纸模式透明度档位（同 wallpaperSettingsModalReapply 的打包桩法） ──
const stubs = {
	react: `export const useRef = (v) => ({ current: v });
export const useState = (v) => [typeof v === "function" ? v() : v, () => {}];
export const useReducer = (_r, v) => [v, () => {}];
export const useEffect = (fn) => { fn(); };
export const useLayoutEffect = (fn) => { fn(); };`,
	themeAppearance: `export const applyAppearanceAttributes = (root) => { root.dataset.theme = "light"; };`,
	themeSchedule: `export const resolveAppColorScheme = () => "light"; export const msUntilNextThemeBoundary = () => 1e9;`,
	i18n: `export const ensureI18nLocale = async () => {}; export const isI18nLocaleLoaded = () => true; export const setI18nLocale = () => {}; export const resolveLocale = () => "zh-CN";`,
	appearanceTransition: `export const applyAppearanceWithTransition = ({ apply }) => apply();`,
};

async function loadAppearance() {
	const result = await build({
		entryPoints: ["src/renderer/src/hooks/appearance/useAppAppearance.ts"],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		logLevel: "silent",
		plugins: [
			{
				name: "stubs",
				setup(b) {
					b.onResolve({ filter: /^react$|themeAppearance$|themeSchedule$|i18n$|appearanceTransition$/ }, (args) => ({ path: args.path, namespace: "stub" }));
					b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[Object.keys(stubs).find((k) => args.path === k || args.path.endsWith(k))], loader: "js" }));
				},
			},
		],
	});
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function fakeRoot() {
	const sheet = new Map([
		["--color-bg-app", "#f5f5f5"],
		["--color-bg-sidebar", "#eeeeee"],
		["--color-bg-panel", "#ffffff"],
		["--color-card", "#ffffff"],
	]);
	const inline = new Map();
	const root = { dataset: {}, lang: "", style: { setProperty: (k, v) => inline.set(k, v), removeProperty: (k) => inline.delete(k), getPropertyValue: (k) => inline.get(k) ?? "" } };
	globalThis.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
	globalThis.document = { documentElement: root };
	globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => inline.get(k) ?? sheet.get(k) ?? "" });
	return root;
}

const settingsBase = {
	theme: "light",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
	weWorkshopDir: "",
	weWallpaperId: "",
	language: "zh-CN",
	fontSize: "md",
	fontFamilyBase: "system",
	fontFamilyBaseCustom: "",
	fontFamilyMono: "system",
	fontFamilyMonoCustom: "",
};

test("video wallpaper turns on wallpaper mode with the same panel opacity tier and no static image", async () => {
	const mod = await loadAppearance();
	const root = fakeRoot();
	mod.useAppAppearance({ settings: { ...settingsBase, backgroundImage: "bg-1.png", weWorkshopDir: "/w", weWallpaperId: "12" }, systemLanguage: null, settingsLoaded: true });
	assert.equal(root.dataset.bgImage, "on");
	assert.match(root.style.getPropertyValue("--color-bg-panel"), /^color-mix\(in srgb, .+ 30%, transparent\)$/);
	assert.equal(root.style.getPropertyValue("--app-bg-image"), "", "static image must not decode under the video");
	assert.match(root.style.getPropertyValue("--app-bg-mask"), /rgba\(255,255,255,0\.(2|19)/);

	const root2 = fakeRoot();
	mod.useAppAppearance({ settings: { ...settingsBase, backgroundImage: "bg-1.png" }, systemLanguage: null, settingsLoaded: true });
	assert.match(root2.style.getPropertyValue("--app-bg-image"), /pideck-bg:\/\/local\/bg-1\.png/, "static image path unchanged");

	const root3 = fakeRoot();
	mod.useAppAppearance({ settings: { ...settingsBase }, systemLanguage: null, settingsLoaded: true });
	assert.equal(root3.dataset.bgImage, "off");
});

test("wiring: streaming protocol, CSP, narrow IPC, video layer pauses and releases", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /scheme: "pideck-we", privileges: \{[^}]*stream: true/);
	assert.match(main, /registerWallpaperEngineProtocol\(/);
	const html = readFileSync("src/renderer/index.html", "utf8");
	assert.match(html, /media-src[^;]*pideck-we:/);
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	assert.deepEqual(ipc.match(/"wallpaper-engine:[a-z-]+"/g), ['"wallpaper-engine:pick-dir"', '"wallpaper-engine:list"', '"wallpaper-engine:select"']);
	const layer = readFileSync("src/renderer/src/components/app/wallpaper/WallpaperVideoLayer.tsx", "utf8");
	assert.match(layer, /<video[^>]*\bmuted\b[^>]*\bloop\b[^>]*\bplaysInline\b/);
	assert.match(layer, /addEventListener\("blur"/);
	assert.match(layer, /addEventListener\("visibilitychange"/);
	assert.match(layer, /removeAttribute\("src"\);\s*video\.load\(\)/);
	assert.match(readFileSync("src/renderer/src/App.tsx", "utf8"), /<WallpaperVideoLayer settings=\{settings\} \/>/);
});

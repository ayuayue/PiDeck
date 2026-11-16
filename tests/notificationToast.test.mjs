import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 系统通知 toast XML 契约（src/main/notifications/notificationToast.ts）：
 * - 品牌字标作为 appLogoOverride 注入（用户反馈：直接用应用图标＝近黑底板，深色 toast 上看成“logo 外一层边框”）；
 * - 资源缺失/裁剪包时静默去掉 image，退回系统默认图标；
 * - 点击跳转 URL 与 XML 转义保持原有语义。
 * 模块不依赖 electron，路径与 cwd 由调用方传入，故可直接加载。
 */
function loadToastModule() {
	return loadTsCommonJs("src/main/notifications/notificationToast.ts");
}

const { NOTIFICATION_BODY_MAX_CHARS, NOTIFICATION_TITLE_MAX_CHARS } = loadTsCommonJs("src/main/notifications/notificationText.ts");

test("toast XML 带品牌字标：appLogoOverride + file:// URI + 不裁圆", () => {
	const { buildToastXml } = loadToastModule();
	const xml = buildToastXml({
		title: "PiDeck",
		body: "会话已完成",
		launch: "pideck://session/abc",
		logoUri: "file:///D:/app/resources/notification-logo.png",
	});
	assert.match(xml, /<image placement="appLogoOverride" hint-crop="none" src="file:\/\/\/D:\/app\/resources\/notification-logo\.png" \/>/);
	// 点击以 protocol 激活方式回到主进程（原有行为不得回退）
	assert.match(xml, /<toast activationType="protocol" launch="pideck:\/\/session\/abc">/);
	assert.match(xml, /<text>PiDeck<\/text>/);
	assert.match(xml, /<text>会话已完成<\/text>/);
});

test("字标缺失时不注入 image，其余结构不变（老包/裁剪包静默降级）", () => {
	const { buildToastXml } = loadToastModule();
	const xml = buildToastXml({ title: "PiDeck", body: "b", launch: "pideck://", logoUri: null });
	assert.doesNotMatch(xml, /<image/);
	assert.match(xml, /<binding template="ToastGeneric">/);
	assert.match(xml, /<audio src="ms-winsoundevent:Notification.Default" \/>/);
});

test("跳出 URL：有 sessionId 直达会话，无则只唤起应用", () => {
	const { notificationLaunchUrl } = loadToastModule();
	assert.equal(notificationLaunchUrl("sess-1"), "pideck://session/sess-1");
	assert.equal(notificationLaunchUrl(undefined), "pideck://");
});

test("超长标题/正文按码点截断，避免 toast XML 膨胀", () => {
	const { buildToastXml } = loadToastModule();
	const xml = buildToastXml({ title: "题".repeat(1000), body: "文".repeat(5000), launch: "pideck://" });
	const texts = [...xml.matchAll(/<text>([^<]*)<\/text>/g)].map((match) => match[1]);
	assert.equal(Array.from(texts[0]).length, NOTIFICATION_TITLE_MAX_CHARS + 1);
	assert.equal(Array.from(texts[1]).length, NOTIFICATION_BODY_MAX_CHARS + 1);
	assert.ok(texts[0].endsWith("…"));
	assert.ok(xml.length < 1000, "XML 不应随标题长度膨胀");
});

test("emoji 截断不拆代理对", () => {
	const { buildToastXml } = loadToastModule();
	const xml = buildToastXml({ title: "😀".repeat(100), body: "ok", launch: "pideck://" });
	assert.doesNotMatch(xml, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("标题/正文/URL 中的 XML 元字符被转义，不破坏 XML 结构", () => {
	const { buildToastXml } = loadToastModule();
	const xml = buildToastXml({ title: "a & b", body: '<x> "y"', launch: "pideck://session/a&b" });
	assert.match(xml, /<text>a &amp; b<\/text>/);
	assert.match(xml, /<text>&lt;x&gt; &quot;y&quot;<\/text>/);
	assert.match(xml, /launch="pideck:\/\/session\/a&amp;b"/);
});

test("字标 URI 解析：dev 取仓库 resources/，打包取 resourcesPath，缺失返回 null", () => {
	const mod = loadToastModule();
	const { resolveNotificationLogoUri, resetNotificationLogoCacheForTest, NOTIFICATION_LOGO_FILENAME } = mod;
	const repoRoot = process.cwd();
	resetNotificationLogoCacheForTest();
	const dev = resolveNotificationLogoUri({ isPackaged: false, resourcesPath: "/nope", appPath: repoRoot });
	assert.ok(dev, "仓库内 resources/notification-logo.png 应存在");
	assert.match(dev, new RegExp(`${NOTIFICATION_LOGO_FILENAME.replace(".", "\\.")}$`));
	assert.match(dev, /^file:\/\/\//);
	resetNotificationLogoCacheForTest();
	const packaged = resolveNotificationLogoUri({ isPackaged: true, resourcesPath: "/definitely/missing/resources", appPath: repoRoot });
	assert.equal(packaged, null);
	// 缓存：同一进程内二次调用不再碰文件系统（用不存在的路径也不影响已缓存结果）
	assert.equal(resolveNotificationLogoUri({ isPackaged: true, resourcesPath: "/other", appPath: "/other" }), null);
});

test("打包配置带上字标资源（漏了则打包版静默退回应用图标，等于没修）", () => {
	const { NOTIFICATION_LOGO_FILENAME } = loadToastModule();
	const source = `resources/${NOTIFICATION_LOGO_FILENAME}`;
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.ok(
		pkg.build.extraResources.some((entry) => entry.from === source),
		`package.json build.extraResources 必须包含 ${source}`,
	);
});

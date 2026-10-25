import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveMarkdownImageSrc } = loadTsCommonJs("src/renderer/src/components/session/markdownImageSrc.ts");

/**
 * Markdown 图片目标的解析契约（2026-10 对话内图片渲染改造）。
 *
 * 背景：模型写 `![](C:\…\a.png)` / `![](./chart.png)` 时，旧实现把盘符原样塞进
 * `<img src>`（`C:` 被当 scheme）→ 静默白块；`data:` 被 urlTransform 清空后同样静默白图。
 * 这里的判据只有一条：**能给出可加载 URL，或明确返回 undefined**（调用方降级为 alt），
 * 绝不返回空串/半截 URL。
 */

/** 记录 toLocalUrl 收到的路径；用标记前缀把「解析结果」与「URL 编码细节」分开断言。 */
function createResolver(baseDir) {
	const seen = [];
	return {
		seen,
		resolve: (destination) =>
			resolveMarkdownImageSrc(destination, {
				baseDir,
				toLocalUrl: (absolutePath) => {
					seen.push(absolutePath);
					return `local:${absolutePath}`;
				},
			}),
	};
}

/** Windows 反斜杠与 POSIX 正斜杠在词法规范化后可能互换，比较时统一一次。 */
const slash = (value) => (typeof value === "string" ? value.replace(/\\/g, "/") : value);

test("远程图片原样返回（CSP 才是最终白名单）", () => {
	const { resolve } = createResolver(undefined);
	assert.equal(resolve("https://example.com/a.png"), "https://example.com/a.png");
	assert.equal(resolve("http://127.0.0.1:8080/a.png?x=1"), "http://127.0.0.1:8080/a.png?x=1");
});

test("PiDeck 自定义图片协议原样返回", () => {
	const { resolve, seen } = createResolver(undefined);
	assert.equal(resolve("pideck-img://blob/abc.png"), "pideck-img://blob/abc.png");
	assert.equal(resolve("pideck-file://local/?path=C%3A%5Ca.png"), "pideck-file://local/?path=C%3A%5Ca.png");
	assert.deepEqual(seen, []);
});

test("data:/blob:/javascript: 一律不渲染（不返回半截 URL）", () => {
	const { resolve } = createResolver("F:/proj");
	for (const destination of ["data:image/png;base64,AAAA", "blob:https://example.com/x", "javascript:alert(1)", "vbscript:x"]) {
		assert.equal(resolve(destination), undefined, destination);
	}
});

test("file:// 三种形态：三斜杠、localhost、缺斜杠的盘符", () => {
	const { resolve, seen } = createResolver(undefined);
	assert.equal(slash(resolve("file:///C:/Users/Administrator/a.png")), "local:C:/Users/Administrator/a.png");
	assert.equal(slash(resolve("file://localhost/C:/Users/Administrator/a.png")), "local:C:/Users/Administrator/a.png");
	assert.equal(slash(resolve("file://C:/Users/Administrator/a.png")), "local:C:/Users/Administrator/a.png");
	assert.equal(seen.length, 3);
});

test("file:// 远程共享（UNC）不当作本地文件", () => {
	const { resolve } = createResolver(undefined);
	assert.equal(resolve("file://server/share/a.png"), undefined);
});

test("盘符绝对路径直接交给本地 URL 构造器", () => {
	const { resolve, seen } = createResolver(undefined);
	assert.equal(slash(resolve("C:\\Users\\a b\\shot.png")), "local:C:/Users/a b/shot.png");
	assert.equal(slash(seen[0]), "C:/Users/a b/shot.png");
});

test("相对路径按会话 cwd 解析，没有基准就不猜", () => {
	const withBase = createResolver("F:\\PiDeck");
	assert.equal(slash(withBase.resolve("./docs/images/a.png")), "local:F:/PiDeck/docs/images/a.png");

	const withoutBase = createResolver(undefined);
	assert.equal(withoutBase.resolve("./docs/images/a.png"), undefined);
});

test("mdast-util-to-hast 的百分号编码形态（%5C）必须能解析", () => {
	// 真实管线里 <img src> 来自 hast，反斜杠已被编码成 %5C（纯 mdast 测试看不到这一层，
	// 2026-10-19 真机 smoke 当时就是这里漏了）：`C:\Users\a` → `C:%5CUsers%5Ca`
	const { resolve, seen } = createResolver("F:/PiDeck");
	assert.equal(slash(resolve("C:%5CUsers%5Ca%20b%5Cshot.png")), "local:C:/Users/a b/shot.png");
	assert.equal(slash(seen[0]), "C:/Users/a b/shot.png");
});

test("远程 URL 与自定义协议不做二次解码（%20 原样保留）", () => {
	const { resolve } = createResolver(undefined);
	assert.equal(resolve("https://example.com/a%20b.png"), "https://example.com/a%20b.png");
	assert.equal(resolve("pideck-img://blob/a%20b.png"), "pideck-img://blob/a%20b.png");
});

test("缓存后缀 ?query / #fragment 不参与路径解析", () => {
	const { resolve } = createResolver("F:/PiDeck");
	assert.equal(slash(resolve("./a.png?v=2")), "local:F:/PiDeck/a.png");
	assert.equal(slash(resolve("./a.png#frag")), "local:F:/PiDeck/a.png");
});

test("百分号转义与 /C:/ 前导斜杠按文件链接同一口径解码", () => {
	const { resolve } = createResolver("F:/PiDeck");
	assert.equal(slash(resolve("./a%20b/%E6%88%AA%E5%9B%BE.png")), "local:F:/PiDeck/a b/截图.png");
	assert.equal(slash(resolve("/C:/Users/a.png")), "local:C:/Users/a.png");
});

test("家目录与 UNC 路径降级为 alt（渲染层无法解析/无白名单覆盖）", () => {
	const { resolve } = createResolver("F:/PiDeck");
	assert.equal(resolve("~/Pictures/a.png"), undefined);
	assert.equal(resolve("\\\\server\\share\\a.png"), undefined);
});

test("空目标、锚点、控制字符都不渲染", () => {
	const { resolve } = createResolver("F:/PiDeck");
	for (const destination of ["", "   ", "#section", "?v=1", "a\u0000b.png"]) {
		assert.equal(resolve(destination), undefined, JSON.stringify(destination));
	}
});

test("目标里的 #/? 视为请求后缀，不参与路径解析", () => {
	const { resolve, seen } = createResolver("F:/PiDeck");
	assert.equal(slash(resolve("./a#1.png")), "local:F:/PiDeck/a");
	assert.equal(slash(seen[0]), "F:/PiDeck/a");
});

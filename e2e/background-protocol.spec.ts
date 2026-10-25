import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

/**
 * 换肤背景图协议回归：pideck-bg:// 必须能加载 userData/backgrounds/ 下的图片。
 * 曾有两个真实 bug：
 * 1. Windows file URL 手工拼接缺斜杠（file://C:/… → host 解析错误）；
 * 2. net.fetch 不支持 file://（Electron 限制）→ handler 改 readFile + Response。
 * 另注意：dev 模式 userData 带 -dev 后缀，文件必须写入 app.getPath("userData") 实际目录。
 */
test("pideck-bg protocol serves background images from userData", async ({ window, app }) => {
	// 先取实际 userData 路径（dev 模式带 -dev 后缀），node 侧写入测试图片（1×1 透明 PNG）
	const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
	const dir = join(userData, "backgrounds");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "bg-e2e.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

	// 渲染层 img 加载协议图片（模拟缩略图/背景图路径）
	const ok = await window.evaluate(
		() =>
			new Promise<boolean>((resolve) => {
				const img = new Image();
				img.onload = () => resolve(true);
				img.onerror = () => resolve(false);
				img.src = "pideck-bg://local/bg-e2e.png";
			}),
	);
	expect(ok).toBe(true);

	// 白名单外文件名拒绝（403 不触发 onload）
	const denied = await window.evaluate(
		() =>
			new Promise<boolean>((resolve) => {
				const img = new Image();
				img.onload = () => resolve(false);
				img.onerror = () => resolve(true);
				img.src = "pideck-bg://local/../../settings.json";
			}),
	);
	expect(denied).toBe(true);
});

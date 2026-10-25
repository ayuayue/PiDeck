import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归守卫：自定义提示音经 pideck-sound:// 协议加载，<audio> 受 CSP media-src 管。
// 2026-xx 事故：CSP 只有 img-src 放行了 pideck-bg/pideck-img，media-src 缺失导致
// 自定义音效被 default-src 'self' 拦截、播放静默失败（无任何报错，只有「没声音」）。
// 任何 CSP 调整都必须同时保住这三条：media-src 本身、'self'（预设音效走 Vite asset）、
// pideck-sound:（自定义音效走协议）。

const html = readFileSync("src/renderer/index.html", "utf8");

function cspDirective(name) {
	const match = html.match(new RegExp(`${name} ([^";]*)`));
	return match ? match[1].split(/\s+/).filter(Boolean) : null;
}

test("CSP media-src：预设（'self'）与自定义（pideck-sound:）音效都必须放行", () => {
	const mediaSrc = cspDirective("media-src");
	assert.ok(mediaSrc, "CSP 缺少 media-src 指令：<audio> 会回落 default-src 'self'，pideck-sound: 被拦截");
	assert.ok(mediaSrc.includes("'self'"), "media-src 必须含 'self'（预设音效走同源 Vite asset）");
	assert.ok(mediaSrc.includes("pideck-sound:"), "media-src 必须放行 pideck-sound:（自定义音效走该协议）");
});

test("CSP img-src：既有自定义协议放行不得被顺手删掉", () => {
	const imgSrc = cspDirective("img-src");
	assert.ok(imgSrc, "img-src 缺失");
	for (const scheme of ["pideck-bg:", "pideck-pet:", "pideck-img:"]) {
		assert.ok(imgSrc.includes(scheme), `img-src 必须继续放行 ${scheme}`);
	}
});

test("声音协议与特权声明、装配保持三处同步", () => {
	const mainIndex = readFileSync("src/main/index.ts", "utf8");
	const soundProtocol = readFileSync("src/main/sounds/soundProtocol.ts", "utf8");
	// 特权声明必须在 ready 前（registerSchemesAsPrivileged），装配必须在 ready 后
	assert.match(mainIndex, /scheme: "pideck-sound"/);
	assert.match(mainIndex, /registerSoundProtocol\(\)/);
	// 协议 handler：文件名双重白名单校验必须保留
	assert.match(soundProtocol, /protocol\.handle\("pideck-sound"/);
	assert.match(soundProtocol, /resolveCustomSoundPath/);
});

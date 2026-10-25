import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 守卫背景（2026-12 filesReadContent 无界读修复）：filesReadContent 在调用方不传
// maxBytes 时（技能/提示词/DSH 配置小文件路径）过去完全没有字节上界——渲染层一旦
// 指到任意大文件，readFile 整读会把主进程内存打爆（与「大会话闪退」同族）。
// 修复后：不传参 → 默认 16MiB；显式入参 → 钳到 64MiB 天花板；stat 拦截对两条路径统一生效。
// 本测试静态钉扎契约：任何回退到「不传参即无上界」的改动会在 CI 红灯。

const source = readFileSync(join(import.meta.dirname, "..", "src", "main", "ipc", "filesIpc.ts"), "utf8");

function handlerBody(src) {
	const start = src.indexOf("ipcChannels.filesReadContent");
	assert.ok(start !== -1, "filesReadContent handler 必须存在");
	const next = src.indexOf("ipcMain.handle(", start);
	const end = next === -1 ? src.length : next;
	return src.slice(start, end);
}

test("filesReadContent 不传 maxBytes 时必须有默认上界（不得回退到无界整读）", () => {
	const body = handlerBody(source);
	assert.match(body, /MAX_DEFAULT_READ_BYTES = 16 \* 1024 \* 1024/, "必须保留 16MiB 默认上界常量");
	assert.match(body, /typeof maxBytes === "number" && Number\.isFinite\(maxBytes\) && maxBytes > 0 \? maxBytes : MAX_DEFAULT_READ_BYTES/, "缺席 maxBytes 必须落到默认上界，而不是跳过检查");
});

test("显式 maxBytes 必须被钳到天花板（渲染层可传任意大数字）", () => {
	const body = handlerBody(source);
	assert.match(body, /MAX_READ_BYTES_CEILING = 64 \* 1024 \* 1024/, "必须保留 64MiB 天花板常量");
	assert.match(body, /Math\.min\(requestedMax, MAX_READ_BYTES_CEILING\)/, "必须用 Math.min 钳制");
});

test("stat 拦截必须对 effectiveMax 统一生效（默认路径与显式路径同闸）", () => {
	const body = handlerBody(source);
	assert.match(body, /fileStat\.size > effectiveMax/, "体积判定必须作用于钳制后的 effectiveMax");
	assert.match(body, /FILE_TOO_LARGE:\$\{fileStat\.size\}:\$\{Math\.floor\(effectiveMax\)\}/, "结构化错误前缀必须携带实际上界");
});

test("错误前缀协议不变：渲染层按 FILE_TOO_LARGE 识别 i18n 文案", () => {
	const body = handlerBody(source);
	assert.match(body, /结构化前缀供渲染层识别后走 i18n 文案/, "契约注释必须保留（渲染层依赖该前缀协议）");
});

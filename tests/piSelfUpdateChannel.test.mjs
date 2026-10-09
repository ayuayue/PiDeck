/**
 * pi 自更新通道判定（resolvePiSelfUpdateChannel）的纯函数测试。
 *
 * 守的分派规则（2026-10 用户报障）：
 * - bun 全局安装的 pi：pi 自身在 Windows 上不支持 bun 自更新，PiDeck 必须代跑 bun；
 * - 旧引导前缀副本（<userData>/pi-runtime/pi-global）：pi 的 npm 自更新在 Windows 不推断
 *   前缀，会装到用户真实全局目录、前缀副本永远停旧，PiDeck 必须带 --prefix 代跑 npm；
 * - 其余形态（npm/pnpm 全局、官方 managed、homebrew、WSL、裸命令名）：交给 pi 自己。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolvePiSelfUpdateChannel } = loadTsCommonJs("src/main/pi/piSelfUpdateChannel.ts");

test("bun 全局 bin（POSIX 形态）→ bun-global，bunCommand 取同目录的 bun 本体", () => {
	const channel = resolvePiSelfUpdateChannel("/home/tester/.bun/bin/pi", "linux");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, "/home/tester/.bun/bin/bun");
});

test("bun 全局 bin（Windows 形态）→ bun-global，bunCommand 是同目录 bun.exe", () => {
	const channel = resolvePiSelfUpdateChannel(String.raw`C:\Users\tester\.bun\bin\pi.exe`, "win32");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, join(String.raw`C:\Users\tester\.bun\bin`, "bun.exe"));
});

test("bun 包目录（install/global/node_modules，软链解析后的真实位置）→ bun-global", () => {
	const channel = resolvePiSelfUpdateChannel("/home/tester/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/bin/pi.js", "linux");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, "/home/tester/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/bin/bun");
});

test("旧引导前缀（Windows：<prefix>\\pi.cmd）→ portable-prefix，prefixDir 是当初 --prefix 的值", () => {
	const channel = resolvePiSelfUpdateChannel(String.raw`C:\Users\tester\AppData\Roaming\pi-desktop-dev\pi-runtime\pi-global\pi.cmd`, "win32");
	assert.equal(channel.kind, "portable-prefix");
	assert.equal(channel.prefixDir, String.raw`C:\Users\tester\AppData\Roaming\pi-desktop-dev\pi-runtime\pi-global`);
});

test("旧引导前缀（POSIX：<prefix>/bin/pi）→ portable-prefix，剥掉 bin/ 层", () => {
	const channel = resolvePiSelfUpdateChannel("/home/tester/.config/pi-desktop/pi-runtime/pi-global/bin/pi", "linux");
	assert.equal(channel.kind, "portable-prefix");
	assert.equal(channel.prefixDir, "/home/tester/.config/pi-desktop/pi-runtime/pi-global");
});

test("npm 全局 / homebrew / 官方 managed / WSL / 裸命令名 → pi-self（pi 自己能正确自更新）", () => {
	for (const command of [String.raw`C:\Users\tester\AppData\Roaming\npm\pi.cmd`, "/opt/homebrew/bin/pi", "/home/tester/.local/bin/pi", "wsl://Ubuntu/usr/local/bin/pi", "pi", ""]) {
		assert.equal(resolvePiSelfUpdateChannel(command, "linux").kind, "pi-self", command);
	}
});

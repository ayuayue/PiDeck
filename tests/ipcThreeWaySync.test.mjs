import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * IPC 三处同步守卫（AGENTS：新增通道三处同步——通道常量、main handler、preload 白名单，
 * 漏一处运行时 undefined；通道名集中在 shared/ipc.ts，禁止散落字符串字面量）。
 * 三向核对：
 * 1) 死常量：定义了但 main/preload/renderer 全无引用（漂移债务，改常量漏删引用的反面）。
 * 2) preload 运行时可达性：preload 白名单引用的通道必须在 main 侧某处出现
 *    （handle/on/send/push 任一形态——含窗口型注册如 FloatingController、
 *    事件推流如 TerminalSessionManager 的 emit）。
 * 3) 字面量旁路：main/preload 里形如 "domain:action" 的通道字面量必须走 ipcChannels 常量
 *    （集中注册的硬约束，防散落字符串与拼写漂移）。
 * 解析用空白容忍正则（AGENTS：源码扫描契约测试必须空白容忍）。
 */
const shared = readFileSync(join(import.meta.dirname, "..", "src", "shared", "ipc.ts"), "utf8");
const defined = [...shared.matchAll(/^[\t ]*([A-Za-z0-9]+):[\t ]*"[^"]+"/gm)].map((m) => m[1]);
assert.ok(defined.length > 600, `ipcChannels 常量数量异常：${defined.length}`);

/** 剥离块/行注释后再扫描（避免注释里的旧写法/讨论性文字造成假阳性） */
function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

function walkTs(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walkTs(full, out);
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}
const ROOT = join(import.meta.dirname, "..");
const mainFiles = walkTs(join(ROOT, "src", "main"));
const preloadFiles = walkTs(join(ROOT, "src", "preload"));
const rendererFiles = walkTs(join(ROOT, "src", "renderer"));

function refsOf(files) {
	const set = new Set();
	for (const file of files) {
		const text = stripComments(readFileSync(file, "utf8"));
		for (const m of text.matchAll(/ipcChannels\.([A-Za-z0-9]+)/g)) set.add(m[1]);
		// 局部别名（如 pet/index.ts 的 `const C = ipcChannels`）等价于常量引用
		for (const m of text.matchAll(/const ([A-Za-z0-9_$]+)(?::\s*typeof\s+ipcChannels)?\s*=\s*ipcChannels\b/g)) {
			const alias = m[1];
			for (const a of text.matchAll(new RegExp(`${alias}\\.([A-Za-z0-9]+)`, "g"))) set.add(a[1]);
		}
	}
	return set;
}
const mainRefs = refsOf(mainFiles);
const preloadRefs = refsOf(preloadFiles);
const rendererRefs = refsOf(rendererFiles);

test("无死常量：定义的通道必须在 main/preload/renderer 至少一处被引用", () => {
	const dead = defined.filter((name) => !mainRefs.has(name) && !preloadRefs.has(name) && !rendererRefs.has(name));
	assert.deepEqual(dead, [], `以下通道常量零引用（删除或补引用）：${dead.join(", ")}`);
});

test("preload 白名单引用的通道在 main 侧必须有 handler 或事件源（防运行时 undefined）", () => {
	const unreachable = [...preloadRefs].filter((name) => !mainRefs.has(name));
	assert.deepEqual(unreachable, [], `preload 暴露但 main 侧无任何出现（handle/on/send 均缺）：${unreachable.join(", ")}`);
});

test("无字面量旁路：main/preload 里形如 domain:action 的通道必须走 ipcChannels 常量", () => {
	const bypasses = [];
	for (const file of [...mainFiles, ...preloadFiles]) {
		const text = stripComments(readFileSync(file, "utf8"));
		// 注册/推送/订阅调用的第一个实参是字面量、且形态为冒号命名空间 → 旁路
		const patterns = [
			/ipcMain\.(?:handle|handleOnce|on)\(\s*"([a-z0-9-]+:[a-z0-9-]+)"/g,
			/webContents\.send\(\s*"([a-z0-9-]+:[a-z0-9-]+)"/g,
			/\bsender\.send\(\s*"([a-z0-9-]+:[a-z0-9-]+)"/g,
			/\bsenderFrame\.send\(\s*"([a-z0-9-]+:[a-z0-9-]+)"/g,
			/ipcRenderer\.(?:invoke|send|sendSync|on|once)\(\s*"([a-z0-9-]+:[a-z0-9-]+)"/g,
		];
		for (const re of patterns) {
			for (const m of text.matchAll(re)) {
				bypasses.push(`${file.replace(ROOT, "")}: "${m[1]}"`);
			}
		}
	}
	assert.deepEqual(bypasses, [], `以下调用绕过 ipcChannels 常量直写字面量：\n${bypasses.join("\n")}`);
});

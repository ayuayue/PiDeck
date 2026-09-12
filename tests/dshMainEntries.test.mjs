import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 主进程多入口契约回归：
 * hostEntry 的 Loader 行 / hideChildConsoles 的 preload 路径都用
 * `join(__dirname, "<name>.js")` 引用 out/main 里的**稳定文件名**。
 * 这类文件必须配置为 electron-vite 的 main 构建入口；否则文件只作为静态 import
 * 被打成带 hash 的共享 chunk，out/main 清空重建后 Loader 行必然
 * ERR_MODULE_NOT_FOUND（2026-09-12 pideck-session-bridge 事故）。
 */

const root = process.cwd();
const configText = readFileSync(join(root, "electron.vite.config.ts"), "utf8");

/** electron.vite.config.ts main.lib.entry 里配置的入口名集合。 */
function collectConfiguredEntries() {
	const entries = new Set();
	const re = /(\w+):\s*resolve\(__dirname,\s*"(src\/main\/[^"]+)"\)/g;
	let match;
	while ((match = re.exec(configText)) !== null) {
		entries.add({ key: match[1], source: match[2] });
	}
	return [...entries];
}

/** 收集 src/main 下所有 join(__dirname, "<name>.js") 的稳定文件引用。 */
function collectDirnameFileRefs() {
	const refs = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts")) {
				const code = readFileSync(full, "utf8");
				const re = /join\(__dirname,\s*"(?<name>[A-Za-z0-9-]+\.js)"\)/g;
				let match;
				while ((match = re.exec(code)) !== null) {
					refs.push({ file: full.replace(root + "\\", "").replace(root + "/", ""), name: match.groups.name });
				}
			}
		}
	};
	walk(join(root, "src", "main"));
	return refs;
}

test("main.lib.entry 覆盖全部 join(__dirname) 稳定文件引用", () => {
	const entries = collectConfiguredEntries();
	assert.ok(entries.length >= 5, `electron.vite.config.ts 应配置 >=5 个 main 入口，实际 ${entries.length}`);
	const entryNames = new Set(entries.map((entry) => `${entry.key}.js`));

	const refs = collectDirnameFileRefs();
	assert.ok(refs.length >= 4, `应能扫到 >=4 处 join(__dirname) 引用，实际 ${refs.length}`);
	for (const ref of refs) {
		assert.ok(
			entryNames.has(ref.name),
			`${ref.file} 引用了 ${ref.name}，但 electron.vite.config.ts main.lib.entry 没有对应入口`
				+ `（缺 "${ref.name.replace(/\.js$/, "")}"）——out/main 清空重建后该文件会消失`,
		);
	}
});

test("入口名单确凿：pideck 三桥 + hostEntry + runnerConsolePreload 都在", () => {
	const keys = collectConfiguredEntries().map((entry) => entry.key);
	for (const required of ["index", "hostEntry", "runnerConsolePreload", "pideckPluginBridge", "pideckCommandsBridge", "pideckSessionBridge"]) {
		assert.ok(keys.includes(required), `缺少入口 ${required}`);
	}
});

// 生成渲染层拼音表（src/renderer/src/utils/pinyinTable.ts）。
//
// 为什么需要生成：侧栏「搜索会话」是渲染层本地过滤（拿不到 file-index sidecar 的
// 索引），而文件名拼音又已经由 sidecar 用 go-pinyin 实现；如果渲染层另引一个 JS
// 拼音库，同一个字会出现两套读音（"cq" 在一个入口命中、另一个不命中）。所以渲染层
// 的表从同一本字典抽出来，随包分发、随字典版本更新。
//
// 用法：npm run gen:pinyin-table（CI 不跑；改动字典版本后本地重跑并提交生成物，
// tests/pinyinSearch.test.mjs 会校验关键映射与条目量级）。
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = join(repoRoot, "native", "tools", "pinyin-table");
const outputPath = join(repoRoot, "src", "renderer", "src", "utils", "pinyinTable.ts");

const result = spawnSync("go", ["run", "."], { cwd: moduleDir, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
if (result.error) {
	console.error(`[gen:pinyin-table] 无法执行 go（需要 Go 1.26 工具链）：${result.error.message}`);
	process.exit(1);
}
if (result.status !== 0) {
	console.error(`[gen:pinyin-table] go run 失败（exit ${result.status}）\n${result.stderr ?? ""}`);
	process.exit(1);
}
const output = result.stdout ?? "";
if (!output.includes("export const PINYIN_CHARS") || !output.includes("export const PINYIN_ENTRIES")) {
	console.error("[gen:pinyin-table] 生成结果缺少导出常量，已中止（不覆盖已有文件）");
	process.exit(1);
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, "utf8");
const entryCount = /条目数：(\d+)/.exec(output)?.[1] ?? "?";
console.log(`[gen:pinyin-table] 已写入 ${outputPath}（条目数 ${entryCount}，${(output.length / 1024).toFixed(0)} KiB）`);

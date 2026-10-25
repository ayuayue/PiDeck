/**
 * 一次性端到端验证脚本（非仓库测试）：用真实源文件验证修复后的导入器产物无孤儿 toolResult。
 * 用法：node scripts/validateClaudeImportChain.mjs
 */
import { createTsSandbox } from "../tests/helpers/createTsSandbox.mjs";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findOrphans(lines) {
	const pending = new Set();
	const orphans = [];
	for (const line of lines) {
		if (line.type !== "message") continue;
		const msg = line.message;
		if (msg.role === "assistant") {
			pending.clear();
			for (const item of msg.content) if (item.type === "toolCall") pending.add(item.id);
		} else if (msg.role === "user") {
			pending.clear();
		} else if (msg.role === "toolResult") {
			if (!pending.has(msg.toolCallId)) orphans.push(msg.toolCallId);
			pending.delete(msg.toolCallId);
		}
	}
	return orphans;
}

function countOrphansInFile(path) {
	const lines = readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	return findOrphans(lines).length;
}

const projectPath = "C:\\Users\\14012\\pi-desktop-dev";
const slug = "C--Users-14012-pi-desktop-dev";
const home = mkdtempSync(join(tmpdir(), "claude-e2e-"));

// 1. 拷贝真实源文件到隔离 HOME
const claudeSrc = "C:/Users/14012/.claude/projects/C--Users-14012-pi-desktop-dev";
const qoderSrc = "C:/Users/14012/.qoder-cn/projects/C--Users-14012-pi-desktop-dev";
const claudeDst = join(home, ".claude", "projects", slug);
const qoderDst = join(home, ".qoder-cn", "projects", slug);
mkdirSync(claudeDst, { recursive: true });
mkdirSync(qoderDst, { recursive: true });
const copyTree = (src, dst) => {
	mkdirSync(dst, { recursive: true });
	let count = 0;
	for (const name of readdirSync(src)) {
		const from = join(src, name);
		if (statSync(from).isDirectory()) {
			// subagents/ 子目录整树拷贝（这些文件也会被当作独立会话导入）
			count += copyTree(from, join(dst, name));
		} else if (name.endsWith(".jsonl")) {
			copyFileSync(from, join(dst, name));
			count += 1;
		}
	}
	return count;
};
const claudeCount = copyTree(claudeSrc, claudeDst);
const qoderCount = copyTree(qoderSrc, qoderDst);
console.log(`copied: claude=${claudeCount} qoder=${qoderCount} source files`);

const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => home } } } });
const Claude = load("src/main/sessions/ClaudeSessionImporter.ts").ClaudeSessionImporter;
const Qoder = load("src/main/sessions/QoderSessionImporter.ts").QoderSessionImporter;

const collectFiles = (dir) => {
	const out = [];
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(dir);
	return out;
};

let failed = 0;
const runImporter = async (label, importer, dir) => {
	const files = collectFiles(dir);
	const report = await importer.import(projectPath, files);
	let totalOrphans = 0;
	for (const result of report.results) {
		if (!result.success) {
			console.log(`${label} IMPORT FAIL ${result.sourcePath}: ${result.error}`);
			failed += 1;
			continue;
		}
		const orphans = countOrphansInFile(result.targetPath);
		totalOrphans += orphans;
		if (orphans > 0) {
			console.log(`${label} ORPHANS=${orphans} ${result.targetPath}`);
			failed += 1;
		}
	}
	console.log(`${label}: imported=${report.imported}/${files.length} totalOrphans=${totalOrphans}`);
};

await runImporter("claude", new Claude(), claudeDst);
await runImporter("qoder", new Qoder(), qoderDst);

// 2. 对照：修复前的旧产物（用户真实 ~/.pi 里已导入的坏会话）
const oldDir = "C:/Users/14012/.pi/agent/sessions/--C--Users-14012-pi-desktop-dev--";
let oldOrphans = 0;
let oldFiles = 0;
for (const name of readdirSync(oldDir)) {
	if (!/^(claude|qoder)_/.test(name) || !name.endsWith(".jsonl")) continue;
	oldFiles += 1;
	try {
		oldOrphans += countOrphansInFile(join(oldDir, name));
	} catch {}
}
console.log(`baseline (old products): files=${oldFiles} totalOrphans=${oldOrphans}`);

rmSync(home, { recursive: true, force: true });
console.log(failed === 0 ? "E2E PASS: 修复后所有真实源文件产物零孤儿" : `E2E FAIL: ${failed} 个问题`);
process.exit(failed === 0 ? 0 : 1);

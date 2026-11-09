#!/usr/bin/env node

// 合并多个架构 job 各自产出的 latest-mac.yml（electron-updater 的 macOS 更新清单）。
//
// 为什么需要：mac x64 / arm64 由两个独立 job 打包（Go sidecar 按 arch 交叉编译），每个 job 的
// electron-builder 只写自己那一半 `files`。两份 yml 同名上传到 Release 时后者覆盖前者：
// - 只剩 arm64 条目 → x64 用户的 MacUpdater 过滤掉含 "arm64" 的文件后为空，报 ZIP file not provided；
// - 只剩 x64 条目 → arm64 用户拿到 x64 zip，Rosetta 下装成错架构。
// Linux 的同类问题目前靠 skip_yml 牺牲 arm64 自更新绕过；mac 两个架构都是一等公民，必须合并。
//
// 做法：mac job 不直接上传 yml，改作 workflow artifact；汇总 job 调用本脚本把 `files` 拼起来再
// `gh release upload --clobber`。不引入 yaml 依赖：输入是 electron-builder（js-yaml dump）生成的
// 固定形状——顶层标量 + `files` 列表（每项全是标量）——按行解析即可；形状不符一律抛错（fail closed），
// 宁可缺清单（mac 自动更新报错、手动下载仍可用）也不发一份语义错误的清单。
//
// 用法：node scripts/merge-latest-mac-yml.mjs --out release/latest-mac.yml a/latest-mac.yml b/latest-mac.yml
// 顶层 path / sha512 / releaseDate 等旧版字段取第一个输入（约定 x64 在前，供只读 path 的老客户端）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FILES_KEY = "files";

/** 去掉 js-yaml 可能加的单/双引号，仅用于 url 比较与错误信息；写回时保留原始文本。 */
export function unquoteScalar(raw) {
	const text = String(raw).trim();
	if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
		return text.slice(1, -1).replace(/''/g, "'");
	}
	return text;
}

/**
 * 解析 latest-mac.yml → { scalars: [[key, rawValue]...]（保序，不含 files）, files: [[[key, rawValue]...]...] }。
 * 只接受两层缩进的列表项；遇到其它结构（嵌套 map、多行标量、注释外的奇怪行）直接抛错。
 */
export function parseLatestYml(text, label = "latest-mac.yml") {
	const scalars = [];
	const files = [];
	let inFiles = false;
	let current = null;
	const lines = String(text).split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const topLevel = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
		if (topLevel) {
			const [, key, rawValue] = topLevel;
			if (key === FILES_KEY) {
				if (rawValue !== undefined && rawValue.trim() !== "") throw new Error(`${label}:${index + 1} files 必须是列表，不能是标量`);
				inFiles = true;
				current = null;
				continue;
			}
			if (rawValue === undefined || rawValue.trim() === "") throw new Error(`${label}:${index + 1} 不支持嵌套结构：${key}`);
			inFiles = false;
			current = null;
			scalars.push([key, rawValue]);
			continue;
		}
		if (!inFiles) throw new Error(`${label}:${index + 1} 无法识别的行：${line}`);
		const itemStart = /^  - ([A-Za-z][\w-]*):\s+(.*)$/.exec(line);
		if (itemStart) {
			current = [[itemStart[1], itemStart[2]]];
			files.push(current);
			continue;
		}
		const itemField = /^    ([A-Za-z][\w-]*):\s+(.*)$/.exec(line);
		if (itemField && current) {
			current.push([itemField[1], itemField[2]]);
			continue;
		}
		throw new Error(`${label}:${index + 1} files 列表项格式不符：${line}`);
	}
	for (const [position, entry] of files.entries()) {
		if (!entry.some(([key]) => key === "url")) throw new Error(`${label} files[${position}] 缺少 url`);
	}
	return { scalars, files };
}

export function serializeLatestYml({ scalars, files }) {
	const out = [];
	const beforeFiles = [];
	const afterFiles = [];
	// electron-builder 的输出顺序：version → files → path/sha512/releaseDate。保持该顺序，
	// 让人工 diff 与官方产物对齐。
	for (const pair of scalars) (pair[0] === "version" ? beforeFiles : afterFiles).push(pair);
	for (const [key, value] of beforeFiles) out.push(`${key}: ${value}`);
	out.push(`${FILES_KEY}:`);
	for (const entry of files) {
		entry.forEach(([key, value], fieldIndex) => {
			out.push(`${fieldIndex === 0 ? "  - " : "    "}${key}: ${value}`);
		});
	}
	for (const [key, value] of afterFiles) out.push(`${key}: ${value}`);
	return `${out.join("\n")}\n`;
}

/**
 * 合并：version 必须一致；files 按 url 去重后拼接（输入顺序）；其余顶层字段取第一个输入。
 * @param {Array<{ text: string, label?: string }>} inputs
 */
export function mergeLatestYml(inputs) {
	if (!inputs.length) throw new Error("至少需要一个 latest-mac.yml");
	const parsed = inputs.map((input, index) => parseLatestYml(input.text, input.label ?? `input[${index}]`));
	const versions = parsed.map((doc) => unquoteScalar(doc.scalars.find(([key]) => key === "version")?.[1] ?? ""));
	if (versions.some((version) => version === "")) throw new Error("latest-mac.yml 缺少 version");
	if (new Set(versions).size !== 1) throw new Error(`latest-mac.yml 版本不一致：${versions.join(" / ")}`);
	const files = [];
	const seen = new Map();
	for (const doc of parsed) {
		for (const entry of doc.files) {
			const url = unquoteScalar(entry.find(([key]) => key === "url")[1]);
			const fingerprint = JSON.stringify(entry.map(([key, value]) => [key, unquoteScalar(value)]).sort(([left], [right]) => left.localeCompare(right)));
			if (seen.has(url)) {
				if (seen.get(url) !== fingerprint) throw new Error(`latest-mac.yml 同名资产信息冲突：${url}`);
				continue;
			}
			seen.set(url, fingerprint);
			files.push(entry);
		}
	}
	if (!files.length) throw new Error("合并后 files 为空");
	return { scalars: parsed[0].scalars, files };
}

function main(argv) {
	let out = null;
	const inputs = [];
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--out") {
			out = argv[++index];
			continue;
		}
		inputs.push(argv[index]);
	}
	if (!out || inputs.length < 1) {
		console.error("用法：node scripts/merge-latest-mac-yml.mjs --out <输出路径> <latest-mac.yml>...");
		process.exit(2);
	}
	const merged = mergeLatestYml(inputs.map((file) => ({ text: readFileSync(file, "utf8"), label: file })));
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, serializeLatestYml(merged), "utf8");
	console.log(`合并 ${inputs.length} 份清单 → ${out}（${merged.files.length} 个文件条目）`);
	console.log(serializeLatestYml(merged));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

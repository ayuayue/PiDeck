/**
 * sync-release-notes.js
 *
 * 从 CHANGELOG.zh-CN.md 自动提取最新版本亮点，同步到：
 *   - README.md 的「更新亮点」区块
 *   - README.en.md 的「Release Highlights」区块
 *   - docs-site/changelog.md 的最近版本条目
 *
 * 用法：
 *   node scripts/sync-release-notes.js          # 预览变更
 *   node scripts/sync-release-notes.js --apply   # 应用变更
 *   node scripts/sync-release-notes.js --version 0.6.6  # 指定版本
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ── 解析 CHANGELOG ──────────────────────────────────────────────────

function parseChangelog(lang) {
	const file = path.join(ROOT, `CHANGELOG${lang === "zh" ? ".zh-CN" : ""}.md`);
	const content = fs.readFileSync(file, "utf8");
	const lines = content.split("\n");

	// 找到最新版本（第一个 ## v 开头）
	let versionStart = -1;
	let versionEnd = -1;
	let versionLine = "";
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^## v?([\d.]+(?:\-beta\.\d+)?)/);
		if (m) {
			if (versionStart === -1) {
				versionStart = i;
				versionLine = lines[i];
			} else {
				versionEnd = i;
				break;
			}
		}
	}
	if (versionStart === -1) return null;

	const section = lines.slice(versionStart, versionEnd).join("\n");
	const version = versionLine
		.replace(/^##\s+/, "")
		.replace(/\s*[-–—]\s*\d{4}-\d{2}-\d{2}\s*$/, "")
		.replace(/\s*\(\s*\d{4}-\d{2}-\d{2}\s*\)\s*$/, "")
		.trim();

	// 提取日期
	const dateMatch = versionLine.match(/(\d{4}-\d{2}-\d{2})/);
	const date = dateMatch ? dateMatch[1] : "";

	// 提取亮点条目：按小节分组，小节标题的 emoji 决定条目类型
	const highlights = [];
	let currentSection = "";
	for (const line of lines.slice(versionStart, versionEnd)) {
		const sectionMatch = line.match(/^###\s*(🚀|✨|🐛|🧪)/);
		if (sectionMatch) {
			currentSection = sectionMatch[1];
			continue;
		}
		const itemMatch = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*/);
		if (itemMatch && currentSection) {
			highlights.push(`${currentSection} **${itemMatch[1]}**`);
		}
	}

	// 提取前 10 个 🚀 作为主要亮点
	const majorFeatures = highlights
		.filter((h) => h.startsWith("🚀"))
		.slice(0, 12)
		.map((h) => h.replace(/^🚀\s+/, ""));
	// 提取 ✨ 和 🐛
	const improvements = highlights
		.filter((h) => h.startsWith("✨") || h.startsWith("🐛"))
		.slice(0, 4)
		.map(stripEmojiPrefix);
	const experimental = highlights
		.filter((h) => h.startsWith("🧪"))
		.slice(0, 2)
		.map((h) => h.replace(/^🧪\s+/, ""));

	return { version, date, majorFeatures, improvements, experimental, highlights };
}

function stripBold(text) {
	return text.replace(/^\*\*|\*\*$/g, "");
}

function generateReadmeBlock(data, lang) {
	const { version, date, majorFeatures, improvements, experimental } = data;
	const isZh = lang === "zh";
	const lines = [];

	if (isZh) {
		lines.push(`> **最新版本 ${version}**（${date}）`);
		lines.push("");
		lines.push(`### ${version} 更新亮点`);
	} else {
		lines.push(`> **Latest: ${version}** (${date})`);
		lines.push("");
		lines.push(`### ${version} Release Highlights`);
	}

	for (const feat of majorFeatures) {
		lines.push(`- 🚀 **${stripBold(feat)}**`);
	}
	for (const imp of improvements) {
		lines.push(`- ✨ **${stripBold(imp)}**`);
	}
	for (const exp of experimental) {
		lines.push(isZh ? `- 🧪 **${stripBold(exp)}**` : `- 🧪 **${stripBold(exp)}**`);
	}

	lines.push("");
	lines.push(isZh ? "[查看完整更新日志 →](CHANGELOG.zh-CN.md)" : "[View Full Changelog →](CHANGELOG.md)");

	return lines.join("\n");
}

/**
 * 计算 README 同步结果（不写盘、不打印）：ok=false 表示找不到亮点区块；
 * changed=false 表示区块已与 CHANGELOG 同步。apply 与 --check 共用，保证两条路径判定一致。
 */
function computeReadmeUpdate(readmePath, newBlock) {
	const content = fs.readFileSync(readmePath, "utf8");
	const lines = content.split("\n");

	// 找到更新日志区块的开始和结束
	const startMarker = "> **";
	let blockStart = -1;
	let blockEnd = -1;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trimStart().startsWith(startMarker)) {
			blockStart = i;
			// 找到结束（下一个空行后的非空行，或 --- 分隔线）
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].trim().startsWith("---") || lines[j].trim().startsWith("[")) {
					blockEnd = j;
					break;
				}
			}
			break;
		}
	}

	if (blockStart === -1) {
		return { ok: false, changed: false, newContent: content };
	}

	// 计算实际替换范围：从 start 到 "查看完整更新日志" 行之后
	let endLine = blockEnd;
	for (let i = blockEnd; i < Math.min(blockEnd + 5, lines.length); i++) {
		if (lines[i].includes("查看完整更新日志") || lines[i].includes("View Full Changelog")) {
			endLine = i + 1;
			break;
		}
	}

	const oldBlock = lines.slice(blockStart, endLine).join("\n");
	const newContent = content.replace(oldBlock, newBlock);
	return { ok: true, changed: newContent !== content, newContent };
}

function updateReadme(readmePath, newBlock) {
	const result = computeReadmeUpdate(readmePath, newBlock);
	if (!result.ok) {
		console.error(`  ⚠️  Could not find changelog block in ${readmePath}`);
		return false;
	}
	if (!result.changed) {
		console.error(`  ⚠️  No changes made to ${readmePath}`);
		return false;
	}

	fs.writeFileSync(readmePath, result.newContent);
	return true;
}

/**
 * 计算 docs-site/changelog.md 同步结果（不写盘、不打印）：apply 与 --check 共用。
 * 内含两段防御逻辑（v0.6.6 重复清理 / 同版本替换），注释见函数体。
 */
function computeDocsSiteUpdate(data, fileContent) {
	const { version, date, majorFeatures, improvements } = data;
	const filePath = path.join(ROOT, "docs-site", "changelog.md");
	// fileContent：单测注入 fixture 用；缺省读真实文件（apply / --check 路径）。
	let content = fileContent ?? fs.readFileSync(filePath, "utf8");

	// 清理重复的 v0.6.6 条目：历史遗留的 v0.6.6-beta 与正式 v0.6.6 曾同时存在，
	// 此处只保留第一份。绝不能无条件删除——v0.6.6 是唯一一份时删掉会丢失整段
	// 历史（含贡献者致谢），曾因此误删（2026-08-15）。
	// 正则必须匹配整行：matchAll 的 m[0] 只含被匹配部分，若只匹配 `^## v0\.` 前缀，
	// m[0] 恒为 "## v0."，下面的全行 filter 永不命中、去重变死代码（2026-10-06
	// 单测发现；只防回归，不改其他行为）。
	const versionMatches = [...content.matchAll(/^##\s+v0\.[^\r\n]*/gm)];
	const v066Matches = versionMatches.filter((m) => /^## v0\.6\.6(?:-beta\.\d+)?$/.test(m[0]));
	if (v066Matches.length > 1) {
		const second = v066Matches[1];
		const after = versionMatches.find((m) => m.index > second.index);
		const end = after ? after.index : content.length;
		content = content.slice(0, second.index) + content.slice(end);
	}

	const lines = content.split("\n");

	// 找到第一个版本号行（v0.6.5 或更早），在其前面插入新条目
	const firstVersionIdx = lines.findIndex((l) => /^##\s+v0/.test(l));
	if (firstVersionIdx === -1) {
		return { ok: false, changed: false, newContent: content, filePath };
	}

	// 生成新条目
	const newEntry = [`## ${version}`, "", `发布时间：${date}`, ""];
	for (const feat of majorFeatures.slice(0, 15)) {
		newEntry.push(`- 🚀 **${stripBold(feat)}**`);
	}
	for (const imp of improvements.slice(0, 4)) {
		newEntry.push(`- ✨ **${stripBold(imp)}**`);
	}
	newEntry.push("");

	// 同版本段落已存在时「替换」而不是再插一份。
	//
	// 触发场景：往当期**已发布**版本的 CHANGELOG 段里补条目后重跑同步（2026-09-16 实测，
	// 补 Ctrl+P 命令面板条目时就撞上）——纯插入会让文档站出现两份同名版本段落。
	// 这与上面 v0.6.6 的历史重复是同一类问题，只是那次是版本号改名（beta → 正式）造成的。
	// 替换时保持原位置，不打乱「新版本在上」的倒序。
	// 同版本判定必须忽略尾部的发布日期：把当期版本的日期从 10-12 改成 10-13 后重跑同步，
	// 按整行（含日期）比对认不出既有段落，会再插一份同名版本（2026-10-13 发版实测），
	// 因此这里改写「同版本替换」原实现（此前只认完全相同的整行）。
	const versionBase = (line) => line.trimEnd().replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, "");
	const targetVersion = versionBase(`## ${version}`);
	const existingIdx = lines.findIndex((l) => /^##\s+v0\./.test(l) && versionBase(l) === targetVersion);
	const startIdx = existingIdx === -1 ? firstVersionIdx : existingIdx;
	let endIdx = firstVersionIdx;
	if (existingIdx !== -1) {
		// 跳到下一个「不同版本」的段落头：同版本的重复段（日期改名或手工插入留下的）一并被替换掉。
		const nextIdx = lines.findIndex((l, i) => i > existingIdx && /^##\s+v0\./.test(l) && versionBase(l) !== targetVersion);
		endIdx = nextIdx === -1 ? lines.length : nextIdx;
	}

	const newContent = [...lines.slice(0, startIdx), ...newEntry, ...lines.slice(endIdx)].join("\n");
	return { ok: true, changed: newContent !== content, newContent, filePath };
}

function updateDocsSite(data) {
	const result = computeDocsSiteUpdate(data);
	if (!result.ok) {
		console.error("  ⚠️  Could not find version entry in docs-site/changelog.md");
		return false;
	}
	if (!result.changed) {
		console.error(`  ⚠️  No changes made to ${result.filePath}`);
		return false;
	}
	fs.writeFileSync(result.filePath, result.newContent);
	return true;
}

// ── 主流程 ──────────────────────────────────────────────────────────

function main() {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const check = args.includes("--check");
	const versionFilter = args.find((a) => a.startsWith("--version="));
	const targetVersion = versionFilter ? versionFilter.split("=")[1] : null;

	console.log("=== 发行说明同步工具 ===");
	console.log(`模式: ${check ? "检查" : apply ? "应用" : "预览"}${targetVersion ? ` (版本: ${targetVersion})` : ""}`);
	console.log("");

	// 解析中英文 CHANGELOG
	const zhData = parseChangelog("zh");
	const enData = parseChangelog("en");

	if (!zhData || !enData) {
		console.error("无法解析 CHANGELOG");
		process.exit(1);
	}

	const version = zhData.version;
	console.log(`最新版本: ${version} (${zhData.date})`);
	console.log("");

	if (targetVersion && version !== targetVersion) {
		console.log(`  ⏭️  跳过: 目标版本 ${targetVersion} 不等于最新版本 ${version}`);
		process.exit(0);
	}

	// 生成 README 区块
	const zhBlock = generateReadmeBlock(zhData, "zh");
	const enBlock = generateReadmeBlock(enData, "en");

	// --check：不写盘，只判断三处是否与 CHANGELOG 同步（release-preflight 调用）。
	// 任何一处 changed 或找不到区块 → 退出码 1，同步门禁才会在 CI/发版前拦住。
	if (check) {
		const zhReadme = path.join(ROOT, "README.md");
		const enReadme = path.join(ROOT, "README.en.md");
		const zhResult = computeReadmeUpdate(zhReadme, zhBlock);
		const enResult = computeReadmeUpdate(enReadme, enBlock);
		const docsResult = computeDocsSiteUpdate(zhData);

		const staleTargets = [
			{ name: "README.md", result: zhResult },
			{ name: "README.en.md", result: enResult },
			{ name: "docs-site/changelog.md", result: docsResult },
		].filter((t) => !t.result.ok || t.result.changed);

		if (staleTargets.length === 0) {
			console.log("  ✅ README / docs-site changelog 均与 CHANGELOG 同步");
			process.exit(0);
		}
		for (const target of staleTargets) {
			console.log(`  ❌ ${target.name} ${target.result.ok ? "存在未同步的改动" : "找不到亮点区块"}——跑 node scripts/sync-release-notes.js --apply 后重试`);
		}
		process.exit(1);
	}

	console.log("=== 中文 README 区块 ===");
	console.log(zhBlock);
	console.log("");
	console.log("=== 英文 README 区块 ===");
	console.log(enBlock);
	console.log("");

	if (!apply) {
		console.log("💡 使用 --apply 参数应用变更");
		console.log("💡 使用 --version=0.6.6 指定版本");
		return;
	}

	// 应用变更
	console.log("正在应用变更...");

	const zhReadme = path.join(ROOT, "README.md");
	const enReadme = path.join(ROOT, "README.en.md");

	const zhOk = updateReadme(zhReadme, zhBlock);
	const enOk = updateReadme(enReadme, enBlock);
	const docsOk = updateDocsSite(zhData);

	if (zhOk) console.log("  ✅ README.md 已更新");
	if (enOk) console.log("  ✅ README.en.md 已更新");
	if (docsOk) console.log("  ✅ docs-site/changelog.md 已更新");
	if (!zhOk && !enOk && !docsOk) {
		console.log("  ⚠️  无需更新，或未找到匹配区块");
	}

	console.log("");
	if (zhOk || enOk || docsOk) {
		console.log("📋 三处同步完成。请检查后提交：");
		console.log("   git diff README.md README.en.md docs-site/changelog.md");
	}
}

/**
 * 去掉条目开头的 ✨/🐛 emoji 前缀（供 README/docs-site 重新归类展示）。
 * 必须带 u flag：🐛/✨ 是 surrogate pair，字符类不带 u 只能匹配半个 code unit，
 * 导致 replace 静默失败、emoji 残留（曾出现 README 里 ✨ 区混入 🐛 前缀）。
 */
function stripEmojiPrefix(text) {
	return text.replace(/^[✨🐛]\s+/u, "");
}

// 导出核心函数供单测使用；CLI 直接执行时只跑 main()
module.exports = { stripEmojiPrefix, computeReadmeUpdate, computeDocsSiteUpdate };

if (require.main === module) {
	main();
}

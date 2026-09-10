import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 回归：商店面板（扩展/SkillHub/技能商店/提示词商店/中文精选）的「热门搜索词」chip
 * 悬停后文字消失。
 *
 * 根因是 token 语义被用反：tailwind.css 把 Tailwind 主题里的 --color-accent 映射到
 * --color-bg-active（悬停浅「面」色，与 shadcn 官方 accent 语义一致）。因此
 * `text-accent` 生成的是 color: var(--color-bg-active)，与 `hover:bg-accent` 的底色
 * 同值 —— 亮色（#dfe3e8 文字 / #dfe3e8 底）与暗色（#333 文字 / #333 底）下都表现为
 * 「悬停后变色块、文字看不见」。面上的正文色必须用 text-accent-foreground
 * （= --color-text-primary）。
 *
 * 3d607add 改动映射时遗留了同一处用反的 5 处（设置页更新提示 / MCP 文档链接 /
 * 会话 goal 徽章 / RPC live 指示点），已一并改为 text-primary，这里做全渲染层守卫。
 */

const RENDERER_SRC = "src/renderer/src";
const CONFIG_DIR = `${RENDERER_SRC}/config`;
const tailwind = readFileSync(`${RENDERER_SRC}/styles/tailwind.css`, "utf8");
const storeSearchBar = readFileSync(`${CONFIG_DIR}/StoreSearchBar.tsx`, "utf8");

/** 递归收集渲染层源码文件（跳过 i18n 文案目录）。 */
function rendererSources(dir = RENDERER_SRC) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (full.includes("i18n")) continue;
			files.push(...rendererSources(full));
		} else if (/\.tsx?$/.test(full)) {
			files.push({ name: full.replace(/\\/g, "/"), source: readFileSync(full, "utf8") });
		}
	}
	return files;
}

/** 抽出源文件里实际生效的 className 字面量（静态字符串 + 模板字符串），跳过注释。 */
function classNameLiterals(source) {
	const found = [];
	for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
		found.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return found;
}

test("tailwind 主题把 accent 映射为悬停面色（text-accent 不是正文色）", () => {
	// 这条映射是结论的前提：若改成 var(--color-accent)（品牌强调色），
	// 下面的守卫需要重新评估，而不是默默放宽。
	assert.match(tailwind, /--color-accent:\s*var\(--color-bg-active\);/);
	assert.match(tailwind, /--color-accent-foreground:\s*var\(--color-text-primary\);/);
});

test("商店搜索栏热门词 chip 悬停态使用面上的前景色 token", () => {
	const chipClasses = classNameLiterals(storeSearchBar).filter(
		(value) => value.includes("rounded-full") && value.includes("bg-bg-muted"),
	);
	assert.equal(chipClasses.length, 1, "StoreSearchBar 应保留热门词 chip 的胶囊类名");
	const classes = ` ${chipClasses[0]} `;
	// 悬停高亮：ghost Button 语义（bg-accent 面 + text-accent-foreground 前景）
	assert.ok(classes.includes(" hover:bg-accent "), `chip 悬停缺少 hover:bg-accent：${classes}`);
	assert.ok(
		classes.includes(" hover:text-accent-foreground "),
		`chip 悬停缺少 hover:text-accent-foreground：${classes}`,
	);
	assert.ok(!classes.includes(" hover:text-accent "), "chip 悬停不得把 accent 面色当正文色");
});

test("渲染层不把面色 token 当正文色（text-<面色> 必与底同值）", () => {
	// 面色语义的 token：`text-*` 用它们会与自身/悬停底色撞色（可读性归零）。
	// 合法写法是配套的 `-foreground`（text-accent-foreground / text-muted-foreground…）。
	const surfaceTokens = [
		"accent",
		"muted",
		"bg-muted",
		"bg-hover",
		"bg-active",
		"bg-panel",
		"bg-app",
		"bg-sidebar",
		"bg-input",
		"bg-popover",
		"bg-subtle",
		"card",
		"popover",
		"secondary",
		"border",
	];
	// 变体前缀（hover: / dark: / group-data-…: / [&_svg:…]: 等）
	const variant = "(?:[\\w[\\].-]+:)";
	const textToken = new RegExp(`(?:^|\\s)${variant}*text-([\\w.-]+?)(?=[\\s"]|$)`, "g");

	for (const { name, source } of rendererSources()) {
		for (const classes of classNameLiterals(source)) {
			for (const match of classes.matchAll(textToken)) {
				const token = match[1];
				if (token.endsWith("-foreground")) continue;
				assert.ok(
					!surfaceTokens.includes(token),
					`${name}: text-${token} 是面色 token，当正文色会与底色同值、文字不可见`,
				);
			}
		}
	}
});

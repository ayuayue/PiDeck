/**
 * 自定义主题「AI 开发指南」：双语文案生成器。
 *
 * 同一份内容三个用途（单一事实源，token 表/示例从 customThemes.ts 生成，不手抄）：
 * - 设置页指南弹窗展示 + 一键复制（用户直接粘贴给 AI 当提示词）；
 * - 主进程写入主题目录 AI-THEME-GUIDE.md（用户可让 AI 直接读该文件）；
 * - 单测校验指南完整性（含白名单 token 与示例主题 id）。
 */
import { CUSTOM_THEME_TOKEN_GROUPS, CUSTOM_THEME_ID_PATTERN, DEMO_CUSTOM_THEME, serializeCustomThemePackage } from "./customThemes";

export type CustomThemeGuideLocale = "zh-CN" | "en-US";

/** 指南头部一段话：说明「这份文档本身就可以作为提示词发给 AI」 */
function promptIntro(locale: CustomThemeGuideLocale, themesDir: string): string {
	if (locale === "en-US") {
		return [
			`# PiDeck Custom Theme Development Guide`,
			``,
			`This document doubles as an AI prompt: paste it to any AI assistant (e.g. a pi session), add one line like "make me a Tokyo-night theme", and it can produce a valid theme package for you.`,
			``,
			`## What a theme package is`,
			``,
			`A PiDeck theme is a single JSON file that overrides the app's semantic design tokens (backgrounds, text, borders, accent, chat bubbles, code blocks) for both light and dark modes. No CSS, no code execution — just token values. Invalid keys or non-color values are rejected.`,
			``,
			`## Quick start`,
			``,
			`1. PiDeck → Settings → Appearance → Custom Themes: click "New theme" to create an editable starter, or "Copy to new theme" from the built-in demo.`,
			`2. Edit the JSON (by hand, or let an AI write it using this guide).`,
			`3. Save, then click "Apply" on the theme card, and save settings. Theme files live in: \`${themesDir}\``,
		].join("\n");
	}
	return [
		`# PiDeck 自定义主题开发指南`,
		``,
		`这份文档本身就是提示词：整段发给任意 AI 助手（比如一个 pi 会话），再补一句「帮我做一个 XX 风格的主题」，AI 就能产出合法的主题包。`,
		``,
		`## 主题包是什么`,
		``,
		`PiDeck 主题 = 一个 JSON 文件，覆盖应用的语义设计 token（表面/文字/边框/主色/会话气泡/代码块），浅色与暗色各一套。不是 CSS、不执行代码，只有颜色值；白名单之外的键或非法颜色值都会被拒绝。`,
		``,
		`## 快速开始`,
		``,
		`1. PiDeck → 设置 → 外观 → 自定义主题：点「新建主题」生成可编辑模板，或在内置示例上「复制为新主题」。`,
		`2. 编辑 JSON（手改，或按本指南让 AI 生成）。`,
		`3. 保存后在主题卡片上点「应用」，再保存设置即生效。主题文件存放目录：\`${themesDir}\``,
	].join("\n");
}

function schemaSection(locale: CustomThemeGuideLocale): string {
	if (locale === "en-US") {
		return [
			``,
			`## File format`,
			``,
			`\`\`\`jsonc`,
			`{`,
			`\t"schemaVersion": 1,            // must be 1`,
			`\t"id": "my-theme",              // ^[a-z0-9][a-z0-9-]{0,39}$ — also the file name <id>.json`,
			`\t"name": "My Theme",            // display name, 1-40 chars`,
			`\t"version": "1.0.0",            // optional`,
			`\t"author": "you",               // optional`,
			`\t"description": "...",          // optional, <=200 chars`,
			`\t"appearance": {`,
			`\t\t"light": { "--color-bg-app": "#faf6f7", ... },  // light tokens`,
			`\t\t"dark":  { "--color-bg-app": "#171114", ... }   // dark tokens`,
			`\t}`,
			`}`,
			`\`\`\``,
			``,
			`Rules:`,
			`- Keys are full CSS variable names from the whitelist below; unknown keys are rejected.`,
			`- Values must be static colors: \`#rgb\`/\`#rgba\`/\`#rrggbb\`/\`#rrggbbaa\` or \`rgb()/rgba()/hsl()/hsla()/oklch()/oklab()\` with numeric arguments only. No \`var()\`, no gradients, no \`url()\`.`,
			`- At least one of light/dark must be non-empty; providing both is strongly recommended (missing tokens fall back to the built-in default look).`,
			`- \`id\` must not be \`${DEMO_CUSTOM_THEME.id}\`: that id is reserved for the built-in demo theme (saving it is rejected).`,
		].join("\n");
	}
	return [
		``,
		`## 文件格式`,
		``,
		`\`\`\`jsonc`,
		`{`,
		`\t"schemaVersion": 1,            // 必须为 1`,
		`\t"id": "my-theme",              // ${CUSTOM_THEME_ID_PATTERN}，同时是文件名 <id>.json`,
		`\t"name": "我的主题",             // 展示名，1-40 字符`,
		`\t"version": "1.0.0",            // 可选`,
		`\t"author": "you",               // 可选`,
		`\t"description": "...",          // 可选，≤200 字符`,
		`\t"appearance": {`,
		`\t\t"light": { "--color-bg-app": "#faf6f7", ... },  // 浅色档 token`,
		`\t\t"dark":  { "--color-bg-app": "#171114", ... }   // 暗色档 token`,
		`\t}`,
		`}`,
		`\`\`\``,
		``,
		`规则：`,
		`- 键必须是下方白名单里的完整 CSS 变量名，未知键一律拒绝；`,
		`- 值只能是静态颜色：\`#rgb\`/\`#rgba\`/\`#rrggbb\`/\`#rrggbbaa\` 或 \`rgb()/rgba()/hsl()/hsla()/oklch()/oklab()\`（纯数值参数）。不支持 \`var()\`、渐变、\`url()\`；`,
		`- light/dark 至少一档非空；强烈建议两档都写全（缺失的 token 会回落到内置默认观感）；`,
		`- \`id\` 不能是 \`${DEMO_CUSTOM_THEME.id}\`：该 id 保留给内置示例（保存时会被拒绝）。`,
	].join("\n");
}

function tokenTableSection(locale: CustomThemeGuideLocale): string {
	const lines: string[] = ["", locale === "en-US" ? `## Token whitelist` : `## Token 白名单`];
	for (const group of CUSTOM_THEME_TOKEN_GROUPS) {
		lines.push("", `### ${locale === "en-US" ? group.enTitle : group.zhTitle}`, "", `| Token | ${locale === "en-US" ? "Meaning" : "说明"} |`, `| --- | --- |`);
		for (const entry of group.tokens) {
			lines.push(`| \`--color-${entry.token}\` | ${locale === "en-US" ? entry.enDesc : entry.zhDesc} |`);
		}
	}
	return lines.join("\n");
}

function exampleSection(locale: CustomThemeGuideLocale): string {
	if (locale === "en-US") {
		return [``, `## Complete example (the built-in demo theme)`, ``, "```json", serializeCustomThemePackage(DEMO_CUSTOM_THEME).trimEnd(), "```"].join("\n");
	}
	return [``, `## 完整示例（内置示例主题原文）`, ``, "```json", serializeCustomThemePackage(DEMO_CUSTOM_THEME).trimEnd(), "```"].join("\n");
}

function tipsSection(locale: CustomThemeGuideLocale): string {
	if (locale === "en-US") {
		return [
			``,
			`## Design tips for AI`,
			``,
			`1. Start from the demo theme and adjust hue/saturation systematically rather than inventing every value.`,
			`2. Keep contrast: text-primary on bg-app should meet WCAG AA (>= 4.5:1). Check both schemes.`,
			`3. Surfaces form a hierarchy: sidebar slightly darker/lighter than bg-app, panel lighter, hover/active a touch stronger than muted.`,
			`4. accent is the single highlight color (buttons, links, selection); accent-soft is its tinted background, accent-strong the hover-deepened variant.`,
			`5. Dark mode isn't inverted light mode: reduce saturation, lift lightness of text, keep backgrounds close (contrast comes from text, not background).`,
			`6. Generate the JSON only — no CSS, no JS. Output exactly one JSON object conforming to the schema above.`,
		].join("\n");
	}
	return [
		``,
		`## 给 AI 的设计建议`,
		``,
		`1. 从示例主题出发系统性地调整色相/饱和度，而不是凭空编造每个值；`,
		`2. 保证对比度：text-primary 落在 bg-app 上应满足 WCAG AA（≥4.5:1），浅暗两档都要检查；`,
		`3. 表面要有层次：sidebar 比 bg-app 略深/略浅，panel 更亮，hover/active 比 muted 再强一档；`,
		`4. accent 是唯一强调色（按钮/链接/选中）；accent-soft 是它的浅底，accent-strong 是悬停加深档；`,
		`5. 暗色不是浅色取反：降低饱和度、提高文字亮度，背景彼此接近（对比度靠文字而不是背景）；`,
		`6. 只输出 JSON——不要 CSS、不要 JS，只产出符合上述 schema 的一个 JSON 对象。`,
	].join("\n");
}

/** 生成完整指南 markdown（themesDir 用于嵌入实际存放目录，由调用方传入） */
export function buildCustomThemeGuideMarkdown(locale: CustomThemeGuideLocale, themesDir: string): string {
	return [promptIntro(locale, themesDir), schemaSection(locale), tokenTableSection(locale), exampleSection(locale), tipsSection(locale)].join("\n");
}

/** 主进程写入主题目录的指南文件名 */
export const CUSTOM_THEME_GUIDE_FILENAME = "AI-THEME-GUIDE.md";

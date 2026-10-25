import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 字号纪律守卫（ZCode 反哺 Phase 4，docs/zcode-design-analysis.md §六）
 *
 * 规则：渲染层自研组件禁止任意字号 text-[Npx]，必须用语义字号类
 * （text-micro/caption/control/body/title/brand…，随「界面字号」设置缩放）。
 * 例外白名单：text-[9px] —— 徽标计数器/装饰符等刻意微型排版（低于 token 下限，
 * GitPanel ahead/behind 计数、SessionSourceBadge、SettingsTab 折叠箭头）；
 * ≥20px —— 空态/引导页 hero 大标题等展示型排版（不参与 UI 字号阶梯与缩放语义，如 App.tsx 的 PiDeck 40px）。
 * vendored 目录（ui-shadcn / components/motion）不参与本纪律。
 */
const RENDERER_ROOT = join(process.cwd(), "src", "renderer", "src");
const EXEMPT_DIRS = new Set(["ui-shadcn"]);
const EXEMPT_PATH_FRAGMENTS = [join("components", "motion")];
const ALLOWED_PX = new Set([9]);
// 展示型排版（hero 大标题）豁免下限：UI 文本阶梯只管可缩放的界面文案
const DISPLAY_FLOOR_PX = 20;

function* walkTsx(dir) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (EXEMPT_DIRS.has(entry)) continue;
			// vendored 动效目录（components/motion）整体豁免
			if (EXEMPT_PATH_FRAGMENTS.some((frag) => full.replaceAll("\\", "/").includes(frag.replaceAll("\\", "/")))) continue;
			yield* walkTsx(full);
			continue;
		}
		if (entry.endsWith(".tsx")) yield full;
	}
}

test("renderer self-authored components avoid arbitrary text-[Npx] font sizes (9px badge floor exempt)", () => {
	// 空白容忍：text-[ 与 px 之间允许空白，防格式化改动误伤（AGENTS.md 源码正则契约）
	const arbitrarySize = /text-\[\s*(\d+(?:\.\d+)?)\s*px\s*\]/g;
	const offenders = [];
	for (const file of walkTsx(RENDERER_ROOT)) {
		const src = readFileSync(file, "utf8");
		for (const match of src.matchAll(arbitrarySize)) {
			const px = Number(match[1]);
			if (ALLOWED_PX.has(px) || px >= DISPLAY_FLOOR_PX) continue;
			offenders.push(`${file}: text-[${match[1]}px]`);
		}
	}
	assert.deepEqual(offenders, [], `发现未走语义字号类的任意字号（改用 text-micro/caption/control/body/title/brand）：\n${offenders.join("\n")}`);
});

test("semantic font ladder tokens exist in foundation (micro/caption/control/body/title/brand)", () => {
	const foundation = readFileSync(join(RENDERER_ROOT, "styles", "foundation.css"), "utf8");
	for (const token of ["--font-size-micro", "--font-size-caption", "--font-size-control", "--font-size-body", "--font-size-title", "--font-size-brand"]) {
		assert.match(foundation, new RegExp(`${token}\\s*:`), `缺少字号 token ${token}`);
	}
});

test("selection inline toolbar renders agent result prose in sans, not mono (等宽只用于技术内容)", () => {
	const src = readFileSync(join(RENDERER_ROOT, "components", "selectionTool", "SelectionInlineToolbar.tsx"), "utf8");
	// 结果分支：state.text 是译文（自然语言），必须 font-sans；容器保持 font-mono 展示选区原文
	assert.match(src, /className="font-sans">\{state\.text\}<\/span>/, "译文结果 span 应显式 font-sans 覆盖容器 font-mono");
});

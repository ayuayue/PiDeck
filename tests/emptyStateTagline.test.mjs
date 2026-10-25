import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const parts = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const i18n = [readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"), readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8")].join("\n");

test("empty state is a project-aware workspace entry point", () => {
	assert.match(parts, /data-empty-state=\{props\.hasProject \? "project" : "no-project"\}/);
	// Editorial 排版：标题拆为「引导语 + 衬线斜体重音词 + 标点」三段，品牌感由重音词承担
	assert.match(parts, /t\("app\.emptyProjectTitleLead"\)/);
	assert.match(parts, /t\("app\.emptyProjectTitleAccent"\)/);
	assert.match(parts, /t\("app\.emptyProjectTitlePunct"\)/);
	assert.match(parts, /t\("app\.emptyNoProjectTitle"\)/);
	// #113 中性化改版：空态不再绘制品牌渐变 Logo 与光晕，保持纯白基底 + 标题层级。
	assert.doesNotMatch(parts, /logo-mark-gradient/);
	// 衬线斜体只用于拉丁重音词（内置 Plantin 仅拉丁字形，中文回退宋体会破坏质感）
	assert.match(parts, /font-brand font-medium italic/);
	assert.match(i18n, /"app\.emptyProjectTitleAccent": "Session"/);
	assert.match(parts, /text-\[clamp\(2\.5rem,5vw,3\.25rem\)\] font-semibold/);
	// 章节页眉：装饰序号 + 发丝线 + eyebrow 上下文
	assert.match(parts, /h-px flex-1/);
	assert.match(parts, /props\.eyebrow/);
	assert.doesNotMatch(parts, /empty-tagline|empty-logo|empty-subtitle|empty-state-cta/);
	assert.doesNotMatch(parts, /There are many agent harnesses|Pi is a minimal agent harness/);

	for (const key of ["app.emptyProjectTitleLead", "app.emptyProjectTitleAccent", "app.emptyProjectTitlePunct", "app.emptyNoProjectTitle", "app.emptyHasProject", "app.emptyNoProject"]) {
		assert.ok(i18n.includes(`"${key}"`), `${key} must exist in both locales`);
	}
	assert.doesNotMatch(i18n, /app\.emptyTagline|app\.emptySubtitle/);
});

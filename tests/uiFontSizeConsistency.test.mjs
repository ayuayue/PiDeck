import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// #389 界面字号不一致的回归测试。
// 根因一：cn() 用的是 tailwind-merge 默认配置，只认识内置 tshirt 字号；项目自定义的
// text-micro / text-control / text-body 等会被 text-color 组的兜底验证器认领，和
// text-info / text-primary-foreground 同组冲突后“后者获胜”，字号类被整条删除，元素
// 退回继承容器字号（设置弹窗按钮忽大忽小、文件类型徽标比文件名还大、文件树激活行不缩放）。
// 根因二：Git 抽屉行 JSX 里写死 text-sm，utilities 层压过 legacy 的档位字号。
// 这里同时锁定 merge 配置与两处组件调用点，避免下次再加字号 token 又静默失效。

const tailwindCss = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const { cn } = loadTsCommonJs("src/renderer/src/lib/utils.ts");
const { PROJECT_TEXT_SIZE_TOKENS } = loadTsCommonJs("src/renderer/src/lib/tailwindMerge.ts");

/** tailwind.css @theme 里声明的字号 token（过滤 --text-<name>--line-height 行高伴侣）。 */
function cssTextSizeTokens() {
	const tokens = new Set();
	for (const match of tailwindCss.matchAll(/^[\t ]*--text-([a-z0-9-]+)[\t ]*:/gm)) {
		if (match[1].includes("--")) continue;
		tokens.add(match[1]);
	}
	return [...tokens].sort();
}

function classesOf(value) {
	return value.split(/\s+/).filter(Boolean);
}

test("tailwind.css 的字号 token 与 merge 配置逐项一致（新增 token 不许漏注册）", () => {
	const fromCss = cssTextSizeTokens();
	assert.ok(fromCss.length >= 10, `tailwind.css 应声明多个 --text-* 字号 token，实际：${fromCss.join(", ")}`);
	assert.deepEqual([...PROJECT_TEXT_SIZE_TOKENS].sort(), fromCss, "字号 token 必须同步到 lib/tailwindMerge.ts，否则 cn() 会把它当颜色类吞掉");
});

test("自定义字号与文字颜色共存（不再被 text-color 冲突组吞掉）", () => {
	const colors = ["text-info", "text-success", "text-danger", "text-primary-foreground", "text-accent-foreground", "text-text-primary", "text-muted-foreground"];
	for (const token of PROJECT_TEXT_SIZE_TOKENS) {
		const sizeClass = `text-${token}`;
		for (const color of colors) {
			const merged = classesOf(cn(sizeClass, color));
			assert.ok(merged.includes(sizeClass), `${sizeClass} 与 ${color} 合并后被吞：${merged.join(" ")}`);
			assert.ok(merged.includes(color), `${sizeClass} 与 ${color} 合并后颜色丢失：${merged.join(" ")}`);
		}
	}
});

test("字号类之间仍按后者覆盖（同组冲突语义不变）", () => {
	assert.equal(cn("text-micro", "text-sm"), "text-sm");
	assert.equal(cn("text-sm", "text-micro"), "text-micro");
	assert.equal(cn("text-body", "text-caption"), "text-caption");
	assert.equal(cn("text-[length:var(--text-widget-item)]", "text-micro"), "text-micro");
});

test("自定义文字颜色之间仍按后者覆盖", () => {
	assert.equal(cn("text-info", "text-danger"), "text-danger");
	assert.equal(cn("text-text-secondary", "text-text-faint"), "text-text-faint");
});

test("Button 各变体保留基类 text-control（#389 设置弹窗按钮字号不一致）", () => {
	const { buttonVariants } = loadTsCommonJs("src/renderer/src/components/ui-shadcn/button.tsx", { stubs: { "@/lib/utils": { cn } } });
	for (const variant of ["default", "outline", "destructive", "secondary", "ghost", "link"]) {
		for (const size of ["default", "sm"]) {
			const merged = classesOf(cn(buttonVariants({ variant, size })));
			assert.ok(merged.includes("text-control"), `Button variant=${variant} size=${size} 的 text-control 被吞：${merged.join(" ")}`);
		}
		// size=xs 刻意用 text-xs 覆盖基类字号，属于期望的后者覆盖
		const xs = classesOf(cn(buttonVariants({ variant, size: "xs" })));
		assert.ok(xs.includes("text-xs"), `Button size=xs 应显式覆盖为 text-xs：${xs.join(" ")}`);
		assert.ok(!xs.includes("text-control"), `Button size=xs 不应同时留下 text-control：${xs.join(" ")}`);
	}
});

test("文件类型徽标保留 text-micro（#389 修改文件 tab 徽标偏大）", () => {
	// 「修改的文件」已从 statusPanel 迁到轮末 chip（TurnFileChanges），
	// 断言随功能一起搬到新落点：文件行徽标仍须用 text-micro，不得放大。
	const turnFileChanges = readFileSync("src/renderer/src/components/session/turn/TurnFileChanges.tsx", "utf8");
	assert.match(turnFileChanges, /className="shrink-0 text-micro/, "文件徽标基类必须声明 text-micro");
	assert.doesNotMatch(turnFileChanges, /text-(xs|sm|base) font-semibold/, "徽标档位不得用更大的字号覆盖 text-micro");
});

test("文件树行字号在 cn 合并后保留（激活行不再被 text-accent-foreground 吞）", () => {
	const rows = readFileSync("src/renderer/src/components/session/FileTreeRows.tsx", "utf8");
	const base = /const FILE_ROW_BUTTON_CLASS\s*=\s*"([^"]+)"/.exec(rows)?.[1];
	assert.ok(base, "找不到 FILE_ROW_BUTTON_CLASS");
	assert.match(base, /text-body/);
	const extras = ["rounded-none", "bg-accent text-accent-foreground hover:bg-accent active:bg-accent", "bg-muted ring-1 ring-border"];
	for (const extra of extras) {
		const merged = classesOf(cn(base, extra));
		assert.ok(merged.includes("text-body"), `文件树行附加类 ${extra} 吞掉了 text-body：${merged.join(" ")}`);
	}
});

test("Git 抽屉资源行跟随界面字号档位，不再写死 text-sm", () => {
	const tree = readFileSync("src/renderer/src/components/app/git/GitResourceTree.tsx", "utf8");
	const rowClass = /`([^`]*git-resource-row[^`]*)`/.exec(tree)?.[1] ?? "";
	assert.ok(rowClass, "找不到 git-resource-row 的 className");
	assert.doesNotMatch(rowClass, /(?:^|\s)text-(?:sm|xs|base)(?:\s|$)/, `Git 资源行不应写死字号：${rowClass}`);
	assert.match(rowClass, /(?:^|\s)text-body(?:\s|$)/, "Git 资源行应使用随档位缩放的 text-body");
	const css = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
	assert.match(css, /\.git-resource-row\s*\{[\s\S]*?font-size:\s*var\(--font-size-body\)/, "legacy 层档位字号必须与 JSX 保持同一 token");
});

test("Git 历史行同样跟随界面字号档位", () => {
	const graph = readFileSync("src/renderer/src/components/app/git/GitGraph.tsx", "utf8");
	const rowClass = /`([^`]*git-history-row[^`]*)`/.exec(graph)?.[1] ?? "";
	assert.ok(rowClass, "找不到 git-history-row 的 className");
	assert.doesNotMatch(rowClass, /(?:^|\s)text-(?:sm|xs|base)(?:\s|$)/, `Git 历史行不应写死字号：${rowClass}`);
	assert.match(rowClass, /(?:^|\s)text-body(?:\s|$)/, "Git 历史行应使用随档位缩放的 text-body");
});

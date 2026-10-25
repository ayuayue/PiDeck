import { test, expect } from "./fixtures";
import { makeSeedProject } from "./open-session";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 文件抽屉目录行「挂顶」（对齐 VSCode workbench.tree.stickyScroll 语义）回归：
 * - docs / examples / deep 三层逐级叠在面板顶部（父目录留在上一槽位当面包屑），每层不透明、不重叠；
 * - 超过上限的第 4 层（sub）随内容滚走；所有吸顶行无圆角且全宽，紧贴固定工具行。
 * - 阴影只出现在吸顶栈底部，滚回自然位置后消失。
 *
 * 关键前提（改坏了会静默失效）：
 * - 目录行只能相对「真正滚动的祖先」sticky，滚动层是 .files-panel；抽屉里的
 *   .drawer-content-frame 不滚、不参与。
 * - CollapsibleContent 不能用 overflow-hidden：它会变成「不滚动的 scrollport」，
 *   把子目录行的 sticky 全部截住（子目录不再挂顶）。改用 overflow-clip 只裁剪、
 *   不建滚动容器（见 FileTreeRows.tsx 的注释）。
 * - 没有正 z 值时挂顶行会被自己的子行盖住（兄弟层 .file-children 按绘制顺序在后）。
 */
const seedProject = makeSeedProject("FileTreeSticky");
test.use({ seedProjects: [seedProject] });

/** 挂顶栈：最外层三层（与 FileTreeRows.tsx 的 FILE_STICKY_MAX_LEVELS 一致） */
const STACK = [
	{ dir: "docs", filePrefix: "doc" },
	{ dir: "examples", filePrefix: "ex" },
	{ dir: "deep", filePrefix: "dp" },
] as const;
/** 第 4 层：超过挂顶上限，不应 sticky */
const DEEPER = { dir: "sub", filePrefix: "sb" } as const;
const ROW_HEIGHT = 28;

/** 主题 × 主题色 × 自制外观：引导线颜色必须在这每一套配色下都看得见（用户会换主题）。 */
const THEME_PALETTES = [
	{ name: "light-default" },
	{ name: "light-green", accent: "green" },
	{ name: "dark-default", theme: "dark" },
	{ name: "dark-purple", theme: "dark", accent: "purple" },
	{ name: "light-fresh-green", appearance: "fresh-green" },
	{ name: "dark-fresh-green", theme: "dark", appearance: "fresh-green" },
	{ name: "light-graphite", appearance: "graphite" },
	{ name: "dark-graphite", theme: "dark", appearance: "graphite" },
	{ name: "light-sea-blue", appearance: "sea-blue" },
	{ name: "dark-sea-blue", theme: "dark", appearance: "sea-blue" },
	{ name: "light-warm-beige", appearance: "warm-beige" },
	{ name: "dark-warm-beige", theme: "dark", appearance: "warm-beige" },
] as const;

for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, `root-${String(i).padStart(3, "0")}.ts`), `export const r${i} = ${i};\n`);
}
mkdirSync(join(seedProject.path, ...STACK.map((level) => level.dir), DEEPER.dir), { recursive: true });
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, "docs", `doc-${String(i).padStart(3, "0")}.md`), `# doc ${i}\n`);
}
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, "docs", "examples", `ex-${String(i).padStart(3, "0")}.ts`), `export const e${i} = ${i};\n`);
}
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, ...STACK.map((level) => level.dir), `dp-${String(i).padStart(3, "0")}.ts`), `export const d${i} = ${i};\n`);
}
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, ...STACK.map((level) => level.dir), DEEPER.dir, `sb-${String(i).padStart(3, "0")}.ts`), `export const s${i} = ${i};\n`);
}

test("file tree directory rows stick to the top while scrolling", async ({ window }, testInfo) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 侧栏默认停在「聊天」分段，工作区项目行在「项目」分段下
	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "FileTreeSticky" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true", { timeout: 5000 });

	// 逐层展开（子目录懒加载，等第一个子行出现再展开下一层）
	const dirRows = window.locator(".files-panel .file-node-row.directory");
	const fileNames = window.locator(".files-panel .file-node-name");
	const stackNames = STACK.map((level) => level.dir);
	for (const level of [...STACK, DEEPER]) {
		await expect(dirRows.filter({ hasText: new RegExp(`^${level.dir}$`) }).first()).toBeVisible({ timeout: 15_000 });
		await dirRows
			.filter({ hasText: new RegExp(`^${level.dir}$`) })
			.first()
			.click();
		await expect(fileNames.filter({ hasText: new RegExp(`^${level.filePrefix}-000\\.`) }).first()).toBeVisible({ timeout: 15_000 });
		if (level.dir === "examples") {
			// 同级文件和目录必须保留同样的箭头槽位，图标、名称不能因文件没有箭头而左移。
			const siblingLayout = await window.evaluate(() => {
				const panel = document.querySelector<HTMLElement>(".files-panel")!;
				const panelLeft = panel.getBoundingClientRect().left;
				return ["deep", "ex-000.ts"].map((name) => {
					const row = Array.from(panel.querySelectorAll<HTMLElement>(".file-node-row")).find((element) => element.querySelector(".file-node-name")?.textContent === name)!;
					const glyph = row.querySelector<HTMLElement>(".file-node-icon")!.firstElementChild!.getBoundingClientRect();
					return {
						name,
						iconLeft: row.querySelector<HTMLElement>(".file-node-icon")!.getBoundingClientRect().left - panelLeft,
						nameLeft: row.querySelector<HTMLElement>(".file-node-name")!.getBoundingClientRect().left - panelLeft,
						iconWidth: row.querySelector<HTMLElement>(".file-node-icon")!.getBoundingClientRect().width,
						glyphSize: { width: Math.round(glyph.width), height: Math.round(glyph.height) },
						twistieWidth: row.querySelector<HTMLElement>("[data-file-tree-twistie]")!.getBoundingClientRect().width,
						guideLefts: Array.from(row.querySelectorAll<HTMLElement>("[data-file-tree-guide-level]")).map((guide) => guide.getBoundingClientRect().left - panelLeft),
						guideHeights: Array.from(row.querySelectorAll<HTMLElement>("[data-file-tree-guide-level]")).map((guide) => guide.getBoundingClientRect().height),
					};
				});
			});
			expect(siblingLayout[1].iconLeft, "sibling files and directories must share the icon column").toBe(siblingLayout[0].iconLeft);
			expect(siblingLayout[1].nameLeft, "sibling files and directories must share the label column").toBe(siblingLayout[0].nameLeft);
			for (const row of siblingLayout) {
				expect(row.iconWidth, "icon column width must be shared by files and directories").toBe(24);
				expect(row.twistieWidth, "twistie slot width must be shared by files and directories").toBe(16);
				expect(row.guideLefts).toEqual([16, 24]);
				expect(row.guideHeights).toEqual([ROW_HEIGHT, ROW_HEIGHT]);
			}
			// 字形尺寸保留各类型原本的观感：目录 18px 线性 folder，文件 24px Seti 彩色图标。
			expect(siblingLayout[0].glyphSize, "directory glyph keeps its 18px size").toEqual({ width: 18, height: 18 });
			expect(siblingLayout[1].glyphSize, "file glyph keeps its 24px size").toEqual({ width: 24, height: 24 });
			// 行必须是块级 flex：行内级盒会在每行下方多出 5px 行盒空隙（行距 33 ≠ 行高 28），
			// 相邻行的引导线会裂成一段一段，吸顶行之间也会露出滚动内容。
			// 展开过程里 Playwright 点击会把面板滚动并把顶部目录固定成 sticky，先回到顶部再量。
			await window.evaluate(() => {
				(document.querySelector(".files-panel") as HTMLElement).scrollTop = 0;
			});
			await window.waitForTimeout(150);
			// 行距必须等于行高，且每段引导线正好铺满所在行——二者同时成立，线才是一条连续竖线。
			// （曾用 inline-flex：行内级盒在 block 容器里会多出 5px 行盒空隙，行距 33px，
			//   相邻两行的引导线之间裂出 5px 缝，看起来「一段一段」。）
			const lineGeometry = await window.evaluate(() => {
				const panel = document.querySelector<HTMLElement>(".files-panel")!;
				const rows = Array.from(panel.querySelectorAll<HTMLElement>(".file-node-row"))
					.map((row) => ({ rect: row.getBoundingClientRect(), display: getComputedStyle(row).display, guides: Array.from(row.querySelectorAll<HTMLElement>(":scope > [data-file-tree-guides] > [data-file-tree-guide-level]")) }))
					.sort((left, right) => left.rect.top - right.rect.top);
				return {
					displays: [...new Set(rows.map((entry) => entry.display))],
					rowGaps: rows.slice(1).map((entry, index) => Math.round(entry.rect.top - rows[index].rect.bottom)),
					segments: rows.flatMap(({ rect, guides }) =>
						guides.map((guide) => {
							const guideRect = guide.getBoundingClientRect();
							return { rowHeight: Math.round(rect.height), height: Math.round(guideRect.height), topMatches: Math.round(guideRect.top) === Math.round(rect.top), bottomMatches: Math.round(guideRect.bottom) === Math.round(rect.bottom) };
						}),
					),
				};
			});
			expect(lineGeometry.displays, "tree rows must be block-level flex").toEqual(["flex"]);
			expect(lineGeometry.rowGaps.length, "must have measured stacked rows to compare").toBeGreaterThan(0);
			expect(lineGeometry.segments.length, "must have measured guide segments to compare").toBeGreaterThan(0);
			expect(
				lineGeometry.rowGaps.every((gap) => gap === 0),
				`rows must stack without inline-box gaps (got ${lineGeometry.rowGaps.join(",")})`,
			).toBe(true);
			expect(
				lineGeometry.segments.every((segment) => segment.height === segment.rowHeight && segment.topMatches && segment.bottomMatches),
				"每段引导线必须正好铺满所在行：漏一点就会在相邻行之间裂出缝，线就成了分段",
			).toBe(true);
			const guides = dirRows
				.filter({ hasText: /^deep$/ })
				.first()
				.locator("[data-file-tree-guides]");
			await window.mouse.move(5, 5);
			await expect(guides).toHaveCSS("opacity", "0");
			await window.locator(".files-panel .file-node-row.file").filter({ hasText: "ex-000.ts" }).first().hover();
			await expect(guides).toHaveCSS("opacity", "1");
			// 「悬停显示了但看不见」是实测过的回归（border-subtle 在浅色 sea-blue 下对比度仅 1.14）：
			// 断言引导线经底色合成后的对比度，而不是只断言 opacity。
			const contrastInTheme = () =>
				window.evaluate(() => {
					const guide = document.querySelector<HTMLElement>(".files-panel [data-file-tree-guide-level]")!;
					const style = getComputedStyle(guide);
					const surface = getComputedStyle(document.querySelector<HTMLElement>(".detail-drawer")!).backgroundColor;
					const canvas = document.createElement("canvas");
					canvas.width = 1;
					canvas.height = 1;
					const ctx = canvas.getContext("2d")!;
					const over = (color: string, base: string) => {
						ctx.clearRect(0, 0, 1, 1);
						ctx.fillStyle = base;
						ctx.fillRect(0, 0, 1, 1);
						ctx.fillStyle = color;
						ctx.fillRect(0, 0, 1, 1);
						const data = ctx.getImageData(0, 0, 1, 1).data;
						return [data[0], data[1], data[2]];
					};
					const luminance = (rgb: number[]) => {
						const channels = rgb.map((value) => {
							const ratio = value / 255;
							return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
						});
						return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
					};
					const background = over(surface, "#ffffff");
					const line = over(style.borderLeftColor, `rgb(${background.join(",")})`);
					const [light, dark] = [luminance(line), luminance(background)].sort((a, b) => b - a);
					return { borderWidth: style.borderLeftWidth, contrast: Number(((light + 0.05) / (dark + 0.05)).toFixed(2)) };
				});
			const lightGuide = await contrastInTheme();
			expect(lightGuide.borderWidth, "guide must be a 1px hairline like VS Code").toBe("1px");
			// 每一套配色都要过：引导线在这种主题下曾跌到 1.14（≈隐形），单测亮/暗两套仍会漏掉自制外观。
			const guideReport: Array<{ palette: string; borderWidth: string; contrast: number }> = [];
			for (const palette of THEME_PALETTES) {
				await window.evaluate(
					(value) => {
						const root = document.documentElement;
						root.dataset.theme = value.theme ?? "light";
						if ("accent" in value) root.dataset.accent = value.accent;
						else delete root.dataset.accent;
						if ("appearance" in value) root.dataset.appearance = value.appearance;
						else delete root.dataset.appearance;
					},
					palette as (typeof THEME_PALETTES)[number],
				);
				const measured = await contrastInTheme();
				expect(measured.borderWidth, `${palette.name}: guide must stay a 1px hairline`).toBe("1px");
				expect(measured.contrast, `${palette.name}: guide must be visible against the panel surface`).toBeGreaterThan(1.5);
				guideReport.push({ palette: palette.name, ...measured });
			}
			// 实测值随附件保存：下次改引导线颜色时能直接对比数值，不用重建探针。
			await testInfo.attach("guide-contrast", { body: JSON.stringify(guideReport, null, 2), contentType: "application/json" });
			await window.evaluate(() => {
				document.documentElement.dataset.theme = "light";
				delete document.documentElement.dataset.accent;
				delete document.documentElement.dataset.appearance;
			});
			await window.locator(".files-panel .file-node-row.file").filter({ hasText: "ex-000.ts" }).first().hover();
			const treeLayout = await window.evaluate(() => {
				const panel = document.querySelector<HTMLElement>(".files-panel")!;
				const rows = Array.from(panel.querySelectorAll<HTMLElement>(".file-node-row.directory"));
				return {
					labelPositions: ["docs", "examples", "deep"].map(
						(name) =>
							rows
								.find((row) => row.querySelector(".file-node-name")?.textContent === name)!
								.querySelector<HTMLElement>(".file-node-name")!
								.getBoundingClientRect().left,
					),
					rootGuideCount: rows.find((row) => row.querySelector(".file-node-name")?.textContent === "docs")!.querySelectorAll("[data-file-tree-guide-level]").length,
					oldGuideContents: Array.from(panel.querySelectorAll(".file-children")).map((children) => getComputedStyle(children, "::before").content),
				};
			});
			expect(treeLayout.labelPositions[1] - treeLayout.labelPositions[0]).toBe(8);
			expect(treeLayout.labelPositions[2] - treeLayout.labelPositions[1]).toBe(8);
			expect(treeLayout.rootGuideCount).toBe(0);
			expect(treeLayout.oldGuideContents.every((content) => content === "none")).toBe(true);
			const drawerRect = (await window.locator(".detail-drawer").boundingBox())!;
			await testInfo.attach("tree-indent", { body: await window.screenshot({ path: testInfo.outputPath("tree-indent.png"), clip: { ...drawerRect, height: Math.min(300, drawerRect.height) } }), contentType: "image/png" });
			await window.mouse.move(5, 5);
			await expect(guides).toHaveCSS("opacity", "0");
			await testInfo.attach("tree-indent-idle", { body: await window.screenshot({ path: testInfo.outputPath("tree-indent-idle.png"), clip: { ...drawerRect, height: Math.min(300, drawerRect.height) } }), contentType: "image/png" });
		}
	}

	// 自然位置没有阴影：不能为了吸顶效果把普通目录行也变成卡片。
	for (const name of stackNames) {
		await expect(dirRows.filter({ hasText: new RegExp(`^${name}$`) }).first()).toHaveAttribute("data-file-sticky-last", "false");
	}

	/** 滚到最深层文件列表中部，返回各层目录行相对面板顶部的位置 */
	const measure = () =>
		window.evaluate(
			(input) => {
				const panel = document.querySelector(".files-panel") as HTMLElement;
				const panelRect = panel.getBoundingClientRect();
				const panelTop = panelRect.top;
				const alphaOf = (color: string) => {
					const parts = color
						.match(/rgba?\(([^)]+)\)/)?.[1]
						.split(",")
						.map((part) => part.trim());
					return parts ? (parts.length === 4 ? Number(parts[3]) : 1) : null;
				};
				const rowByName = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".files-panel .file-node-row.directory")).find((row) => row.querySelector(".file-node-name")?.textContent === name);
				const anchor = Array.from(document.querySelectorAll<HTMLElement>(".files-panel .file-node-row")).find((row) => row.textContent?.includes(input.anchorFile));
				if (!anchor) return null;
				panel.scrollTop = anchor.getBoundingClientRect().top - panelTop + panel.scrollTop + 120;
				return {
					scrollTop: Math.round(panel.scrollTop),
					paddingTop: Number.parseFloat(getComputedStyle(panel).paddingTop),
					contentWidth: panel.clientWidth,
					toolbarHeight: panel.querySelector<HTMLElement>("[data-file-tree-toolbar]")!.getBoundingClientRect().height,
					toolbarTopRelPanel: Math.round(panel.querySelector<HTMLElement>("[data-file-tree-toolbar]")!.getBoundingClientRect().top - panelTop),
					anchorTopRelPanel: Math.round(anchor.getBoundingClientRect().top - panelTop),
					// 抽屉底色（bg-background）是挂顶行必须对齐的底色，任何主题下都应一致
					drawerBackground: getComputedStyle(document.querySelector(".detail-drawer") as HTMLElement).backgroundColor,
					rows: input.names.map((name) => {
						const row = rowByName(name);
						if (!row) return null;
						const style = getComputedStyle(row);
						const rect = row.getBoundingClientRect();
						const edgeRow = document.elementFromPoint(panelRect.left + 1, rect.top + rect.height / 2)?.closest(".file-node-row");
						return {
							name,
							topRelPanel: Math.round(rect.top - panelTop),
							leftRelPanel: Math.round(rect.left - panelRect.left),
							width: Math.round(rect.width),
							borderRadius: style.borderRadius,
							position: style.position,
							backgroundAlpha: alphaOf(style.backgroundColor),
							backgroundColor: style.backgroundColor,
							edgeRowName: edgeRow?.querySelector(".file-node-name")?.textContent,
						};
					}),
				};
			},
			{ names: [...stackNames, DEEPER.dir], anchorFile: "sb-020.ts" },
		);

	// 期望：第 i 层紧接固定工具行，不留下透出滚动文字的顶部缝隙。
	const expectedOffsets = (toolbarHeight: number) => stackNames.map((_, index) => Math.round(toolbarHeight) + index * ROW_HEIGHT);
	// 鼠标从行上移开并等过渡结束：hover 高亮与 transition-base 会让底色暂时偏离抽屉底色
	await window.mouse.move(5, 5);
	await window.waitForTimeout(300);
	// 展开是 200ms 高度动画：动画期间 CollapsibleContent 只有几 px，目录行的 containing block
	// 随之缩水、没有可挂顶的余量（子层会停在自然位置）。轮询到稳态再断言，否则量到的是动画中间态。
	await expect
		.poll(
			async () => {
				const snapshot = await measure();
				if (!snapshot || snapshot.rows.some((row) => row === null)) return "pending";
				// 只比挂顶栈（最外层三层）；第 4 层 sub 不挂顶，位置随内容变化
				const offsets = snapshot.rows.slice(0, stackNames.length).map((row) => row!.topRelPanel);
				const expected = expectedOffsets(snapshot.toolbarHeight);
				return offsets.join(",") === expected.join(",") ? "settled" : offsets.join(",");
			},
			{ timeout: 10_000 },
		)
		.toBe("settled");
	const sticky = await measure();
	expect(sticky, "file tree rows must be present").not.toBeNull();
	const report = sticky!;

	// 前置：确实滚进了最深层（锚点行已滚到面板顶部之上）
	expect(report.scrollTop).toBeGreaterThan(500);
	expect(report.anchorTopRelPanel).toBeLessThan(0);
	// 最外层三层逐级挂顶，紧接贴边且固定的工具行。
	expect(report.paddingTop).toBe(0);
	expect(report.toolbarTopRelPanel).toBe(0);
	const stack = report.rows.slice(0, stackNames.length).map((row, index) => {
		expect(row, `directory row ${stackNames[index]} must be present`).not.toBeNull();
		return row!;
	});
	expect(stack.map((row) => row.topRelPanel)).toEqual(expectedOffsets(report.toolbarHeight));
	for (const row of stack) {
		expect(row.position).toBe("sticky");
		// 吸顶区必须是贴边的完整平面，不能缩成有圆角的胶囊而露出后面的文件名。
		expect(row.borderRadius, "sticky directory rows must not have rounded corners").toBe("0px");
		expect(row.leftRelPanel, "sticky rows must cover the left edge of the scrollport").toBe(0);
		expect(row.width, "sticky rows must cover the entire scrollport width at every depth").toBe(report.contentWidth);
		expect(row.edgeRowName, "scrolling descendants must not show through the left edge").toBe(row.name);
		// 挂顶行必须不透明、且与抽屉底色同一 token：半透明/异色底会让下层行文字透出来（读写困难）
		expect(row.backgroundAlpha, "sticky header background must be fully opaque").toBe(1);
		expect(row.backgroundColor, "sticky header background must match the drawer surface").toBe(report.drawerBackground);
	}
	// 超过挂顶上限的第 4 层不 sticky（VSCode 只固定最外层 maxLineCount 条，更深的随内容滚走）
	const deeper = report.rows[stackNames.length];
	expect(deeper, `directory row ${DEEPER.dir} must be present`).not.toBeNull();
	expect(deeper!.position).toBe("relative");
	for (const [index, name] of stackNames.entries()) {
		const row = dirRows.filter({ hasText: new RegExp(`^${name}$`) }).first();
		await expect(row).toHaveAttribute("data-file-stuck", "true");
		await expect(row).toHaveAttribute("data-file-sticky-last", String(index === stackNames.length - 1));
		if (index === stackNames.length - 1) {
			await expect.poll(() => row.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
		} else {
			await expect(row).toHaveCSS("box-shadow", "none");
		}
	}
	// 保留实际抽屉截图，便于审查浅色/暗色下的遮挡边界与底部层次。
	const drawer = window.locator(".detail-drawer");
	await testInfo.attach("sticky-light", { body: await drawer.screenshot({ path: testInfo.outputPath("sticky-light.png") }), contentType: "image/png" });
	await dirRows
		.filter({ hasText: /^deep$/ })
		.first()
		.hover();
	await testInfo.attach("sticky-hover", { body: await drawer.screenshot({ path: testInfo.outputPath("sticky-hover.png") }), contentType: "image/png" });
	const drawerRect = await drawer.boundingBox();
	expect(drawerRect).not.toBeNull();
	await testInfo.attach("sticky-preview", {
		body: await window.screenshot({ path: testInfo.outputPath("sticky-preview.png"), clip: { ...drawerRect!, height: Math.min(300, drawerRect!.height) } }),
		contentType: "image/png",
	});
	await window.mouse.move(5, 5);
	await window.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	await expect.poll(async () => (await measure())?.drawerBackground).not.toBe(report.drawerBackground);
	await expect
		.poll(async () => {
			const snapshot = await measure();
			return snapshot?.rows.slice(0, stackNames.length).every((row) => row?.backgroundAlpha === 1 && row.backgroundColor === snapshot.drawerBackground);
		})
		.toBe(true);
	await testInfo.attach("sticky-dark", { body: await drawer.screenshot({ path: testInfo.outputPath("sticky-dark.png") }), contentType: "image/png" });
	await window.evaluate(() => {
		const panel = document.querySelector<HTMLElement>(".files-panel")!;
		panel.scrollTop = 0;
	});
	await expect(window.locator('[data-file-stuck="true"]')).toHaveCount(0);
	await expect(window.locator('[data-file-sticky-last="true"]')).toHaveCount(0);
});

import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const ticks = load("src/renderer/src/components/session/timeline/outlineRailTicks.ts");

test("间距按实际条数算：total x size 不超过可用高度（容量范围内）", () => {
	// 判据就是这一句。PreviewRail 的导轨总高 = items.length x itemSize。
	//
	// 适用下界：availableHeight >= 24（容器最少够两根 12px 刻度）。更小的窗口不保证 ——
	// h=20 时 capacity=1、limit=max(1, 0)=1、total=2、size 被 12px 下限提到 12，
	// 24 > 20 仍然溢出。现实里不会出现（容器是整条右缘、由 top/bottom 夹持），
	// 但造样本时别拿 h<24 去测，否则会以为修法错了、跑去改对的代码。
	for (const h of [400, 600, 792, 800, 900, 1080]) {
		const capacity = ticks.railCapacity(h);
		// 占位项从容量里扣一格后，实际条数 <= capacity
		const total = capacity;
		const size = ticks.planRailItemSize(total, h, 14);
		assert.ok(total * size <= h, "h=" + h + " total=" + total + " size=" + size + " 溢出 " + (total * size - h));
	}
});

test("不扣占位项那一格就会溢出（把缺陷形状钉下来）", () => {
	// 这是这一版的真缺陷：railCapacity(792) = 66，加占位项后 67 根。
	// 间距被 12px 下限顶住，67 x 12 = 804 > 792。
	const h = 792;
	const capacity = ticks.railCapacity(h);
	assert.equal(capacity, 66);
	const withoutDeduction = capacity + 1;
	const size = ticks.planRailItemSize(withoutDeduction, h, 14);
	assert.equal(size, 12, "12px 是硬下限，不会再降");
	assert.ok(withoutDeduction * size > h, "不扣一格时必然溢出，这是需要扣的理由");
});

test("间距夹在 [12, 14] 之内", () => {
	assert.equal(ticks.planRailItemSize(2, 800, 14), 14, "宽松时不超过上限 14");
	assert.equal(ticks.planRailItemSize(100, 800, 14), 12, "拥挤时不低于下限 12");
	assert.equal(ticks.planRailItemSize(66, 800, 14), 12);
});

test("未测量时回退到 fallback", () => {
	assert.equal(ticks.planRailItemSize(0, 800, 14), 14);
	assert.equal(ticks.planRailItemSize(50, 0, 14), 14);
});

test("新增目录面板的 i18n key 三种语言齐全", () => {
	// 硬编码中文会让英文/繁中界面下出现一个简体中文面板。
	const keys = ["outline.panel", "outline.searchPlaceholder", "outline.searchAria", "outline.collapse", "outline.expand", "outline.onlyRange", "outline.hits", "outline.total", "outline.earlier", "outline.earlierAria"];
	for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
		const source = readFileSync("src/renderer/src/i18n/rendererCopy." + locale + ".ts", "utf8");
		for (const key of keys) {
			assert.ok(source.includes('"' + key + '":'), locale + " 缺 key " + key);
		}
	}
});

test("带占位符的 key 在三种语言里都保留同名占位符", () => {
	const keys = ["outline.onlyRange", "outline.hits", "outline.total", "outline.earlier", "outline.earlierAria"];
	for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
		const source = readFileSync("src/renderer/src/i18n/rendererCopy." + locale + ".ts", "utf8");
		for (const key of keys) {
			const line = source.split("\n").find((row) => row.includes('"' + key + '":'));
			assert.ok(line, locale + " 缺 " + key);
			assert.ok(line.includes("{count}"), locale + " 的 " + key + " 缺 {count} 占位符");
		}
	}
});

test("新增 UI 组件里不再有硬编码中文文案", () => {
	const panel = readFileSync("src/renderer/src/components/session/SessionOutlinePanel.tsx", "utf8");
	const lines = panel.split("\n").filter((row) => {
		const trimmed = row.trim();
		return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
	});
	const offenders = lines.filter((row) => /(placeholder|aria-label|ariaLabel)="[^"]*[\u4e00-\u9fa5]/.test(row));
	assert.deepEqual(offenders, [], "仍有硬编码中文的 aria/placeholder：" + offenders.join(" | "));
});

test("源码级：占位项必须从 railCapacity 里扣掉一格，间距必须走 planRailItemSize", () => {
	// 纯函数测试锁不住组件里这两个接线点：把 railLimit 改回 railCapacity(availableHeight)、
	// 或把 itemSize 改回 plan.itemSize，上面几条纯函数测试照样全绿。
	const source = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	assert.match(source, /capacity - \(hasHead \? 1 : 0\)/, "占位项必须扣掉一格");
	assert.match(source, /planRailItemSize\(total, availableHeight, plan\.itemSize\)/, "间距必须走 planRailItemSize");
	assert.doesNotMatch(source, /itemSize=\{plan\.itemSize\}/, "不得再用 plan.itemSize 当导轨间距");
});

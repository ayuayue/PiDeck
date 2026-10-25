import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";

/**
 * 动效 token 纪律（2026-10 motion 第三线：过渡曲线 / 弹层出场节奏）。
 *
 * tailwind.css 的既有约定（唯一真源）：
 * - 时长三档 @utility：duration-fast=120ms 微反馈（hover/active）、
 *   duration-base=200ms 常规（弹层/展开）、duration-slow=320ms 面板级；
 * - 缓动：--ease-out-quint 进场、ease-in 离场；
 * - 「新动画一律引用这些 utility，禁止散落裸时长/裸缓动」。
 *
 * 本批收敛两类违例：
 * 1. 裸时长 utility（duration-100/150/200、duration-[120ms]）→ 统一归 token
 *    （100/150→fast、200→base、[120ms]→fast）；
 * 2. 弹层出场节奏缺口：context-menu 完全没接 token（tw-animate 默认 150ms +
 *    默认 ease，与同族的 dropdown-menu 不同拍）；alert-dialog 遮罩缺 duration-base
 *    （dialog 遮罩有）——同屏两个 modal 遮罩淡入时长不一致。
 *
 * 刻意保留（白名单）：
 * - web/ 目录：Web 端自有动效体系（240ms grid-rows + 自选曲线，另一套节奏语言）；
 * - motion/animated-badge.tsx：beUI 官方拷贝，禁止私改（AGENTS.md）；
 * - SurfaceComponents / RespondingTips 的 duration-500：空态首帧与轮换提示的
 *   设计性长淡入编排（带 delay-100/200/300 级联），三档 token 表达不了。
 */

const root = "src/renderer/src";

function listTsx() {
	return execFileSync("git", ["ls-files", "src/renderer/src"], { encoding: "utf8" })
		.split("\n")
		.filter((path) => path.endsWith(".tsx") && path.startsWith("src/renderer/src/"));
}

/** 白名单：文件 → 允许出现的裸时长集合。 */
const RAW_DURATION_ALLOWLIST = {
	"src/renderer/src/components/session/SurfaceComponents.tsx": ["duration-500"],
	"src/renderer/src/components/session/RespondingTips.tsx": ["duration-500"],
};

const RAW_DURATION_RE = /duration-\d{2,4}\b|duration-\[\d+ms\]/g;

test("renderer 源码不散落裸时长 utility（统一走 duration-fast/base/slow 三档）", () => {
	const offenders = [];
	for (const path of listTsx()) {
		// web 自有体系与 beUI 官方拷贝不在本纪律管辖内
		if (path.startsWith("src/renderer/src/web/") || path.includes("/components/motion/")) continue;
		const source = readFileSync(path, "utf8");
		const allowed = RAW_DURATION_ALLOWLIST[path] ?? [];
		const hits = [...source.matchAll(RAW_DURATION_RE)].map((match) => match[0]);
		const illegal = hits.filter((hit) => !allowed.includes(hit));
		if (illegal.length > 0) offenders.push(path + ": " + [...new Set(illegal)].join(", "));
	}
	assert.deepEqual(offenders, [], "裸时长必须归一到 duration-fast(120)/base(200)/slow(320)，见 tailwind.css 唯一真源");
});

/** 弹层面板 content：出场节奏必须同一拍（base 200ms + ease-out-quint 进 / ease-in 出）。 */
const OVERLAY_CONTENTS = ["components/ui-shadcn/dialog.tsx", "components/ui-shadcn/alert-dialog.tsx", "components/ui-shadcn/dropdown-menu.tsx", "components/ui-shadcn/popover.tsx", "components/ui-shadcn/select.tsx", "components/ui-shadcn/hover-card.tsx", "components/ui-shadcn/context-menu.tsx"];

for (const path of OVERLAY_CONTENTS) {
	test(path + " 弹层出场走 duration-base + ease-out-quint/ease-in 同一拍", () => {
		const source = readFileSync(root + "/" + path, "utf8");
		// content 面板动画类分布在 cn() 的多行字符串里，断言按整文件配对（同文件内所有
		// zoom-in-95 面板共用同一组类，整文件级配对即覆盖两处 SubContent 等变体）
		assert.match(source, /zoom-in-95/, "必须能找到弹层 content 的动画类");
		assert.match(source, /duration-base/, "弹层 content 必须 duration-base（200ms 常规档）");
		// 既有形态：裸 ease-out-quint 是进场默认（元素级 transition-timing），
		// data-[state=closed]:ease-in 覆盖离场——比逐 state 写缓动少一层前缀
		assert.match(source, /(?:^|[^:\w-])ease-out-quint/, "进场必须 ease-out-quint（裸 utility 形态）");
		assert.match(source, /data-\[state=closed\]:ease-in/, "离场必须 ease-in");
	});
}

test("tooltip 保持微反馈档（duration-fast），不与弹层 content 同拍", () => {
	const source = readFileSync(root + "/components/ui-shadcn/tooltip.tsx", "utf8");
	assert.match(source, /duration-fast/, "tooltip 是微反馈：fast 120ms");
	assert.match(source, /ease-out-quint/, "进场缓动与其余弹层同曲线");
	assert.doesNotMatch(source, /duration-base/, "tooltip 不该用 base——悬停高频出现，200ms 会显得迟滞");
});

test("modal 遮罩（dialog / alert-dialog overlay）同拍 duration-base", () => {
	for (const path of ["components/ui-shadcn/dialog.tsx", "components/ui-shadcn/alert-dialog.tsx"]) {
		const source = readFileSync(root + "/" + path, "utf8");
		// 用使用形态定位（bg-[var(--overlay-backdrop)]）：文件头的注释也提到 token 名，
		// 用 includes("overlay-backdrop") 会先命中注释行
		const overlayLine = source.split("\n").find((line) => line.includes("bg-[var(--overlay-backdrop)]"));
		assert.ok(overlayLine, "必须能找到遮罩行");
		assert.match(overlayLine, /duration-base/, "遮罩淡入必须与 content 同拍（base 200ms），同屏双 modal 不闪不同步");
	}
});

test("JS 侧 token 孪生（lib/motionTokens）与 tailwind.css 互钉", () => {
	const css = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	const tokens = readFileSync("src/renderer/src/lib/motionTokens.ts", "utf8");
	assert.match(css, /--ease-out-quint:\s*cubic-bezier\(0\.22, 1, 0\.36, 1\);/, "tailwind 侧 quint 曲线被改动时必须同步 motionTokens 与全部消费点");
	for (const [name, value] of [
		["DURATION_FAST_MS", "120"],
		["DURATION_BASE_MS", "200"],
		["DURATION_SLOW_MS", "320"],
	]) {
		assert.match(tokens, new RegExp("export const " + name + " = " + value + ";"), name + " 必须与 @utility 三档同值");
	}
	assert.match(tokens, /EASE_OUT_QUINT_CSS = "cubic-bezier\(0\.22, 1, 0\.36, 1\)"/, "JS 孪生曲线必须与 --ease-out-quint 同值");
});

test("renderer .tsx 不散落 cubic-bezier 字面量（曲线统一走 token / var(--ease-out-quint)）", () => {
	const offenders = [];
	for (const path of listTsx()) {
		// 白名单：web/ 自有体系、components/motion/（beUI 官方拷贝）
		if (path.startsWith("src/renderer/src/web/") || path.includes("/components/motion/")) continue;
		const source = readFileSync(path, "utf8");
		if (source.includes("cubic-bezier(")) offenders.push(path);
	}
	assert.deepEqual(offenders, [], "曲线字面量必须换成 var(--ease-out-quint) 或 lib/motionTokens 的孪生常量");
});

test("renderer 不新增 transition-all（过渡只动实际会变的属性）", () => {
	// 白名单：ui-shadcn 上游标准件（button/progress/switch 保持 shadcn 原版类，
	// CLI 覆盖安装才不冲突）；web/ 自有体系
	const allow = ["src/renderer/src/components/ui-shadcn/button.tsx", "src/renderer/src/components/ui-shadcn/progress.tsx", "src/renderer/src/components/ui-shadcn/switch.tsx"];
	const offenders = [];
	for (const path of listTsx()) {
		if (path.startsWith("src/renderer/src/web/") || allow.includes(path)) continue;
		if (readFileSync(path, "utf8").includes("transition-all")) offenders.push(path);
	}
	assert.deepEqual(offenders, [], "transition-all 会顺带动画无关属性（布局/阴影/尺寸），按实际变化的属性显式声明（transition-colors / transition-[width,...] 等）");
});

test("任意值动画必须 motion-safe 前缀（tw-animate 的自动降级罩不到 animate-[...]）", () => {
	const offenders = [];
	for (const path of listTsx()) {
		if (path.startsWith("src/renderer/src/web/")) continue;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			// 命中 animate-[ 且同一行没有 motion-safe: 前缀形态（任意值动画不走
			// tw-animate 的 prefers-reduced-motion 自动关闭，必须显式前缀）
			if (/animate-\[/.test(line) && !/motion-safe:animate-\[/.test(line)) {
				offenders.push(path + ":" + line.trim().slice(0, 80));
			}
		}
	}
	assert.deepEqual(offenders, [], "任意值动画（animate-[...]）必须 motion-safe: 前缀，reduced-motion 下静态呈现");
});

test("三档时长 @utility 是唯一真源（tailwind.css）", () => {
	const source = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	for (const [name, value] of [
		["duration-fast", "120ms"],
		["duration-base", "200ms"],
		["duration-slow", "320ms"],
	]) {
		assert.match(source, new RegExp("@utility " + name + " \\{[\\s\\S]{0,80}?transition-duration: " + value + ";"), name + " 必须仍是 " + value);
	}
});

/**
 * pi-deck-ext-points —— 扩展点面板入口：挂 GUI 贡献（静态清单）+ 注册 /ext-points 命令（交互面板）。
 *
 * 本文件是 **PiDeck 内置扩展**（随应用 `resources/extensions/` 分发、启动时经 `-e` 注入），
 * 前身是独立分发的 `pi-ext-points` 扩展；改为内置后落点优先级反转，见下。
 *
 * ## 挂载面（按可靠性分层）
 *
 * 1. **GUI 贡献**（桥的落点，两条路径按桥的能力择优）：
 *    - 桥有 `setConfigPage`（v1.3 起）→ 推 **`config.page` 整页**（PiDeck「Pi 管理 →
 *      Agent 能力 → 扩展点」一级导航页）—— 静态全量清单，零交互依赖；
 *    - 老桥只有 `setSettingsSection` → 推**设置弹窗里的卡片**（退化路径）；
 *      两条路径推的是**同一棵树**，只是容器不同；
 *    - 两者都没有（纯终端 pi / 桥被禁用）→ 不推任何 GUI 贡献，只记日志。
 * 2. 「/ext-points 命令」（`pi.registerCommand`）—— 勾选、写用途、生成草稿的全流程，
 *    全部走 `ctx.ui.select / input / confirm / notify / setEditorText`
 *    （pi 原生对话框，桥 passthrough，PiDeck 有原生卡片）。
 *    **与 GUI 落点无关，任何情况下都注册**：纯终端 pi 里同样可用。
 *
 * ## 为什么落点优先级是「整页优先」
 *
 * 独立分发时这个扩展要**避开** PiDeck 内置的扩展点面板（有 `setConfigPage` 就不推
 * `settings.section`），否则设置弹窗底部会多出一份重复清单。成为内置扩展后
 * 它自己就是那个面板，于是反转成「优先占一级页」——仍然只占一处，不会重复；
 * 老桥没有 `setConfigPage` 时退回设置卡片，守住「桥退化时功能不缺席」。
 *
 * ## 状态
 *
 * 全部状态（勾选集合 / 用途表 / 目录）在本模块闭包里，随会话存在；
 * 状态一变就重设贡献（同 key 覆盖，桥按哈希去重推送）。
 *
 * ## 生命周期配对
 *
 * 本模块创建的两类东西都必须在同一模块找到清理路径（见 `session_shutdown`）：
 * ① 重试 timer（`clearTimeout`）；② 落点贡献（同 key 传 `undefined` 撤回，
 * 与桥 `makeSlotSetter`「传 undefined 即移除该 key」的契约一致）。
 */

import { loadCatalog, type Catalog, type GuiNamespace } from "./pi-deck-ext-points-catalog";
import { buildDraft, renderSection, type SectionNode } from "./pi-deck-ext-points-panel";

/** 桥的落点 key（同 key 重设 = 刷新；传 undefined = 撤回贡献）。 */
const SECTION_KEY = "ext-points";
/** order 900：排在 PiDeck 内置「扩展」区块下方（内置区块 order 更小）。 */
const SECTION_ORDER = 900;
/** 贡献标题：config.page 的一级导航项文字 = 设置卡片标题。 */
const SECTION_TITLE = "扩展点";

/** 能用的 ctx 最小面（不 import pi 类型，避免硬依赖 pi 版本）。 */
type Ctx = {
	ui: Record<string, (...args: unknown[]) => unknown> & {
		select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
		/** 桥「最先可用」挂上共享 ui 单例的 GUI 扩展点（纯终端/旧桥无）。 */
		gui?: GuiNamespace;
	};
	gui?: GuiNamespace;
};

/** 落点路径：整页（有 setConfigPage 的桥）/ 设置卡片（老桥）。 */
type SlotPath = "configPage" | "settingsSection";

/**
 * 取 gui 扩展点：优先 `ctx.ui.gui`（桥挂在共享 ui 单例上，不依赖加载顺序），
 * 退回 `ctx.gui`（旧桥仅挂在当次 emit 的 ctx 上，向后兼容）。
 */
function guiOf(ctx: Ctx | null): GuiNamespace | undefined {
	return ctx?.ui?.gui ?? ctx?.gui;
}

/**
 * 归一化 gui：替身 / 半截实现（只挂了一个 setter）也要能进来，
 * 因此下面一律用 `typeof … === "function"` 判可用，不假设 gui 形状完整。
 */
function normalizeGui(gui: GuiNamespace | undefined): Partial<GuiNamespace> | undefined {
	return gui && typeof gui === "object" ? (gui as Partial<GuiNamespace>) : undefined;
}

/**
 * 选定落点路径：有 `setConfigPage` 就用整页，否则退设置卡片，都没有返回 null。
 *
 * 返回值同时承担「gui 是否可用」的判据 —— 调用方不需要再单独看 gui 是否存在。
 */
function pickSlotPath(gui: Partial<GuiNamespace> | undefined): SlotPath | null {
	if (typeof gui?.setConfigPage === "function") return "configPage";
	if (typeof gui?.setSettingsSection === "function") return "settingsSection";
	return null;
}

/** 结构化访问 ctx.ui（pi 与桥的方法都在上面，调用形态以 pi 的 .d.ts 为准）。 */
function ui(ctx: Ctx): Record<string, (...args: unknown[]) => unknown> {
	return ctx.ui;
}

const log = (message: string): void => {
	process.stderr.write(`[pi-deck-ext-points] ${message}\n`);
};

/** 单个点的展示名（清单与 select 选项共用，保证同名可回查）。 */
function pointLabel(catalog: Catalog, id: string): string {
	return catalog.points.find((p) => p.id === id)?.label ?? id;
}

export default function extPoints(pi: {
	registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> }) => void;
	on: (event: string, handler: (event: unknown, ctx: Ctx) => void) => void;
}): void {
	// ── 会话级状态 ──────────────────────────────────────────────
	let catalog: Catalog | null = null;
	const selected = new Set<string>(); // 勾选集合（Set 保插入序 = 草稿编号序；panel 按 has/size 消费）
	const purposes = new Map<string, string>();
	let mounted = false;
	/** 当前挂在哪条落点路径上（撤回贡献要找对 setter；null = 没有贡献要撤）。 */
	let activeSlot: SlotPath | null = null;
	/** 最近一次 session/agent 事件的 ctx：桥在同一次 emit 的后续 handler 里给同一个 ctx 挂 gui，
	 *  我们先跑拿不到，但闭包里存住它，稍后重试就能看到（getter 是活的）。 */
	let pendingCtx: Ctx | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** 已排过一次重试但还没跑（`session_start` 与 `agent_start` 会各调一次 mount，
	 *  没有这个闸门就会排两个 timer，桥挂上后**推两次同 key 贡献**）。 */
	let retryScheduled = false;

	/** 重设贡献（同 key 覆盖 → 桥 dispose 旧贡献、重跑 factory、按哈希推送）。 */
	function refreshSection(ctx: Ctx): void {
		const gui = normalizeGui(guiOf(ctx));
		const path = pickSlotPath(gui);
		if (!mounted || !catalog || !path || !gui) return;
		try {
			const factory = (): SectionNode => renderSection(catalog as Catalog, selected, purposes);
			// 两条路径推同一棵树，只是容器不同（一级页 / 设置弹窗卡片）。
			// 有 setConfigPage 时**不**同时推 settings.section —— 否则设置弹窗底部会多出一份重复内容。
			if (path === "configPage") gui.setConfigPage?.(SECTION_KEY, factory, { title: SECTION_TITLE, order: SECTION_ORDER });
			else gui.setSettingsSection?.(SECTION_KEY, factory, { title: SECTION_TITLE, order: SECTION_ORDER });
			activeSlot = path;
		} catch (error) {
			log(`刷新 GUI 贡献失败（已吞）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * 撤回贡献：同 key 传 `undefined`（桥 `makeSlotSetter` 的契约：移除该 key，
	 * 位置回到原样，不占位）。与 `refreshSection` 成对 —— 会话结束必须撤，
	 * 否则下一个会话的贡献会叠在旧贡献之上。
	 *
	 * gui 取 `ctx` 优先、退回挂载时存下的 `pendingCtx`：shutdown 的 ctx 上不一定带
	 * gui，而撤回用的是桥自己的贡献表（键控在 runtime 上），哪个 ctx 都一样有效。
	 */
	function retractSection(ctx: Ctx | null): void {
		if (!activeSlot) return;
		const gui = normalizeGui(guiOf(ctx)) ?? normalizeGui(guiOf(pendingCtx));
		if (!gui) return;
		try {
			const setter = activeSlot === "configPage" ? gui.setConfigPage : gui.setSettingsSection;
			setter?.(SECTION_KEY, undefined);
		} catch (error) {
			log(`撤回 GUI 贡献失败（已吞）: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			activeSlot = null;
		}
	}

	/** 尝试挂载：gui 就绪则加载清单并推首树。幂等。 */
	function tryMount(ctx: Ctx): boolean {
		if (mounted) return true;
		const gui = normalizeGui(guiOf(ctx));
		const path = pickSlotPath(gui);
		if (!path || !gui) return false;
		const methods = Object.keys(gui).filter((key) => /^set[A-Z]/.test(key) && typeof (gui as Record<string, unknown>)[key] === "function");
		catalog = loadCatalog(gui, `桥 ctx.gui 运行时枚举（${methods.length} 个落点）`);
		mounted = true;
		refreshSection(ctx);
		log(
			path === "configPage"
				? `扩展点清单已挂到一级页（Pi 管理 → Agent 能力 → 扩展点，${catalog.points.length} 个点）`
				: `扩展点清单已挂到设置弹窗卡片（桥无 setConfigPage，退化路径，${catalog.points.length} 个点）`,
		);
		return true;
	}

	/**
	 * 单次宏任务重试：session_start 同步段桥还没跑（pi 按 -e 后加载桥），
	 * 但 pi 的 emit 是串行 await——桥 handler 在我们之后、**同一次 emit 内**执行完；
	 * 而 `ctx.ui.gui` 挂在共享 ui 单例上（「桥最先可用」PROMPT §四.A），
	 * 所以一个 setTimeout(0)（宏任务，必然晚于本次 emit 全部 handler）后必成，
	 * 无需指数退避。失败只剩一种可能：桥未安装 / 纯终端。
	 */
	function scheduleRetry(): void {
		if (retryTimer || retryScheduled || mounted) return;
		retryScheduled = true;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			retryScheduled = false;
			if (mounted || !pendingCtx) return;
			if (!tryMount(pendingCtx)) {
				log("ctx.gui / ctx.ui.gui 的落点 setter 均不可用（桥未安装、桥被禁用或纯终端）。不推 GUI 贡献，/ext-points 命令仍可用；新会话会重试");
			}
		}, 0);
	}

	/** 事件路径挂载入口：保存 ctx 供单次重试，成功则立即挂。 */
	function mount(ctx: Ctx): void {
		pendingCtx = ctx;
		if (!tryMount(ctx)) scheduleRetry();
	}

	// ── /ext-points：交互面板（全 ctx.ui 对话框，终端/GUI 两栖）──
	async function openPanel(ctx: Ctx): Promise<void> {
		if (!catalog) {
			// 命令 ctx 是独立新对象；guiOf 同时试 ctx.ui.gui（共享单例）与会话期存下的 ctx
			if (pendingCtx) tryMount(pendingCtx);
			tryMount(ctx);
			if (!catalog) catalog = loadCatalog(guiOf(ctx), "无桥降级（仅 pi 原生点，无 PiDeck 落点）");
		}
		const c = catalog;
		if (!c || c.points.length === 0) {
			ui(ctx).notify?.("没有读到任何可挂载点（pi 类型定义读取失败且桥未挂载）", "error");
			return;
		}
		const u = ui(ctx);
		const ask = u.select as ((title: string, options: string[]) => Promise<string | undefined>) | undefined;
		if (!ask) {
			log("ctx.ui.select 不可用，面板无法打开");
			return;
		}

		while (true) {
			const groups: Array<{ key: "ui" | "event" | "gui"; title: string }> = [
				{ key: "ui", title: `浏览 pi 原生 UI 点（${c.points.filter((p) => p.group === "ui").length}）` },
				{ key: "event", title: `浏览 pi 扩展事件（${c.points.filter((p) => p.group === "event").length}）` },
				{ key: "gui", title: `浏览 PiDeck 专属落点（${c.points.filter((p) => p.group === "gui").length}）` },
			];
			const main = await ask(
				`扩展点面板（已勾选 ${selected.size} / ${c.points.length}）`,
				[...groups.map((g) => g.title), "📋 已勾选与用途", "📝 生成草稿（放进输入框）", "🧹 清空勾选"],
			);
			if (main === undefined) return; // 用户取消 → 退出面板

			const group = groups.find((g) => g.title === main);
			if (group) {
				await browseGroup(ctx, c, group.key, ask);
				continue;
			}
			if (main === "📋 已勾选与用途") {
				await manageSelected(ctx, c, ask);
				continue;
			}
			if (main === "📝 生成草稿（放进输入框）") {
				await generateDraft(ctx, c);
				continue;
			}
			if (main === "🧹 清空勾选") {
				if (selected.size === 0) {
					u.notify?.("还没有勾选任何扩展点", "info");
					continue;
				}
				const confirmed = await (u.confirm as ((title: string, message: string) => Promise<boolean>) | undefined)?.(`清空 ${selected.size} 个勾选？用途记录一并清除。`);
				if (confirmed) {
					selected.clear();
					purposes.clear();
					refreshSection(ctx);
				}
			}
		}
	}

	/** 浏览一组：单选一个点 → 进入点详情。 */
	async function browseGroup(ctx: Ctx, c: Catalog, group: "ui" | "event" | "gui", ask: (title: string, options: string[]) => Promise<string | undefined>): Promise<void> {
		const points = c.points.filter((p) => p.group === group);
		while (true) {
			const options = points.map((p) => `${selected.has(p.id) ? "☑" : "☐"} ${p.label}${purposes.has(p.id) ? "（已写用途）" : ""}`);
			const picked = await ask(`该组共 ${points.length} 个，勾选后用于生成草稿`, options);
			if (picked === undefined) return;
			const point = points[options.indexOf(picked)];
			if (!point) continue;
			await pointDetail(ctx, point.id, ask);
		}
	}

	/** 点详情：勾选/取消、写用途。 */
	async function pointDetail(ctx: Ctx, id: string, ask: (title: string, options: string[]) => Promise<string | undefined>): Promise<void> {
		const c = catalog as Catalog;
		const point = c.points.find((p) => p.id === id);
		if (!point) return;
		const u = ui(ctx);
		while (true) {
			const isChecked = selected.has(id);
			const detail = [point.signature, point.note, purposes.has(id) ? `主要用来：${purposes.get(id)}` : "主要用来：（未填写）"].filter(Boolean).join("\n");
			const action = await ask(`${point.label}\n${detail}`, [
				isChecked ? "☐ 从草稿取消勾选" : "☑ 勾选进草稿",
				purposes.has(id) ? "✏️ 修改用途" : "✏️ 填写用途",
				"⬅️ 返回",
			]);
			if (action === undefined) return;
			if (action === "⬅️ 返回") return;
			if (action.endsWith("勾选进草稿")) {
				selected.add(id);
				refreshSection(ctx);
				continue;
			}
			if (action === "☐ 从草稿取消勾选") {
				selected.delete(id);
				refreshSection(ctx);
				continue;
			}
			if (action.startsWith("✏️")) {
				const current = purposes.get(id) ?? "";
				const text = await (u.input as ((title: string, placeholder?: string) => Promise<string | undefined>) | undefined)?.(`「${point.label}」主要用来`, current || "一句话，例：给状态栏加一个 token 计数");
				if (text && text.trim()) purposes.set(id, text.trim());
				else if (text !== undefined && !text.trim()) purposes.delete(id); // 空提交 = 清除
				refreshSection(ctx);
			}
		}
	}

	/** 管理已勾选：列出 → 选中 → 进点详情。 */
	async function manageSelected(ctx: Ctx, c: Catalog, ask: (title: string, options: string[]) => Promise<string | undefined>): Promise<void> {
		while (true) {
			if (selected.size === 0) {
				ui(ctx).notify?.("还没有勾选任何扩展点", "info");
				return;
			}
			const options = [...selected].map((id) => `${pointLabel(c, id)}${purposes.has(id) ? "（已写用途）" : ""}`);
			const picked = await ask(`已勾选 ${selected.size} 个（选中可管理）`, options);
			if (picked === undefined) return;
			const id = selected[options.indexOf(picked)];
			if (id) await pointDetail(ctx, id, ask);
		}
	}

	/** 生成草稿：问名字 → 塞进输入框 → 通知。 */
	async function generateDraft(ctx: Ctx, c: Catalog): Promise<void> {
		const u = ui(ctx);
		if (selected.size === 0) {
			u.notify?.("先勾选至少一个扩展点再生成草稿", "warning");
			return;
		}
		const name = await (u.input as ((title: string, placeholder?: string) => Promise<string | undefined>) | undefined)?.("扩展名称和大概功能", "例：给状态栏加一个 token 计数");
		if (name === undefined) return; // 取消
		const draft = buildDraft([...selected], purposes, name ?? "", c);
		try {
			(u.setEditorText as ((text: string) => void) | undefined)?.(draft);
			u.notify?.("草稿已放进输入框，检查后直接发送即可", "info");
		} catch (error) {
			// setEditorText 不可用时退化为通知正文（至少草稿不丢）
			u.notify?.(`草稿生成失败（${error instanceof Error ? error.message : String(error)}），内容如下：\n${draft}`, "warning");
		}
	}

	// ── 注册 ───────────────────────────────────────────────────
	// /ext-points 与 GUI 落点无关：纯终端、桥未安装、桥被禁用都照常注册。
	pi.registerCommand("ext-points", {
		description: "扩展点面板：浏览 pi/PiDeck 全部可挂载点，勾选并生成开发草稿",
		handler: async (_args, ctx) => {
			try {
				await openPanel(ctx);
			} catch (error) {
				log(`/ext-points 抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	// 桥按 -e 排在用户扩展之后加载：session_start 里我们先跑、ctx.ui.gui 还没挂 ——
	// 因此保存 ctx 并排一次 setTimeout(0)（emit 串行完成后必成，见 scheduleRetry 注释）。
	pi.on("session_start", (_event, ctx) => {
		try {
			mount(ctx);
		} catch (error) {
			log(`挂载失败（已吞，pi 不受影响）: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// agent_start 兜底（此时桥的 session_start 已跑完，ctx.ui.gui 必可用；/reload 等路径也覆盖）：
	// ctx 换新，重新走一遍（幂等）。
	pi.on("agent_start", (_event, ctx) => {
		try {
			mount(ctx);
		} catch {
			// 静默
		}
	});

	// 会话结束：清 timer + ctx，撤回落点贡献，并解除挂载态（成对清理，见文件头「生命周期配对」）。
	// mounted 必须复位：否则下一个会话的 session_start 会被 `if (mounted) return true` 短路，
	// 贡献虽在同一桥实例里仍在，但「本会话已挂」的状态是假的；复位后新会话重新走一次
	// mount（同 key 覆盖 = 刷新，幂等），清单也顺便跟着新会话的桥重读一次。
	pi.on("session_shutdown", (_event, ctx) => {
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		retryScheduled = false;
		retractSection(ctx ?? pendingCtx);
		pendingCtx = null;
		mounted = false;
	});

	log("已注册：/ext-points 命令 + GUI 落点挂载器（setConfigPage 优先，退 setSettingsSection）");
}

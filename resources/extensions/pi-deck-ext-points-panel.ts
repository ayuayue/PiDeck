/**
 * pi-deck-ext-points —— 面板层：GUI 贡献树（静态清单）+ 草稿生成。
 *
 * **渲染纪律（由桥的实测机制倒推，不是风格偏好）**：
 *
 * 1. 贡献树里**只放展示类节点**。桥的事件回灌只认两条链 ——
 *    `invokeAction`（registerAction 注册表，仅桥自己的 toast/confirm 用）与
 *    `componentOf(nodeId)`（pi-tui 组件回放）—— 落点贡献的 `GuiComponent.handleAction`
 *    **没有任何调用点**，扩展也拿不到桥实例的 `registerAction`。
 *    所以树里的 button/checkbox 画得出来、点了没反应 —— 干脆不放。
 * 2. 交互全部走 **`ctx.ui.*` 透传对话框**（select/input/confirm/notify ——
 *    PiDeck 有原生卡片，Promise 可靠 resolve）与 **`pi.registerCommand`**（/ext-points）。
 * 3. 树是**声明式**的：状态一变就整树重设（入口同 key 覆盖贡献），
 *    桥按哈希去重后推送。不追求增量更新。
 *
 * 节点规范（桥 `isValidGuiNode` + `NodeBase`）：
 * - **每个节点必须带 `id`**（string）；
 * - 布局用 `stack { direction }` —— 渲染层把无 `direction` 的 hstack 画成竖排，不用 hstack；
 * - 文本着色用 `style: ["muted"]`（`tone` 只在 badge/icon/banner 上存在）。
 */

import type { Catalog, ExtPoint } from "./pi-deck-ext-points-catalog";

/** 桥渲染层接受的声明式节点（宽松形态：桥侧另有校验，不合法的贡献只会被隐藏）。 */
export type SectionNode = {
	kind: string;
	id: string;
	children?: SectionNode[];
	[key: string]: unknown;
};

const GROUP_TITLE: Record<ExtPoint["group"], string> = { ui: "pi 原生 UI 扩展点", event: "pi 扩展事件", gui: "PiDeck 专属落点" };
const STATUS_LABEL: Record<string, string> = { wired: "已桥接", passthrough: "走原路", "not-bridged": "GUI 里没反应" };
/** badge tone：渲染层只有 danger 有特殊配色，其余都渲染成灰徽章；红色留给真正的警示。 */
const STATUS_TONE: Record<string, string> = { wired: "success", passthrough: "muted", "not-bridged": "danger" };

function text(id: string, content: string, style?: string[]): SectionNode {
	return style?.length ? { kind: "text", id, text: content, style } : { kind: "text", id, text: content };
}

/** 某点在勾选态下的附注行（用途 / 状态说明）。 */
function pointNotes(point: ExtPoint, purpose: string | undefined, seq: number): SectionNode[] {
	const notes: SectionNode[] = [];
	if (point.note) notes.push(text(`note-${seq}`, `　${point.note}`, ["muted"]));
	if (purpose) notes.push(text(`purpose-${seq}`, `　主要用来：${purpose}`, ["accent"]));
	return notes;
}

/**
 * GUI 贡献树：静态全量清单（**零交互依赖** —— 每个节点都是展示类）。
 *
 * 结构：标题行 → 数据来源行（含降级/未登记警示）→ 三组清单 → 操作指引。
 * 「展开/收起」不再需要：这棵树本身就是清单，完整交互在 /ext-points 里。
 *
 * **同一棵树用于两条落点路径**：桥 ≥ 1.3 走 `setConfigPage`（PiDeck「Pi 管理 →
 * Agent 能力 → 扩展点」一级页），老桥走 `setSettingsSection`（设置弹窗底部一块）。
 * 所以文案只能说「本页」，不能说「设置里的某个区块」。
 */
export function renderSection(catalog: Catalog, selected: ReadonlySet<string>, purposes: ReadonlyMap<string, string>): SectionNode {
	const children: SectionNode[] = [];
	let seq = 0;

	// 标题行：名称 + 已选计数
	children.push({
		kind: "stack",
		id: "head",
		direction: "row",
		gap: 2,
		align: "center",
		children: [
			text("head-title", "扩展点"),
			text("head-count", `已勾选 ${selected.size} / ${catalog.points.length}`, ["muted"]),
		],
	});

	// 数据来源与警示（静态可信度说明）
	const sourceNote = catalog.typesPath
		? `pi ${catalog.piVersion ?? "?"} · ${catalog.guiSource} · 均为运行时读取，无构建期快照`
		: `读不到 pi 类型定义，仅列出 PiDeck 专属落点（pi 升级后重开会话即可恢复）`;
	children.push(text("source", sourceNote, ["muted"]));
	if (catalog.guiUnknown.length > 0) {
		children.push({ kind: "banner", id: "unknown-warn", message: `桥提供了本扩展未登记的新落点：${catalog.guiUnknown.join("、")}（已照列，说明待补充）`, tone: "warning" });
	}

	// 三组清单（空组不渲染）
	for (const group of ["ui", "event", "gui"] as const) {
		const points = catalog.points.filter((p) => p.group === group);
		if (points.length === 0) continue;
		children.push({ kind: "divider", id: `div-${group}`, label: `${GROUP_TITLE[group]}（${points.length}）` });
		for (const point of points) {
			seq += 1;
			const row: SectionNode[] = [
				text(`name-${seq}`, `${selected.has(point.id) ? "☑" : "☐"} ${point.label}`),
			];
			if (point.status) row.push({ kind: "badge", id: `badge-${seq}`, label: STATUS_LABEL[point.status] ?? point.status, tone: STATUS_TONE[point.status] ?? "muted" });
			children.push({ kind: "stack", id: `row-${seq}`, direction: "row", gap: 2, align: "center", children: row });
			children.push(...pointNotes(point, purposes.get(point.id), seq));
		}
	}

	// 操作指引（这棵展示树里没有可点的东西，交互入口只能在这里说明）
	children.push({ kind: "divider", id: "div-cta" });
	children.push(text("cta", "本页是静态清单，勾不了。勾选、写用途、生成草稿：在输入框执行 /ext-points。", ["muted"]));

	return { kind: "card", id: "ext-points-section", title: "扩展点", children };
}

// ── 草稿生成 ────────────────────────────────────────────────────

/** 勾选顺序 = 草稿编号顺序（不是清单顺序）。 */
export function buildDraft(selectedIds: readonly string[], purposes: ReadonlyMap<string, string>, name: string, catalog: Catalog): string {
	const byId = new Map(catalog.points.map((p) => [p.id, p]));
	const lines: string[] = [];
	lines.push(`扩展名称和大概功能：${name.trim() || "（未命名，请先问我）"}`);
	lines.push("");
	lines.push("本次扩展需要依赖的扩展点：");
	let index = 0;
	for (const id of selectedIds) {
		const point = byId.get(id);
		if (!point) continue; // 已下线的点跳过，不渲染成 undefined
		index += 1;
		lines.push(`${index}. ${point.label}`);
		if (point.signature) lines.push(`   - 签名：${point.signature}`);
		if (point.note) lines.push(`   - 说明：${point.note}`);
		lines.push(`   - 主要用来：${purposes.get(id)?.trim() || "（未填写，请先问我这块具体想做什么）"}`);
	}
	if (index === 0) lines.push("（还没勾选任何扩展点）");
	lines.push("");
	lines.push("约束提示：这些只是我的初步构想，如果你开发过程中有依赖需要增删，可以先询问。");
	lines.push("");
	lines.push("## 参考文档");
	lines.push("- 桥的落点白名单与契约：resources/extensions/pi-deck-gui-bridge-gui-spec.ts 的 GUI_SLOT_METHODS（本扩展清单与它同源）");
	lines.push("- 桥的 README 与 docs/gui-extension-bridge.md（ctx.ui / ctx.gui 完整 API、移植指南与不映射点）");
	return lines.join("\n");
}

/** 供测试直接调用（不经 pi 运行时）。 */
export const __test__ = { renderSection, buildDraft };

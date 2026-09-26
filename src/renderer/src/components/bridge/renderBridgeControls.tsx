/**
 * GUI 扩展桥 —— 交互 / 数据 / 反馈类控件的渲染（§7.3 控件库）。
 *
 * 与 `renderBridgeNode.tsx` 的分工：那边是布局与基础展示，这里是
 * 需要「把用户操作变成事件上报」的那些 kind。
 *
 * **事件只往上报，不自己改状态**（§8.1 纪律 3）：
 * 点击/输入只调 `onEvent(nodeId, event)`，真正的状态在 pi 进程里的扩展组件中，
 * 回灌后再推新树过来。
 *
 * **例外：`local: true` 的控件**（词汇表 v1.1.1）——这类控件由渲染器先本地回显再上报。
 * 否则受控控件的每次输入都要等一次 pi 往返：打字会丢字、点击要等半秒才有反馈。
 * 本地值只在「远端值不是我们刚上报的那个」时才被远端覆盖（见 `LocalValue`）。
 *
 * **回调不序列化**（§14.14）：节点树里只有 `actionId`，真实回调留在 pi 进程。
 */

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Input } from "../ui-shadcn/input";
import { Progress } from "../ui-shadcn/progress";
import { Switch } from "../ui-shadcn/switch";
import { Textarea } from "../ui-shadcn/textarea";
import type { BridgeUINode } from "../../../../shared/types/bridge";
import { renderBridgeNode, type BridgeEventSink } from "./renderBridgeNode";
import { t } from "../../i18n";

/** 非本地态控件用的空 setter（保持「只上报、不动本地值」的原语义）。 */
const noopSet = (): void => {};

/**
 * 本地态容器（词汇表 v1.1.1）：`local: true` 的控件由**渲染器**持有显示值。
 *
 * 用 render prop 而不是包一层 DOM —— 非本地态路径完全不走它，控件结构不变。
 *
 * 与远端的关系（这里是最容易出错的地方）：
 * - 本地生效后立即上报，扩展回灌的同值不算「远端改动」（否则打字时光标会跳）；
 * - 远端值**确实变了**（扩展改了它 / 拒绝了我们的值）→ 以远端为准，本地让位。
 * - 靠 `renderChildren` 的稳定 key 活过扩展的整树重推。
 */
function LocalValue<T>({ remote, children }: { remote: T; children: (value: T, setValue: (next: T) => void) => ReactNode }): ReactNode {
	const [value, setValue] = useState<T>(remote);
	const lastRemote = useRef<T>(remote);
	const lastSent = useRef<T>(remote);
	if (!Object.is(lastRemote.current, remote)) {
		lastRemote.current = remote;
		if (!Object.is(lastSent.current, remote) && !Object.is(value, remote)) setValue(remote);
	}
	return children(value, (next: T) => {
		lastSent.current = next;
		setValue(next);
	}) as ReactNode;
}

/**
 * 渲染交互/数据/反馈类控件。
 *
 * 认不出的 kind 返回 null（调用方已按「未知即降级」处理过 `ansi`，
 * 能走到这里的未知 kind 说明桥版本比宿主新 → 静默忽略，不崩）。
 */
export function renderBridgeControl(node: BridgeUINode, onEvent: BridgeEventSink, key: string): ReactNode {
	switch (node.kind) {
		// ── 交互 ────────────────────────────────────────────────
		case "button":
			return (
				<Button
					key={key}
					type="button"
					size="sm"
					variant={node.variant === "outline" ? "outline" : node.variant === "ghost" ? "ghost" : "default"}
					disabled={node.disabled === true}
					// 只上报 actionId；回调在 pi 进程内（§14.14）
					onClick={() => node.actionId && onEvent(node.id, { type: "action", actionId: node.actionId })}
				>
					{node.label ?? ""}
				</Button>
			);

		case "input": {
			const body = (value: string, setValue: (next: string) => void) => (
				<Input
					key={key}
					value={value}
					placeholder={node.placeholder ?? ""}
					className="h-7 text-xs"
					// 默认只上报（pi 侧组件持状态，回灌后推新树）；
					// `local: true` 时先本地回显再上报（否则打字会丢字）。
					onChange={(event) => {
						setValue(event.target.value);
						onEvent(node.id, { type: "input", value: event.target.value });
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") onEvent(node.id, { type: "key", key: "enter" });
					}}
				/>
			);
			return node.local === true ? (
				<LocalValue key={key} remote={node.value ?? ""}>
					{body}
				</LocalValue>
			) : (
				body(node.value ?? "", noopSet)
			);
		}

		case "textarea": {
			const body = (value: string, setValue: (next: string) => void) => (
				<Textarea
					key={key}
					value={value}
					placeholder={node.placeholder ?? ""}
					rows={Math.max(2, Math.min(node.rows ?? 3, 12))}
					className="text-xs"
					onChange={(event) => {
						setValue(event.target.value);
						onEvent(node.id, { type: "input", value: event.target.value });
					}}
				/>
			);
			return node.local === true ? (
				<LocalValue key={key} remote={node.value ?? ""}>
					{body}
				</LocalValue>
			) : (
				body(node.value ?? "", noopSet)
			);
		}

		case "selectinput": {
			// 用原生 select 会违反「不裸写 <select>」；这里用 shadcn 的语义等价物需要 Radix，
			// 而桥的场景是「扩展给一组选项」——渲染成按钮组更贴近 GUI 原生且无额外依赖。
			const body = (selected: string, setSelected: (next: string) => void) => (
				<div key={key} className="flex flex-wrap gap-1">
					{(node.options ?? []).map((option, index) => (
						<Button
							key={`${key}-${index}`}
							type="button"
							size="sm"
							variant={option.value === selected ? "default" : "outline"}
							className="h-6 px-2 text-[11px]"
							onClick={() => {
								setSelected(option.value);
								onEvent(node.id, { type: "select", index });
							}}
						>
							{option.label}
						</Button>
					))}
				</div>
			);
			return node.local === true ? (
				<LocalValue key={key} remote={node.value ?? ""}>
					{body}
				</LocalValue>
			) : (
				body(node.value ?? "", noopSet)
			);
		}

		case "checkbox": {
			const local = node.local === true;
			const body = (checked: boolean, setChecked: (next: boolean) => void) => (
				<label key={key} className="flex items-center gap-2 text-xs">
					<Checkbox
						checked={checked}
						onCheckedChange={(next) => {
							const value = next === true;
							setChecked(value);
							// 非本地态保持原事件形状（不带 payload）；本地态才把新值一并报上去
							if (node.actionId) onEvent(node.id, { type: "action", actionId: node.actionId, ...(local ? { payload: value } : {}) });
						}}
					/>
					<span>{node.label ?? ""}</span>
				</label>
			);
			return local ? (
				<LocalValue key={key} remote={node.checked === true}>
					{body}
				</LocalValue>
			) : (
				body(node.checked === true, noopSet)
			);
		}

		case "switch": {
			const local = node.local === true;
			const body = (checked: boolean, setChecked: (next: boolean) => void) => (
				<label key={key} className="flex items-center gap-2 text-xs">
					<Switch
						checked={checked}
						onCheckedChange={(next) => {
							const value = next === true;
							setChecked(value);
							if (node.actionId) onEvent(node.id, { type: "action", actionId: node.actionId, ...(local ? { payload: value } : {}) });
						}}
					/>
					<span>{node.label ?? ""}</span>
				</label>
			);
			return local ? (
				<LocalValue key={key} remote={node.checked === true}>
					{body}
				</LocalValue>
			) : (
				body(node.checked === true, noopSet)
			);
		}

		case "slider": {
			// 桥的 slider 语义是「离散值 + 上报」；用 range 输入而不是引入 Radix Slider
			// （Radix Slider 会带来键盘/指针一整套行为，桥只需要值语义）。
			const body = (value: number, setValue: (next: number) => void) => (
				<div key={key} className="flex items-center gap-2 text-xs">
					{node.label ? <span className="text-muted-foreground shrink-0">{node.label}</span> : null}
					<input
						type="range"
						className="flex-1"
						min={node.min ?? 0}
						max={node.max ?? 100}
						step={node.step ?? 1}
						value={value}
						onChange={(event) => {
							const next = Number(event.target.value);
							setValue(next);
							if (node.actionId) onEvent(node.id, { type: "action", actionId: node.actionId, payload: next });
						}}
					/>
					<span className="font-mono tabular-nums">{value}</span>
				</div>
			);
			// 镜像类型把 value 写成 string（宿主宽松收），但 slider 语义上必须是数字：这里显式收窄
			const remote = typeof node.value === "number" && Number.isFinite(node.value) ? node.value : 0;
			return node.local === true ? (
				<LocalValue key={key} remote={remote}>
					{body}
				</LocalValue>
			) : (
				body(remote, noopSet)
			);
		}

		case "list": {
			// 选择列表：点一项 → select（触发扩展 onSelect），悬浮 → navigate（触发 onSelectionChange）
			const body = (selected: number, setSelected: (next: number) => void) => (
				<div key={key} className="flex flex-col gap-0.5">
					{(node.items ?? []).map((item, index) => (
						<button
							key={`${key}-${index}`}
							type="button"
							className={`flex flex-col items-start rounded-sm px-2 py-1 text-left text-xs ${index === selected ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
							onClick={() => {
								setSelected(index);
								onEvent(node.id, { type: "select", index });
							}}
							onMouseEnter={() => onEvent(node.id, { type: "navigate", index })}
						>
							<span>{item.label}</span>
							{item.description ? <span className="text-[10px] text-muted-foreground">{item.description}</span> : null}
						</button>
					))}
				</div>
			);
			return node.local === true ? (
				<LocalValue key={key} remote={node.selected ?? 0}>
					{body}
				</LocalValue>
			) : (
				body(node.selected ?? 0, noopSet)
			);
		}

		// ── 数据 ────────────────────────────────────────────────
		case "tabs": {
			const tabs = node.tabs ?? [];
			const clamp = (index: number) => Math.max(0, Math.min(index, Math.max(0, tabs.length - 1)));
			const body = (active: number, setActive: (next: number) => void) => (
				<div key={key} className="flex flex-col gap-2">
					<div className="flex flex-wrap gap-1 border-b">
						{tabs.map((tab, index) => (
							<button
								key={`${key}-t-${index}`}
								type="button"
								className={`px-2 py-1 text-[11px] ${index === active ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
								onClick={() => {
									setActive(index);
									if (node.actionId) onEvent(node.id, { type: "action", actionId: node.actionId, payload: index });
								}}
							>
								{tab.label}
							</button>
						))}
					</div>
					{tabs[active] ? renderBridgeNode(tabs[active].content, onEvent, `${key}-content`) : null}
				</div>
			);
			const remote = clamp(node.active ?? 0);
			return node.local === true ? (
				<LocalValue key={key} remote={remote}>
					{body}
				</LocalValue>
			) : (
				body(remote, noopSet)
			);
		}

		case "progress": {
			const max = node.max && node.max > 0 ? node.max : 100;
			const value = typeof node.value === "number" ? Math.max(0, Math.min(node.value, max)) : undefined;
			return (
				<div key={key} className="flex flex-col gap-1">
					{node.label ? <span className="text-[11px] text-muted-foreground">{node.label}</span> : null}
					<Progress value={value === undefined ? undefined : (value / max) * 100} className="h-1.5" />
				</div>
			);
		}

		case "spinner":
			// 加载态：共享的 reduced-motion 感知动画（animate-pideck-spin，见 styles/tailwind.css）
			return (
				<div key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
					<span className="size-3 animate-pideck-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
					{node.label ? <span>{node.label}</span> : null}
				</div>
			);

		case "loader":
			// pi-tui 的 Loader 翻译过来：帧序列取首帧做静态指示（GUI 有自己的动画）
			return (
				<div key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
					<span className="size-3 animate-pideck-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
					{node.label ? <span>{node.label}</span> : null}
					{node.cancellable ? (
						<Badge variant="secondary" className="text-[10px]">
							{t("bridge.control.cancellable")}
						</Badge>
					) : null}
				</div>
			);

		case "settings":
			return (
				<div key={key} className="flex flex-col gap-1">
					{(node.settingsItems ?? []).map((item) => (
						<div key={`${key}-${item.id}`} className="flex items-baseline justify-between gap-2 text-xs">
							<span className="text-muted-foreground">{item.label}</span>
							<span className="font-mono">{item.currentValue}</span>
						</div>
					))}
				</div>
			);

		// ── 反馈 ────────────────────────────────────────────────
		case "banner":
			return (
				<div key={key} className={`rounded-md border px-2 py-1 text-xs ${node.tone === "danger" ? "border-destructive/40 bg-destructive/10 text-destructive" : node.tone === "warning" ? "border-amber-500/40 bg-amber-500/10" : node.tone === "success" ? "border-emerald-500/40 bg-emerald-500/10" : "bg-muted/50"}`}>
					{node.message ?? ""}
				</div>
			);

		case "toast":
			// toast 落点由覆盖层/通知系统承载；内联渲染成一个轻量卡片（不重复弹 toast）
			return (
				<div key={key} className="flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-xs shadow-sm">
					<span className="flex-1">{node.message ?? ""}</span>
					{(node.actions ?? []).map((action, index) => (
						<Button key={`${key}-a-${index}`} type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onEvent(node.id, { type: "action", actionId: action.actionId })}>
							{action.label}
						</Button>
					))}
				</div>
			);

		case "modal":
			// 模态由覆盖层容器渲染（见 BridgeOverlayHost）；这里渲染主体内容
			return (
				<div key={key} className="flex flex-col gap-3">
					{node.title ? <div className="text-sm font-medium">{node.title}</div> : null}
					<div className="flex flex-col gap-2">{(node.children ?? []).map((child, index) => renderBridgeNode(child, onEvent, `${key}-c-${index}`))}</div>
					{node.actions?.length ? (
						<div className="flex justify-end gap-2">
							{node.actions.map((action, index) => (
								<Button
									key={`${key}-a-${index}`}
									type="button"
									size="sm"
									variant="outline"
									// 只上报 actionId；回调在 pi 进程内（§14.14）
									onClick={() => onEvent(node.id, { type: "action", actionId: action.actionId })}
								>
									{action.label}
								</Button>
							))}
						</div>
					) : null}
				</div>
			);

		case "editor": {
			const body = (value: string, setValue: (next: string) => void) => (
				<Textarea
					key={key}
					value={value}
					placeholder={node.placeholder ?? ""}
					rows={4}
					className="text-xs"
					onChange={(event) => {
						setValue(event.target.value);
						onEvent(node.id, { type: "input", value: event.target.value });
					}}
				/>
			);
			return node.local === true ? (
				<LocalValue key={key} remote={node.value ?? ""}>
					{body}
				</LocalValue>
			) : (
				body(node.value ?? "", noopSet)
			);
		}

		default:
			// 桥比宿主新（推了宿主不认识的 kind）→ 静默忽略，不崩、不占位
			return null;
	}
}

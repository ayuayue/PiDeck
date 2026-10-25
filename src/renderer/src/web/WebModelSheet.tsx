/**
 * 单个模型行（摊平渲染，便于窗口切片）。
 */
function ModelRow(props: { item: AvailableModel; active: boolean; onSelect: () => void }) {
	const name = resolveModelDisplayName(props.item.name, props.item.id);
	return (
		<button type="button" className={cn("flex h-12 w-full items-center gap-2 px-4 text-left text-sm transition-colors hover:bg-muted/60 active:bg-muted", props.active ? "text-primary" : "text-foreground")} onClick={props.onSelect}>
			<span className="min-w-0 flex-1 truncate">
				{name}
				<span className="ml-1.5 text-caption text-muted-foreground">{props.item.id}</span>
			</span>
			{props.active ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
		</button>
	);
}

/**
 * WebModelSelector — 模型选择（Composer 工具行驻留）。
 *
 * 第三批（DeepSeek 式交互）：从 WebHeader 的 PC 式 Command popover 迁到 composer 工具行：
 * - pill 触发器常驻（当前模型名 truncate），与思考 pill 并排
 * - WebBottomSheet：窄屏底部滑出（h-12 大触控行）、宽屏居中卡片
 * - provider 分组列表 + 本地过滤（触屏无 kbd 交互，不用 Command）；刷新绕缓存重拉
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, RefreshCw, Search } from "lucide-react";
import type { AvailableModel, SessionModelPreference } from "../../../shared/types";
import { resolveModelDisplayName } from "../../../shared/modelDisplayName";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebBottomSheet } from "./WebBottomSheet";

/** 弹层行的扁平表示：分组标题与模型行混排，便于按窗口切片渲染。 */
type ModelSheetRow = { kind: "group"; key: string; provider: string } | { kind: "model"; key: string; item: AvailableModel };

/** 首屏渲染的行数（含分组标题）；模型表动辄 300+ 条，一次全渲染会造出上万像素的滚动容器。 */
const MODEL_ROW_WINDOW = 40;
/** 每次增量追加的行数。 */
const MODEL_ROW_STEP = 40;

/** 把分组结果摊平成可切片的单行列表（组序=模型表顺序，组内保持原序）。 */
function flattenModelRows(groups: [string, AvailableModel[]][]): ModelSheetRow[] {
	const rows: ModelSheetRow[] = [];
	for (const [provider, items] of groups) {
		rows.push({ kind: "group", key: `group:${provider}`, provider });
		for (const item of items) rows.push({ kind: "model", key: `${provider}::${item.id}`, item });
	}
	return rows;
}

export function WebModelSelector(props: { model?: SessionModelPreference; models: AvailableModel[]; refreshing?: boolean; onRefresh?: () => void; onChange: (model: AvailableModel) => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [rendered, setRendered] = useState(MODEL_ROW_WINDOW);
	const sentinelRef = useRef<HTMLButtonElement | null>(null);
	const { model, models, onChange } = props;
	const currentValue = model ? `${model.provider}::${model.modelId}` : "";
	const selectedName = model ? resolveModelDisplayName(model.modelName, model.modelId) : undefined;
	// pill 只显示模型名（provider 在弹层行内呈现），窄屏不挤
	const pillLabel = selectedName ?? t("web.model");

	// 弹层打开时按 query 过滤后按 provider 分组（组序=模型表顺序）
	const groups = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		const filtered = keyword ? models.filter((item) => `${item.provider} ${item.name} ${item.id}`.toLowerCase().includes(keyword)) : models;
		const byProvider = new Map<string, AvailableModel[]>();
		for (const item of filtered) {
			const list = byProvider.get(item.provider);
			if (list) list.push(item);
			else byProvider.set(item.provider, [item]);
		}
		return [...byProvider.entries()];
	}, [models, query]);

	const rows = useMemo(() => flattenModelRows(groups), [groups]);
	// 搜索词变化回到首屏窗口：结果集变小，保留旧窗口没有意义；弹层重开同样重置。
	useEffect(() => setRendered(MODEL_ROW_WINDOW), [query]);
	const visibleRows = rows.slice(0, Math.min(rendered, rows.length));
	const hiddenCount = rows.length - visibleRows.length;
	// 滚动到哨兵就补一页；哨兵同时是「更多」按钮，IntersectionObserver 不可用时仍可手动加载。
	useEffect(() => {
		if (hiddenCount <= 0) return;
		const sentinel = sentinelRef.current;
		if (!sentinel || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setRendered((current) => Math.min(rows.length, current + MODEL_ROW_STEP));
			},
			{ rootMargin: "200px 0px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hiddenCount, rows.length]);

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				className="h-8 max-w-[30vw] shrink-0 justify-start gap-1 px-1 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:h-9 sm:max-w-[220px]"
				aria-label={t("web.model")}
				title={selectedName ? `${selectedName} · ${model?.provider ?? ""}/${model?.modelId ?? ""}` : t("web.model")}
				onClick={() => {
					setQuery("");
					setRendered(MODEL_ROW_WINDOW);
					setOpen(true);
				}}
			>
				<span className="min-w-0 truncate">{pillLabel}</span>
				<ChevronsUpDown className="size-4 shrink-0" aria-hidden="true" />
			</Button>
			<WebBottomSheet open={open} onOpenChange={setOpen} title={t("web.modelSheetTitle")}>
				<div className="flex flex-col">
					{/* 搜索 + 刷新：sticky 头部，滚动时保持可用 */}
					<div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-card px-3 py-2">
						<div className="relative min-w-0 flex-1">
							<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
							<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("web.modelSearch")} className="h-9 bg-background pl-8 text-sm" aria-label={t("web.modelSearch")} />
						</div>
						{props.onRefresh ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-9"
								aria-label={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
								title={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
								disabled={props.refreshing}
								onClick={() => props.onRefresh?.()}
							>
								<RefreshCw size={14} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
							</Button>
						) : null}
					</div>
					{rows.length === 0 ? <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t("web.modelEmpty")}</div> : null}
					{visibleRows.map((row) =>
						row.kind === "group" ? (
							<div key={row.key} className="px-4 pt-2 pb-1 text-micro font-medium tracking-wide text-muted-foreground uppercase">
								{row.provider}
							</div>
						) : (
							<ModelRow
								key={row.key}
								item={row.item}
								active={`${row.item.provider}::${row.item.id}` === currentValue}
								onSelect={() => {
									onChange(row.item);
									setOpen(false);
								}}
							/>
						),
					)}
					{hiddenCount > 0 ? (
						<button ref={sentinelRef} type="button" className="flex h-10 w-full items-center justify-center text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" onClick={() => setRendered((current) => Math.min(rows.length, current + MODEL_ROW_STEP))}>
							{t("web.moreSessions", { count: hiddenCount })}
						</button>
					) : null}
					<div className="h-[max(env(safe-area-inset-bottom),0.5rem)]" />
				</div>
			</WebBottomSheet>
		</>
	);
}

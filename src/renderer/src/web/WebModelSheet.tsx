/**
 * WebModelSelector — 模型选择（Composer 工具行驻留）。
 *
 * 第三批（DeepSeek 式交互）：从 WebHeader 的 PC 式 Command popover 迁到 composer 工具行：
 * - pill 触发器常驻（当前模型名 truncate），与思考 pill 并排
 * - WebBottomSheet：窄屏底部滑出（h-12 大触控行）、宽屏居中卡片
 * - provider 分组列表 + 本地过滤（触屏无 kbd 交互，不用 Command）；刷新绕缓存重拉
 */
import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, RefreshCw, Search } from "lucide-react";
import type { AvailableModel, SessionModelPreference } from "../../../shared/types";
import { resolveModelDisplayName } from "../../../shared/modelDisplayName";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebBottomSheet } from "./WebBottomSheet";

export function WebModelSelector(props: { model?: SessionModelPreference; models: AvailableModel[]; refreshing?: boolean; onRefresh?: () => void; onChange: (model: AvailableModel) => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
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

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				className="h-8 max-w-[30vw] shrink-0 justify-start gap-1 px-1 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground sm:max-w-[220px]"
				aria-label={t("web.model")}
				title={selectedName ? `${selectedName} · ${model?.provider ?? ""}/${model?.modelId ?? ""}` : t("web.model")}
				onClick={() => {
					setQuery("");
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
								className="shrink-0 text-muted-foreground hover:text-foreground"
								aria-label={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
								title={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
								disabled={props.refreshing}
								onClick={() => props.onRefresh?.()}
							>
								<RefreshCw size={14} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
							</Button>
						) : null}
					</div>
					{groups.length === 0 ? <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t("web.modelEmpty")}</div> : null}
					{groups.map(([provider, items]) => (
						<div key={provider} className="flex flex-col">
							<div className="px-4 pt-2 pb-1 text-micro font-medium tracking-wide text-muted-foreground uppercase">{provider}</div>
							<ul>
								{items.map((item) => {
									const value = `${item.provider}::${item.id}`;
									const name = resolveModelDisplayName(item.name, item.id);
									const active = value === currentValue;
									return (
										<li key={value}>
											<button
												type="button"
												className={cn("flex h-12 w-full items-center gap-2 px-4 text-left text-sm transition-colors hover:bg-muted/60 active:bg-muted", active ? "text-primary" : "text-foreground")}
												onClick={() => {
													onChange(item);
													setOpen(false);
												}}
											>
												<span className="min-w-0 flex-1 truncate">
													{name}
													<span className="ml-1.5 text-caption text-muted-foreground">{item.id}</span>
												</span>
												{active ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
											</button>
										</li>
									);
								})}
							</ul>
						</div>
					))}
					<div className="h-[max(env(safe-area-inset-bottom),0.5rem)]" />
				</div>
			</WebBottomSheet>
		</>
	);
}

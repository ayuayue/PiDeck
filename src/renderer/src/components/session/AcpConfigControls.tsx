import { Lock, SlidersHorizontal } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui-shadcn/select";
import { AcpConfigGlyph } from "./AcpConfigGlyph";
import { AcpModelRateBadge } from "./AcpModelRateBadge";
import { AcpConfigSearchSelect } from "./AcpConfigSearchSelect";
import { resolveAcpConfigSelect, flattenAcpConfigOptions, isRenderableAcpConfigEntry, splitAcpConfigEntries, type AcpConfigEntry } from "./acpConfigSelect";

/**
 * ACP 会话配置选择器组：按 category 渲染 agent 回传的 configOptions——
 * model → 模型下拉、thought_level → 思考下拉、mode/其他 → 通用下拉、boolean → 开关 chip。
 * select 型至少要两个候选（单值项在 agent 侧不可写，留着只是点不动的死 chip）；
 * 分组值(options[].group)平铺渲染。值变化经 onSet 下发,整表由事件/响应回填。
 * 模型列表（以及任何超长枚举）用可搜索下拉，短枚举保持普通 Select。
 *
 * 参数很多时（CodeBuddy 一次回传 6-8 项）只把模型与 mode 留在底栏，其余收进
 * 「参数」菜单：平铺会让底栏被 chip 撑满、每项标签都被压成省略号，反而看不清当前配置。
 *
 * 从 ComposerComponents 拆出：底栏文件已超巨文件硬线，本组控件是独立领域
 * （agent 参数渲染 + 锁定态），拆出后主文件行数只降不升。
 */
export function AcpConfigControls(props: { options: import("../../../../shared/types/acp").AcpSessionConfigOption[]; disabled?: boolean; onSet: (optionId: string, value: string | boolean) => void }) {
	const entries = flattenAcpConfigOptions(props.options).filter(isRenderableAcpConfigEntry);
	if (entries.length === 0) return null;
	const { inline, overflow } = splitAcpConfigEntries(entries);
	return (
		<>
			{inline.map((entry) => (
				<AcpConfigControl key={entry.option.id} entry={entry} disabled={props.disabled} onSet={props.onSet} />
			))}
			{overflow.length > 0 ? <AcpConfigOverflowMenu entries={overflow} disabled={props.disabled} onSet={props.onSet} /> : null}
		</>
	);
}

/** 单个 ACP 配置项控件：boolean → 开关 chip；长枚举 → 可搜索下拉；短枚举 → Select。 */
function AcpConfigControl(props: { entry: AcpConfigEntry; disabled?: boolean; onSet: (optionId: string, value: string | boolean) => void }) {
	const entry = props.entry;
	// 单项锁定（CodeBuddy 的 output_style 等）：agent 已经声明这一项现在改不了，setter 会以
	// invalidParams 拒绝。提前置灰省掉一次注定失败的写入；解锁是运行期事件（下一次
	// config_option_update 不再带原因），所以这里只看当前快照，不做本地记忆。
	const locked = entry.option.lockedReason;
	const disabled = props.disabled === true || locked !== undefined;
	const lockSuffix = locked === undefined ? "" : ` — ${locked}`;
	// boolean 项（multitask / delegate 等）没有枚举值，走独立开关分支；
	// 写入必须带 type，否则 agent 按 string 分支校验会回 -32602。
	if (entry.option.type === "boolean") {
		const on = entry.option.currentValue === true;
		return (
			<button
				type="button"
				aria-pressed={on}
				disabled={disabled}
				onClick={() => props.onSet(entry.option.id, !on)}
				title={`${entry.option.name}: ${on ? t("common.enabled") : t("common.disabled")}${entry.option.description ? ` — ${entry.option.description}` : ""}${lockSuffix}`}
				className={cn("composer-bar-btn backend inline-flex h-7 max-w-56 min-w-0 items-center gap-1 rounded-md border-transparent px-1.5 text-control font-semibold transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50", on ? "bg-muted/60 text-foreground" : "text-muted-foreground")}
			>
				<AcpConfigGlyph option={entry.option} />
				<span className="truncate text-xs">{entry.option.name}</span>
				{locked === undefined ? null : <Lock size={12} strokeWidth={1.8} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
			</button>
		);
	}
	// currentValue 可能不在 agent 的枚举里（完整模型 id vs 别名）：补一条当前项，保证高亮/滚动指向真实值。
	const select = resolveAcpConfigSelect(entry.option, entry.values);
	// 当前项的 description 也进悬停提示：列表里的倍率/说明在收起态也要能查到。
	const currentValue = select.values.find((value) => value.value === select.value);
	// 模型列表按 agent 不同可达几十项：换可搜索下拉，避免平铺滚动找模型。
	// 模式/思考档等短枚举仍用 Select（选项少时搜索框只是噪音）。
	if (entry.option.category === "model" || entry.values.length > 10) {
		return <AcpConfigSearchSelect option={entry.option} select={select} disabled={disabled} onPick={(value) => props.onSet(entry.option.id, value)} />;
	}
	return (
		// 再点选当前项等价于「保持不变」，不发 IPC。
		<Select value={select.value} disabled={disabled} onValueChange={(value) => (value === select.value ? undefined : props.onSet(entry.option.id, value))}>
			<SelectTrigger
				size="sm"
				className="composer-bar-btn backend h-7 gap-1 rounded-md border-transparent bg-transparent px-1.5 text-control font-semibold text-foreground hover:bg-muted/60 focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:border-transparent data-[state=open]:bg-muted/60 data-[state=open]:ring-0 max-w-56 [&_[data-slot='select-icon']]:hidden"
				// 悬停必须能看到实际生效值：只给选项名+描述时，长模型名被截断后无从确认。
				title={`${entry.option.name}: ${select.label}${currentValue?.description ? ` — ${currentValue.description}` : ""}${entry.option.description ? ` — ${entry.option.description}` : ""}${lockSuffix}`}
			>
				<AcpConfigGlyph option={entry.option} />
				<span className="truncate text-xs">{select.label}</span>
				{locked === undefined ? null : <Lock size={12} strokeWidth={1.8} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
			</SelectTrigger>
			<SelectContent align="start" className="max-h-72">
				{select.values.map((value) => (
					<SelectItem key={value.value} value={value.value}>
						<span className="flex min-w-0 flex-1 items-center gap-2">
							<span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
								<span className="truncate">{value.name}</span>
								{value.description ? <span className="truncate text-micro text-muted-foreground">{value.description}</span> : null}
							</span>
							<AcpModelRateBadge rate={value.rate} />
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * ACP 参数折叠菜单：底栏只留模型与 mode（没有模型则留第一项），其余收进「参数」下拉。
 * 用 DropdownMenu 的 Sub 而不是把 Select 塞进 Popover：Radix Select 的 portal
 * 内容会被 Popover 当成 outside 点击，一选就关；Sub 与主菜单同属一棵菜单树，稳定。
 */
function AcpConfigOverflowMenu(props: { entries: AcpConfigEntry[]; disabled?: boolean; onSet: (optionId: string, value: string | boolean) => void }) {
	if (props.entries.length === 0) return null;
	const title = t("app.acpConfigMoreTitle");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={props.disabled}
					aria-label={`${title} (${props.entries.length})`}
					title={`${title} (${props.entries.length})`}
					className="composer-bar-btn backend inline-flex h-7 shrink-0 items-center gap-1 rounded-md border-transparent px-1.5 text-control font-semibold text-muted-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-muted/60 data-[state=open]:text-foreground"
				>
					<SlidersHorizontal size={15} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
					<span className="text-xs">{t("app.acpConfigMore")}</span>
					<span className="rounded-sm bg-muted px-1 text-micro tabular-nums leading-4 text-muted-foreground">{props.entries.length}</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="top" sideOffset={6} className="min-w-56 max-w-[min(320px,calc(100vw-24px))]">
				<DropdownMenuLabel>{title}</DropdownMenuLabel>
				{props.entries.map((entry) => {
					const locked = entry.option.lockedReason;
					const disabled = props.disabled === true || locked !== undefined;
					if (entry.option.type === "boolean") {
						const on = entry.option.currentValue === true;
						return (
							<DropdownMenuCheckboxItem
								key={entry.option.id}
								checked={on}
								disabled={disabled}
								onCheckedChange={() => props.onSet(entry.option.id, !on)}
								// 开关类参数常需要连续调多个：选中后别把菜单关掉。
								onSelect={(event) => event.preventDefault()}
								title={locked ?? entry.option.description}
							>
								<AcpConfigGlyph option={entry.option} className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{entry.option.name}</span>
								<span className="shrink-0 text-micro text-muted-foreground">{on ? t("common.enabled") : t("common.disabled")}</span>
								{locked === undefined ? null : <Lock size={12} strokeWidth={1.8} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
							</DropdownMenuCheckboxItem>
						);
					}
					const select = resolveAcpConfigSelect(entry.option, entry.values);
					const currentValue = select.values.find((value) => value.value === select.value);
					return (
						<DropdownMenuSub key={entry.option.id}>
							<DropdownMenuSubTrigger disabled={disabled} title={`${entry.option.name}: ${select.label}${currentValue?.description ? ` — ${currentValue.description}` : ""}${entry.option.description ? ` — ${entry.option.description}` : ""}${locked === undefined ? "" : ` — ${locked}`}`}>
								<AcpConfigGlyph option={entry.option} className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{entry.option.name}</span>
								<span className="max-w-[8rem] shrink-0 truncate text-micro font-normal text-muted-foreground">{select.label}</span>
								{locked === undefined ? null : <Lock size={12} strokeWidth={1.8} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="min-w-56">
								{/* scroll-ok: transient —— 下拉子菜单短列表（配置项有限），max-h-72 封顶，菜单关闭即销毁，无需虚拟化 */}
								<div className="max-h-72 overflow-y-auto">
									<DropdownMenuRadioGroup
										value={select.value}
										onValueChange={(value) => {
											if (value !== select.value) props.onSet(entry.option.id, value);
										}}
									>
										{select.values.map((value) => (
											<DropdownMenuRadioItem key={value.value} value={value.value} title={value.description}>
												<span className="flex min-w-0 flex-1 flex-col">
													<span className="truncate">{value.name}</span>
													{value.description ? <span className="truncate text-micro text-muted-foreground">{value.description}</span> : null}
												</span>
												<AcpModelRateBadge rate={value.rate} />
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</div>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

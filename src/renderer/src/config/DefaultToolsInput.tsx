/**
 * 「默认工具」多选输入（defaultTools 单一字段）。
 * chips 触发器 + 分组平铺下拉（工具总数 ≤10，无需搜索），范式复用 SettingsTab 的 EnabledModelsInput。
 *
 * 编码统一走 `setToolEnabled`：它用与 pi 相同的合并/解析逻辑回验候选值，
 * 避免「显式空列表后只开一个工具」被写成 modifier-only 而意外带回默认工具。
 * `baseValue` 供项目资源页传入全局原始数组，使回验与项目实际解析一致。
 */

import { useState } from "react";
import { Check, X } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui-shadcn/popover";
import { Command, CommandGroup, CommandItem, CommandList } from "../components/ui-shadcn/command";
import { TOOL_CATALOG, isToolEnabledInLayer, resolveDefaultToolsInLayer, setToolEnabled } from "../../../shared/defaultTools";

export function DefaultToolsInput(props: {
	value?: string[];
	/** 下层原始值（项目资源页传全局 defaultTools），用于按 pi 的实际跨层合并语义回验。 */
	baseValue?: readonly string[];
	onChange: (value: string[] | undefined) => void;
}) {
	const [open, setOpen] = useState(false);
	const entries = props.value;
	const base = props.baseValue;
	const effective = resolveDefaultToolsInLayer(base, entries);
	const isCustom = entries !== undefined;
	/** 本层增量条目（chips 以描边区分 +codemode/−bash 语义）。 */
	const incrementalNames = new Set((entries ?? []).filter((entry) => entry.startsWith("+")).map((entry) => entry.slice(1)));
	const removedNames = new Set((entries ?? []).filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1)));

	const groups: Array<{ key: "builtin" | "extension"; label: string }> = [
		{ key: "builtin", label: t("config.tools.group.builtin") },
		{ key: "extension", label: t("config.tools.group.extension") },
	];

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
			}}
		>
			<PopoverTrigger asChild>
				<div className="flex min-h-[38px] w-full min-w-0 cursor-pointer flex-wrap items-center gap-1.5 rounded-sm border border-border-subtle bg-popover px-2.5 py-[5px] transition-colors duration-fast hover:border-border-strong">
					{effective.length === 0 ? (
						<span className="text-xs leading-[18px] text-danger">{t("config.tools.allDisabled")}</span>
					) : (
						effective.map((name) => {
							const incremental = incrementalNames.has(name);
							return (
								<span
									key={name}
									className={`inline-flex h-6 items-center rounded-full border pl-[9px] pr-[5px] font-mono text-xs leading-[18px] whitespace-nowrap text-text-primary ${incremental ? "border-[color-mix(in_srgb,var(--color-accent)_40%,var(--color-border-subtle))] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg-panel))]" : "border-border-subtle bg-bg-hover"}`}
								>
									<span>{name}</span>
									{isCustom ? (
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											className="rounded-full border-0 bg-transparent text-text-tertiary hover:bg-[color:color-mix(in_srgb,var(--color-danger)_16%,transparent)] hover:text-[color:var(--color-danger)]"
											onClick={(e) => {
												e.stopPropagation();
												props.onChange(setToolEnabled({ baseEntries: base, entries, name, on: false }));
											}}
										>
											<X size={12} />
										</Button>
									) : null}
								</span>
							);
						})
					)}
					<span className="text-xs leading-[18px] text-text-tertiary">{isCustom ? `${effective.length} ${t("config.tools.enabledCount")}` : t("config.tools.usingDefault")}</span>
				</div>
			</PopoverTrigger>
			<PopoverContent align="start" sideOffset={4} className="w-[var(--radix-popover-trigger-width)] max-w-[min(520px,calc(100vw-48px))] p-0">
				<Command shouldFilter={false}>
					<CommandList className="max-h-[min(360px,50vh)]">
						<div className="flex items-center gap-1.5 border-b border-border-subtle px-2 py-1.5">
							<Button variant="outline" size="xs" onClick={() => props.onChange(undefined)} title={t("config.tools.resetHint")}>
								{t("config.tools.reset")}
							</Button>
							<Button variant="ghost" size="xs" onClick={() => props.onChange([])} title={t("config.tools.disableAllHint")}>
								{t("config.tools.disableAll")}
							</Button>
						</div>
						{groups.map((group) => (
							<CommandGroup key={group.key} heading={<span className="px-3 text-micro text-muted-foreground">{group.label}</span>}>
								{TOOL_CATALOG.filter((tool) => tool.group === group.key).map((tool) => {
									const enabled = isToolEnabledInLayer(base, entries, tool.name);
									const removed = removedNames.has(tool.name);
									return (
										<CommandItem
											key={tool.name}
											value={tool.name}
											onSelect={() => props.onChange(setToolEnabled({ baseEntries: base, entries, name: tool.name, on: !enabled }))}
											className={`cursor-pointer gap-2 py-[7px] pr-3 pl-7 text-control text-text-primary ${enabled ? "bg-[color:color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg-panel))]" : ""}`}
										>
											<span
												className={`flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border-[1.5px] transition-[border-color,background-color] duration-fast${enabled ? " border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]" : " border-border-strong text-[color:var(--color-accent)]"}`}
											>
												{enabled && <Check size={12} />}
											</span>
											<span className="font-mono text-control text-text-primary">{tool.name}</span>
											{removed ? <span className="ml-auto font-mono text-micro text-text-tertiary">−{tool.name}</span> : null}
										</CommandItem>
									);
								})}
							</CommandGroup>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

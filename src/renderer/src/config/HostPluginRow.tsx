/**
 * 插件列表的单行呈现：身份 + 紧凑能力标签，完整的网络目的地/风险说明仍留在授权弹窗里。
 * 单独成文件是为了让设置页只负责工具栏与对话框，行内结构（含拆分按钮）可独立演进。
 */
import { ChevronDown, PanelTop, Power, PowerOff, Puzzle, Trash2 } from "lucide-react";
import type { HostPluginInfo } from "../../../shared/types/hostPlugin";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { ButtonGroup } from "../components/ui-shadcn/button-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui-shadcn/dropdown-menu";
import { HOST_PLUGIN_PERMISSION_CHIP_KEYS } from "./HostPluginPermissionDetails";
import { t } from "../i18n";

export type HostPluginRowProps = {
	plugin: HostPluginInfo;
	busy: boolean;
	/** 已启用 → 直接禁用；未启用 → 打开授权弹窗（禁用是可逆操作，不需要二次确认）。 */
	onToggle: (plugin: HostPluginInfo) => void;
	onRemove: (plugin: HostPluginInfo) => void;
	onOpenPanel: (pluginId: string, panelId: string) => void;
};

/** 状态点用语义色 token：启用绿、内容变更待授权黄、未启用灰。 */
function statusTone(plugin: HostPluginInfo): { dot: string; label: string } {
	if (plugin.enabled) return { dot: "bg-success", label: t("hostPlugins.enabled") };
	if (plugin.requiresConsent) return { dot: "bg-warning", label: t("hostPlugins.changed") };
	return { dot: "bg-border-strong", label: t("hostPlugins.disabled") };
}

export function HostPluginRow({ plugin, busy, onToggle, onRemove, onOpenPanel }: HostPluginRowProps) {
	const { manifest } = plugin;
	const status = statusTone(plugin);
	const panels = plugin.enabled ? manifest.contributes.panels : [];
	return (
		<div className="flex items-start gap-3 rounded-lg border border-border-subtle bg-card px-3.5 py-3 transition-colors hover:border-border hover:bg-muted/30">
			<div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-muted text-muted-foreground">
				<Puzzle size={16} aria-hidden="true" />
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="truncate text-sm font-medium text-foreground">{manifest.name}</span>
					<span className="font-mono text-micro text-muted-foreground">
						{manifest.id} · v{manifest.version}
					</span>
					<Badge variant="outline" className="gap-1 py-0 text-micro font-normal text-muted-foreground">
						<span className={`size-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
						{status.label}
					</Badge>
				</div>
				{manifest.description && (
					<p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={manifest.description}>
						{manifest.description}
					</p>
				)}
				{/* 只列能力名，不展开每一项目的地：同意前必须看清的地址、端口与风险提示都在授权弹窗里。 */}
				<div className="flex flex-wrap items-center gap-1">
					{manifest.permissions.map((permission) => (
						<Badge key={permission} variant="secondary" className="px-1.5 py-0 text-micro font-normal text-muted-foreground">
							{t(HOST_PLUGIN_PERMISSION_CHIP_KEYS[permission])}
						</Badge>
					))}
					{!manifest.permissions.includes("sessions.read") && (
						<Badge variant="secondary" className="px-1.5 py-0 text-micro font-normal text-muted-foreground">
							{t("hostPlugins.chipNoSessionsRead")}
						</Badge>
					)}
				</div>
			</div>
			{/* 拆分按钮：主钮直接露出唯一高频且可逆的动作（启用/禁用），不可逆的卸载与面板入口收进右侧下拉。 */}
			<ButtonGroup className="shrink-0">
				<Button variant="outline" size="sm" disabled={busy} onClick={() => onToggle(plugin)}>
					{plugin.enabled ? <PowerOff data-icon="inline-start" /> : <Power data-icon="inline-start" />}
					{t(plugin.enabled ? "hostPlugins.disable" : "hostPlugins.enableShort")}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						{/* 高度必须与主钮的 sm(h-8) 对齐：icon-sm 是 size-7（28px），ButtonGroup 的 items-stretch 压不过显式高度，
						    不覆盖会顶端对齐、右侧下拉段矮一截（拆分按钮也就断了）。 */}
						<Button variant="outline" size="icon-sm" className="h-8 w-7" disabled={busy} aria-label={t("hostPlugins.moreActions")} title={t("hostPlugins.moreActions")}>
							<ChevronDown size={14} aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-[10rem]">
						{panels.length > 0 && (
							<>
								<DropdownMenuLabel>{t("hostPlugins.panels")}</DropdownMenuLabel>
								{panels.map((panel) => (
									<DropdownMenuItem key={panel.id} onClick={() => onOpenPanel(manifest.id, panel.id)}>
										<PanelTop size={14} aria-hidden="true" />
										{panel.title}
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
							</>
						)}
						<DropdownMenuItem variant="destructive" onClick={() => onRemove(plugin)}>
							<Trash2 size={14} aria-hidden="true" />
							{t("hostPlugins.remove")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</ButtonGroup>
		</div>
	);
}

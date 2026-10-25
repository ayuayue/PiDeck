/** Explicit local MCP consent and connection handoff, separate from ordinary remote templates. */
import { useId, useState } from "react";
import { Copy, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Label } from "../components/ui-shadcn/label";
import { desktopApi } from "../desktopApi";
import { usePiDeckMcp } from "../hooks/usePiDeckMcp";
import { t } from "../i18n";
import type { McpServerDefinition } from "../../../shared/types/mcp";

export function PiDeckMcpPanel({ existingNames, disabled, onAdd }: { existingNames: ReadonlySet<string>; disabled: boolean; onAdd: (definition: McpServerDefinition) => Promise<boolean> }) {
	const host = usePiDeckMcp();
	const prefix = useId();
	const [copied, setCopied] = useState(false);
	const busy = disabled || host.busy;
	const changed =
		host.state &&
		(host.projectIds.length !== host.state.projectIds.length ||
			host.projectIds.some((id) => !host.state?.projectIds.includes(id)) ||
			host.allProjects !== host.state.allProjects ||
			host.allowControl !== host.state.allowControl ||
			host.allowAgentWrite !== (host.state.allowAgentWrite ?? false) ||
			host.allowAutomationWrite !== (host.state.allowAutomationWrite ?? false) ||
			host.allowFavoritesWrite !== (host.state.allowFavoritesWrite ?? false));
	// 「全选」只覆盖当前项目列表；要跟随今后新建的项目得用通配授权，而不是逐个勾。
	const projectCount = host.state?.projects.length ?? 0;
	const allSelected = projectCount > 0 && host.projectIds.length === projectCount;
	return (
		<section className="flex flex-col gap-3" aria-labelledby={`${prefix}-title`}>
			<div className="flex items-center gap-2">
				<ShieldCheck size={18} aria-hidden="true" />
				<h3 id={`${prefix}-title`} className="flex-1 font-medium">
					{t("config.mcp.catalog.pideck")}
				</h3>
				<Button variant="ghost" size="icon-sm" disabled={busy} title={t("common.refresh")} onClick={() => void host.refresh()}>
					<RefreshCw aria-hidden="true" />
				</Button>
			</div>
			<p className="text-control text-muted-foreground">{t("config.mcp.pideck.hint")}</p>
			<p className="text-micro text-muted-foreground">{t("config.mcp.pideck.warning")}</p>
			<p role="status" className="text-control">
				{t(host.state?.running ? "config.mcp.pideck.running" : "config.mcp.pideck.stopped")}
				{host.state?.endpoint ? <span className="ml-2 font-mono">{host.state.endpoint}</span> : null}
			</p>
			<fieldset disabled={busy || !host.state} className="flex flex-col gap-2">
				<legend className="mb-2 text-control font-medium">{t("config.mcp.pideck.projects")}</legend>
				<div className="flex shrink-0 items-center gap-2">
					<Checkbox id={`${prefix}-all`} checked={host.allProjects} onCheckedChange={(checked) => host.setAllProjects(checked === true)} />
					<Label htmlFor={`${prefix}-all`}>{t("config.mcp.pideck.allProjects")}</Label>
				</div>
				<p className="text-micro text-muted-foreground">{t("config.mcp.pideck.allProjectsHint")}</p>
				<div className="flex shrink-0 items-center gap-1">
					<p role="status" className="flex-1 text-micro text-muted-foreground">
						{t("config.mcp.pideck.selected", { selected: host.projectIds.length, total: projectCount })}
					</p>
					<Button variant="ghost" size="xs" disabled={allSelected || host.allProjects} onClick={() => host.setProjectIds(host.state?.projects.map((project) => project.id) ?? [])}>
						{t("config.mcp.pideck.selectAll")}
					</Button>
					<Button variant="ghost" size="xs" disabled={!host.projectIds.length || host.allProjects} onClick={() => host.setProjectIds([])}>
						{t("config.mcp.pideck.selectNone")}
					</Button>
				</div>
				<div className="flex max-h-60 flex-col gap-2 overflow-y-auto">
					{host.state?.projects.map((project, index) => (
						<div key={project.id} className="flex shrink-0 items-center gap-2">
							<Checkbox id={`${prefix}-${index}`} disabled={host.allProjects} checked={host.projectIds.includes(project.id)} onCheckedChange={(checked) => host.setProjectIds((ids) => (checked === true ? [...ids, project.id] : ids.filter((id) => id !== project.id)))} />
							<Label htmlFor={`${prefix}-${index}`}>{project.name}</Label>
						</div>
					))}
				</div>
			</fieldset>
			<fieldset disabled={busy || !host.state} className="flex flex-col gap-2">
				<legend className="mb-2 text-control font-medium">{t("config.mcp.pideck.control")}</legend>
				<div className="flex shrink-0 items-center gap-2">
					<Checkbox id={`${prefix}-control`} checked={host.allowControl} onCheckedChange={(checked) => host.setAllowControl(checked === true)} />
					<Label htmlFor={`${prefix}-control`}>{t("config.mcp.pideck.allowControl")}</Label>
				</div>
				<p className="text-micro text-muted-foreground">{t("config.mcp.pideck.allowControlHint")}</p>
			</fieldset>
			{/* 智能体写能力：默认关；关闭时只读元信息，开启后 CRUD + 会话绑定，角色设定只写不读 */}
			<fieldset disabled={busy || !host.state} className="flex flex-col gap-2">
				<legend className="mb-2 text-control font-medium">{t("config.mcp.pideck.agentWriteSection")}</legend>
				<div className="flex shrink-0 items-center gap-2">
					<Checkbox id={`${prefix}-agent-write`} checked={host.allowAgentWrite} onCheckedChange={(checked) => host.setAllowAgentWrite(checked === true)} />
					<Label htmlFor={`${prefix}-agent-write`}>{t("config.mcp.pideck.allowAgentWrite")}</Label>
				</div>
				<p className="text-micro text-muted-foreground">{t("config.mcp.pideck.allowAgentWriteHint")}</p>
			</fieldset>
			{/* 定时任务写能力：默认关；读任务/运行历史按项目白名单，开启后可 CRUD、立即运行与中止 */}
			<fieldset disabled={busy || !host.state} className="flex flex-col gap-2">
				<legend className="mb-2 text-control font-medium">{t("config.mcp.pideck.automationWriteSection")}</legend>
				<div className="flex shrink-0 items-center gap-2">
					<Checkbox id={`${prefix}-automation-write`} checked={host.allowAutomationWrite} onCheckedChange={(checked) => host.setAllowAutomationWrite(checked === true)} />
					<Label htmlFor={`${prefix}-automation-write`}>{t("config.mcp.pideck.allowAutomationWrite")}</Label>
				</div>
				<p className="text-micro text-muted-foreground">{t("config.mcp.pideck.allowAutomationWriteHint")}</p>
			</fieldset>
			{/* 收藏写能力：默认关；开启后可新增/删除本机收藏（含任意文本），读仍只返回无项目归属或已授权项目的条目 */}
			<fieldset disabled={busy || !host.state} className="flex flex-col gap-2">
				<legend className="mb-2 text-control font-medium">{t("config.mcp.pideck.favoriteWriteSection")}</legend>
				<div className="flex shrink-0 items-center gap-2">
					<Checkbox id={`${prefix}-favorite-write`} checked={host.allowFavoritesWrite} onCheckedChange={(checked) => host.setAllowFavoritesWrite(checked === true)} />
					<Label htmlFor={`${prefix}-favorite-write`}>{t("config.mcp.pideck.allowFavoritesWrite")}</Label>
				</div>
				<p className="text-micro text-muted-foreground">{t("config.mcp.pideck.allowFavoritesWriteHint")}</p>
			</fieldset>
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={busy || !host.state || (!host.projectIds.length && !host.allProjects) || Boolean(host.state.running && !changed)}
					onClick={() => {
						setCopied(false);
						void host.apply(true);
					}}
				>
					{t(host.state?.running ? "config.mcp.pideck.apply" : "config.mcp.pideck.enable")}
				</Button>
				<Button
					variant="outline"
					disabled={busy || !host.state?.enabled}
					onClick={() => {
						setCopied(false);
						void host.apply(false);
					}}
				>
					{t("config.mcp.pideck.disable")}
				</Button>
			</div>
			<p className="text-micro text-muted-foreground">{t("config.mcp.pideck.connectionHint")}</p>
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					disabled={busy || !host.state?.running || Boolean(changed)}
					onClick={() =>
						void host.withConnection(async (config) => {
							const ok = await desktopApi.clipboard.writeText(JSON.stringify(config, null, 2));
							if (ok) setCopied(true);
							return ok;
						})
					}
				>
					<Copy aria-hidden="true" />
					{t(copied ? "config.mcp.pideck.copied" : "config.mcp.pideck.copy")}
				</Button>
				<Button
					variant="outline"
					disabled={busy || !host.state?.running || Boolean(changed) || existingNames.has("pideck")}
					onClick={() =>
						void host.withConnection(async (config) => {
							const definition = config.mcpServers?.pideck;
							return definition ? onAdd(definition) : false;
						})
					}
				>
					<Plus aria-hidden="true" />
					{t(existingNames.has("pideck") ? "config.mcp.pideck.exists" : "config.mcp.pideck.add")}
				</Button>
			</div>
			{host.error ? (
				<p role="alert" className="text-control text-danger">
					{t("config.mcp.pideck.error", { code: host.error })}
				</p>
			) : null}
		</section>
	);
}

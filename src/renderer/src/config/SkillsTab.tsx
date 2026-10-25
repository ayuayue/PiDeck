import { Button } from "../components/ui-shadcn/button";
import { Switch } from "../components/ui-shadcn/switch";
import { Badge } from "../components/ui-shadcn/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../components/ui-shadcn/select";
import { useEffect, useState, type ReactNode } from "react";
import { ContentTabs } from "./ContentTabs";
import { Check, FileEdit, Pencil, ShoppingBag, Sparkles, Trash2, X, Store, Globe } from "lucide-react";
import type { CreatePiSkillInput, PiSkillListResult, PiSkillLocation, PiSkillSummary, ProjectResourceOverrides } from "../../../shared/types";
import { t } from "../i18n";
import { SkillStoreTab } from "./SkillStoreTab";
import { SkillHubStorePanel } from "./SkillHubStorePanel";
import { ContentStoreUpdatePanel } from "./ContentStoreUpdatePanel";
import { desktopApi } from "../desktopApi";
import { Input } from "../components/ui-shadcn/input";
import { Textarea } from "../components/ui-shadcn/textarea";
import { CreateResourceCard, CreateResourceField } from "./ConfigShared";
import { discoveryRowKey, isGlobalDiscoverySource, isProjectDiscoverySource, type ResourceScope } from "./resourceScopeModel";
import { buildProjectOverrideKeyIndex, matchesProjectOverride } from "./projectOverrideKeys";
import { useResourceTogglePending } from "../hooks/useResourceTogglePending";
import { isGlobalSkillSourceId } from "../../../shared/resourceIdentity";
import { ResourceImportDialog } from "./ResourceImportDialog";

export function SkillsTab(props: {
	scope: ResourceScope;
	/** Project id used by store imports; global scope deliberately passes undefined. */
	projectId?: string;
	/** Active project id used as an external scan source in both global and project scopes. */
	sourceProjectId?: string;
	/** Project resource pages keep imports inside their current project. */
	fixedProjectId?: string;
	projects?: Array<{ id: string; name: string; kind?: string }>;
	scopeSelector?: ReactNode;
	projectOverrides: ProjectResourceOverrides;
	discoverySkills: Array<{
		id: string;
		name: string;
		path: string;
		dir: string;
		sourceId: string;
		sourceLabel: string;
		description: string;
		enabled: boolean;
		managed: boolean;
	}>;
	data: PiSkillListResult;
	loading: boolean;
	creating: boolean;
	newName: string;
	newDescription: string;
	newLocationId: PiSkillLocation["id"];
	onRefresh: () => void;
	onOpenRoot: () => void;
	onChangeNewName: (value: string) => void;
	onChangeNewDescription: (value: string) => void;
	onChangeNewLocation: (value: PiSkillLocation["id"]) => void;
	onCreate: () => void;
	onToggle: (skill: PiSkillSummary, enabled: boolean) => void | Promise<void>;
	onDelete: (skill: PiSkillSummary) => void;
	onEdit: (skill: PiSkillSummary) => void;
	onRename: (skill: PiSkillSummary, newName: string) => Promise<void>;
}) {
	const { data } = props;
	// 开关的乐观覆盖：点击立刻翻转显示，写盘 + 刷新结束后清掉（技能写盘很快，但刷新链路仍要等）。
	const { begin, end, settle, shown } = useResourceTogglePending();
	const handleSkillToggle = async (skill: PiSkillSummary, enabled: boolean) => {
		if (!begin(skill.id, enabled)) return;
		try {
			await props.onToggle(skill, enabled);
		} finally {
			end(skill.id);
		}
	};
	// 数据回落后结算乐观覆盖：真值等于目标值才清除（技能开关自身会 await 刷新，这里兜住时序差）。
	useEffect(() => {
		const disabledKeys = buildProjectOverrideKeyIndex(props.projectOverrides.disabledGlobalSkills);
		const derived: Record<string, boolean | undefined> = {};
		for (const skill of props.data.skills) {
			// 与行上 effectiveEnabled 同一套算法：项目自有技能只看自身，全局技能再叠加项目级禁用。
			const disabledHere = isGlobalSkillSourceId(skill.sourceId) ? matchesProjectOverride(disabledKeys, skill.path) : false;
			derived[skill.id] = skill.enabled && !disabledHere;
		}
		settle(derived);
	}, [props.data, props.projectOverrides, settle]);
	const projects = props.projects ?? [];
	// Project scope shows both sources grouped by ownership; global scope shows global skill dirs only
	// (runtime-discovered package/settings rows are added below for both scopes).
	const visibleSkills = data.skills.filter((skill) => props.scope === "project" || skill.sourceId === "pi-global" || skill.sourceId === "agents-global");
	const projectSkills = visibleSkills.filter((skill) => skill.sourceId === "project-pi" || skill.sourceId === "project-agents");
	const globalSkills = visibleSkills.filter((skill) => skill.sourceId === "pi-global" || skill.sourceId === "agents-global");
	const disabledGlobalKeys = buildProjectOverrideKeyIndex(props.projectOverrides.disabledGlobalSkills);
	const availableLocations = data.locations.filter((location) => (props.scope === "project" ? location.id === "project-pi" || location.id === "project-agents" : location.id === "pi-global" || location.id === "agents-global"));
	// discovery 行去重：键是 sourceId + name。只按 name 去重会让包/设置提供的同名技能被本地行吞掉，
	// 而本地行只代表自己的目录，并不代表包里的那一条（见 discoveryRowKey 注释）。
	const localSkillKeys = new Set(visibleSkills.map((skill) => discoveryRowKey(skill.sourceId, skill.name)));
	const uniqueDiscoverySkills = props.discoverySkills.filter((item) => !localSkillKeys.has(discoveryRowKey(item.sourceId, item.name)));
	const projectDiscoverySkills = uniqueDiscoverySkills.filter((item) => isProjectDiscoverySource(item.sourceId));
	const globalDiscoverySkills = uniqueDiscoverySkills.filter((item) => isGlobalDiscoverySource(item.sourceId));
	// 全局页只渲染「全局拥有」的只读发现行（package-user/settings-user）；项目来源只在项目作用域出现。
	const visibleDiscoverySkills = props.scope === "project" ? uniqueDiscoverySkills : globalDiscoverySkills;
	// 空态/计数必须把发现行算进去：全局页可能只有包提供的技能，本地列表为空。
	const skillRowCount = visibleSkills.length + visibleDiscoverySkills.length;
	// 一级 tab：本地 / 商店
	const [skillTab, setSkillTab] = useState<"local" | "store">("local");
	// 二级 tab（商店内）：选择供应商
	const [storeSource, setStoreSource] = useState<"promptchat" | "skillhub">("skillhub");
	const canCreate = props.newName.trim() && props.newDescription.trim();
	// 新建技能的位置只影响保存目标，不应把其他目录已有的技能从列表中隐藏。
	const selectedLocation = availableLocations.find((location) => location.id === props.newLocationId) ?? availableLocations[0];
	return (
		<div className="skills-tab">
			<div className="mb-3 flex items-center justify-between gap-3">
				{/* Scope stays in the page header while Local/Store content changes below. */}
				<ContentTabs
					value={skillTab}
					onValueChange={(v) => {
						if (v !== "local" && v !== "store") return;
						setSkillTab(v);
						// 切回本地时刷新列表：原 TabsTrigger onClick 行为迁到这里统一处理
						// （beui trigger 不接收 onClick，且只在真正切换时触发，更符合预期）。
						if (v === "local") props.onRefresh();
					}}
					items={[
						{ value: "local", label: t("config.nav.skills") },
						{ value: "store", label: t("config.skillStoreTab"), icon: <ShoppingBag size={14} strokeWidth={1.8} /> },
					]}
				/>
				{/* 全局下拉：商店 tab 右侧、Tabs 行内（不进 Table） */}
				<div className="shrink-0">{props.scopeSelector}</div>
			</div>

			{skillTab === "store" ? (
				<div className="skills-store-content">
					{/* 二级 tab：供应商切换（内容级下划线，compact 版） */}
					<ContentTabs
						compact
						fill={false}
						value={storeSource}
						onValueChange={(v) => {
							if (v === "skillhub" || v === "promptchat") setStoreSource(v);
						}}
						items={[
							{ value: "skillhub", label: t("config.tabs.skillHub"), icon: <Store size={14} strokeWidth={1.8} /> },
							{ value: "promptchat", label: "Prompt.chat", icon: <Globe size={14} strokeWidth={1.8} /> },
						]}
					/>
					{storeSource === "skillhub" ? <SkillHubStorePanel projectId={props.scope === "project" ? props.projectId : undefined} /> : <SkillStoreTab projectId={props.scope === "project" ? props.projectId : undefined} onImported={props.onRefresh} locationId={props.newLocationId} />}
				</div>
			) : (
				<>
					{/* 内置技能热更新面板：随包技能可同步远端最新版（覆盖层优先），刷新列表即时生效 */}
					<ContentStoreUpdatePanel
						api={{
							status: () => desktopApi.contentStore.skillsStatus(),
							check: (branch) => desktopApi.contentStore.skillsCheck(branch),
							update: (branch) => desktopApi.contentStore.skillsUpdate(branch),
							restore: () => desktopApi.contentStore.skillsRestore(),
							restorePrevious: () => desktopApi.contentStore.skillsRestorePrevious(),
							openDir: () => desktopApi.contentStore.skillsOpenDir(),
						}}
						text={{
							title: t("config.contentStore.skills.title"),
							description: t("config.contentStore.skills.description"),
							restartHint: t("config.contentStore.skills.restartHint"),
						}}
						onApplied={props.onRefresh}
					/>
					<div className="mb-3 flex items-center justify-between gap-3">
						<div>
							<span className="font-mono text-xs tabular-nums text-muted-foreground">{t("config.count.skills", { count: skillRowCount })}</span>
							<small className="text-caption text-text-tertiary">{t("config.restartHint")}</small>
						</div>
						<div className="flex items-center gap-1.5">
							{/* 与扩展页/设置页统一为 sm 控件高度 */}
							<Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
								{t("common.refresh")}
							</Button>
							<ResourceImportDialog kind="skill" sourceProjectId={props.sourceProjectId ?? props.projectId} projects={projects} fixedProjectId={props.fixedProjectId} triggerLabel={t("config.import.button")} onImported={props.onRefresh} />
							<Button variant="outline" size="sm" onClick={props.onOpenRoot}>
								{t("config.openFolder")}
							</Button>
						</div>
					</div>

					<CreateResourceCard
						title={t("config.createSkill")}
						submit={
							<Button size="sm" variant="default" disabled={!canCreate || props.creating} onClick={props.onCreate}>
								{props.creating ? t("config.creatingSkill") : t("config.addSkill")}
							</Button>
						}
					>
						{/* 字段一律单列堆叠，与提示词模板页完全一致：
						    名称/位置同行时输入框先按 1fr 再被 260px 挤压，两个控件宽度不相等，
						    视线横向扫描时左缘会「跳一下」；单列后位置选择器铺满同一列宽。 */}
						<CreateResourceField label={t("config.name")}>
							<Input value={props.newName} placeholder={t("config.skillNamePlaceholder")} onChange={(event) => props.onChangeNewName(event.target.value)} />
						</CreateResourceField>
						<CreateResourceField label={t("config.location")}>
							<Select
								value={props.newLocationId}
								onValueChange={(v) => {
									// 只接受已知位置 id，避免外部字符串注入；仅改变保存目标，不立即创建文件。
									if (v === "pi-global" || v === "agents-global" || v === "project-pi" || v === "project-agents") {
										props.onChangeNewLocation(v);
									}
								}}
							>
								{/* 只显示相对路径（label 形如 ~/.pi/agent/skills）：绝对路径长且无增益，
									    窄列会溢出框边界；单行 + truncate 超长省略。 */}
								<SelectTrigger className="w-full">
									<span className="min-w-0 flex-1 truncate text-left">{selectedLocation?.label ?? t("config.chooseFolder")}</span>
								</SelectTrigger>
								<SelectContent>
									{availableLocations.map((location) => (
										<SelectItem key={location.id} value={location.id}>
											<span className="min-w-0 flex-1 truncate text-left">{location.label}</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</CreateResourceField>
						<CreateResourceField label={t("config.description")}>
							<Textarea value={props.newDescription} placeholder={t("config.skillUseWhenPlaceholder")} onChange={(event) => props.onChangeNewDescription(event.target.value)} className="min-h-[72px] resize-y" />
						</CreateResourceField>
					</CreateResourceCard>

					<div className="overflow-x-auto rounded-lg border border-border-subtle bg-bg-panel">
						{skillRowCount === 0 ? (
							<div className="py-12 text-center text-control text-text-tertiary">{t("config.emptySkills")}</div>
						) : (
							<Table className="table-fixed">
								<TableHeader>
									<TableRow>
										<TableHead className="w-56">{t("config.name")}</TableHead>
										{/* 描述列固定 40% 占比：table-fixed 忽略 min-width，窗口拉小时
								    无 width 的列会被压到接近 0（描述竖条）；给百分比宽度后
								    各列按比例压缩，描述列任何窗口下都保持可读宽度 */}
										<TableHead className="w-2/5">{t("config.description")}</TableHead>
										<TableHead className="w-36 text-right">{t("config.actions")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{props.scope === "project" && projectSkills.length > 0 ? (
										<TableRow>
											<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
												{t("config.resourceGroup.project")}
											</TableCell>
										</TableRow>
									) : null}
									{props.scope === "project" && projectSkills.map((skill) => <SkillTableRow key={skill.id} skill={skill} effectiveEnabled={shown(skill.id, skill.enabled)} inherited={false} onToggle={handleSkillToggle} onDelete={props.onDelete} onEdit={props.onEdit} onRename={props.onRename} />)}
									{props.scope === "project" && projectDiscoverySkills.map((item) => <DiscoveredSkillRow key={item.id} item={item} />)}
									{props.scope === "project" && globalSkills.length > 0 ? (
										<TableRow>
											<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
												{t("config.resourceGroup.global")}
											</TableCell>
										</TableRow>
									) : null}
									{globalSkills.map((skill) => {
										const inherited = props.scope === "project";
										const disabledHere = isGlobalSkillSourceId(skill.sourceId) ? matchesProjectOverride(disabledGlobalKeys, skill.path) : false;
										return <SkillTableRow key={skill.id} skill={skill} effectiveEnabled={shown(skill.id, skill.enabled && !disabledHere)} inherited={inherited} onToggle={handleSkillToggle} onDelete={props.onDelete} onEdit={props.onEdit} onRename={props.onRename} />;
									})}
									{/* 全局拥有的只读发现行：项目作用域在「全局资源」下继承展示，全局作用域单独分组展示 */}
									{props.scope === "global" && globalDiscoverySkills.length > 0 ? (
										<TableRow>
											<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
												{t("config.resourceGroup.discovered")}
											</TableCell>
										</TableRow>
									) : null}
									{globalDiscoverySkills.map((item) => (
										<DiscoveredSkillRow key={item.id} item={item} />
									))}
								</TableBody>
							</Table>
						)}
					</div>
				</>
			)}
		</div>
	);
}

function DiscoveredSkillRow(props: {
	item: {
		id: string;
		name: string;
		path: string;
		sourceId: string;
		sourceLabel: string;
		description: string;
		enabled: boolean;
		managed: boolean;
	};
}) {
	const { item } = props;
	return (
		<TableRow>
			<TableCell className="min-w-0">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<Sparkles size={14} strokeWidth={1.8} className="shrink-0 text-text-tertiary" />
						<strong className="truncate text-control font-medium text-foreground">{item.name}</strong>
						<Badge variant="outline" size="sm" title={t("config.resourceManagedHint")}>
							{t("config.source.global")}
						</Badge>
						<Badge variant={item.enabled ? "success" : "neutral"} size="sm">
							{item.enabled ? t("common.enabled") : t("common.disabled")}
						</Badge>
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{item.sourceLabel}</span>
				</div>
			</TableCell>
			<TableCell className="w-2/5 whitespace-normal break-words text-caption leading-relaxed text-muted-foreground" title={item.description}>
				{/* 不要再叠 block：Tailwind v4 里 .block 排在 .line-clamp-* 之后，会覆盖 -webkit-box 让截断失效。 */}
				<span className="line-clamp-3">{item.description}</span>
			</TableCell>
			<TableCell className="text-right" />
		</TableRow>
	);
}

function SkillTableRow(props: {
	skill: PiSkillSummary;
	effectiveEnabled: boolean;
	inherited: boolean;
	onToggle: (skill: PiSkillSummary, enabled: boolean) => void | Promise<void>;
	onDelete: (skill: PiSkillSummary) => void;
	onEdit: (skill: PiSkillSummary) => void;
	onRename: (skill: PiSkillSummary, newName: string) => Promise<void>;
}) {
	const { skill, effectiveEnabled, inherited } = props;
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(skill.name);
	const [renameBusy, setRenameBusy] = useState(false);

	useEffect(() => {
		// A row can remain mounted while the shared scope changes. Never leave a global
		// rename form usable after that row becomes a read-only inherited resource.
		if (inherited && renaming) {
			setRenaming(false);
			setRenameValue(skill.name);
		}
	}, [inherited, renaming, skill.name]);

	const handleRename = async () => {
		if (inherited) {
			setRenaming(false);
			return;
		}
		if (renameBusy || !renameValue.trim() || renameValue.trim() === skill.name) {
			setRenaming(false);
			return;
		}
		setRenameBusy(true);
		try {
			await props.onRename(skill, renameValue.trim());
			setRenaming(false);
		} finally {
			setRenameBusy(false);
		}
	};

	return (
		<TableRow>
			<TableCell className="min-w-0">
				{renaming && !inherited ? (
					<div className="flex items-center gap-1">
						<Input
							value={renameValue}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleRename();
								if (e.key === "Escape") setRenaming(false);
							}}
							autoFocus
							disabled={renameBusy}
						/>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={handleRename} disabled={renameBusy} title={t("common.confirm")}>
							<Check size={14} strokeWidth={2} />
						</Button>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setRenaming(false)} disabled={renameBusy} title={t("common.cancel")}>
							<X size={14} strokeWidth={2} />
						</Button>
					</div>
				) : (
					<div className="flex min-w-0 flex-col gap-0.5">
						<div className="flex min-w-0 items-center gap-2">
							<Sparkles size={14} strokeWidth={1.8} className="shrink-0 text-text-tertiary" />
							<strong className="truncate text-control font-medium text-foreground">{skill.name}</strong>
							<div className="skill-badges">
								<Badge variant={effectiveEnabled ? "success" : "neutral"} size="sm">
									{effectiveEnabled ? t("common.enabled") : t("common.disabled")}
								</Badge>
								{!skill.valid && (
									<Badge variant="danger" size="sm">
										{t("config.needsFix")}
									</Badge>
								)}
							</div>
						</div>
						<span className="truncate font-mono text-caption text-muted-foreground">{skill.sourceLabel}</span>
						{skill.warnings.length > 0 && (
							<div className="flex flex-col gap-0.5">
								{skill.warnings.map((warning) => (
									<span key={warning} className="truncate text-caption text-destructive">
										{warning}
									</span>
								))}
							</div>
						)}
					</div>
				)}
			</TableCell>
			{/* 描述太长时截断为 3 行（title 悬浮可看全文），避免长描述把整行撑得
			    很高；描述列 w-2/5 占比 + 3 行截断，窗口拉小也不挤压成竖条。
			    line-clamp 会改 display 为 -webkit-box，必须包一层 span 而不能直接放 td 上。 */}
			<TableCell className="w-2/5 whitespace-normal break-words text-caption leading-relaxed text-muted-foreground" title={skill.description}>
				<span className="line-clamp-3">{skill.description || t("config.skillDescriptionMissing")}</span>
			</TableCell>
			<TableCell className="text-right">
				<div className="flex justify-end gap-1">
					{/* 启停开关：Switch 轨道着色区分启用/禁用（Toggle 图标两态几乎无视觉差，用户反馈看不出状态） */}
					<Switch checked={effectiveEnabled} onCheckedChange={(checked) => props.onToggle(skill, checked)} disabled={inherited && !skill.enabled} title={effectiveEnabled ? t("common.disable") : t("common.enabled")} />
					{!inherited ? (
						<>
							<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => props.onEdit(skill)} title={t("common.edit")}>
								<Pencil size={14} strokeWidth={1.8} />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								className="size-7"
								onClick={() => {
									setRenaming(true);
									setRenameValue(skill.name);
								}}
								title={t("common.rename")}
							>
								<FileEdit size={14} strokeWidth={1.8} />
							</Button>
							<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => props.onDelete(skill)} title={t("common.delete")}>
								<Trash2 size={14} strokeWidth={1.8} />
							</Button>
						</>
					) : null}
				</div>
			</TableCell>
		</TableRow>
	);
}

import { Button } from "../components/ui-shadcn/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { showNotice } from "../utils/notice";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, FileEdit, FileText, Pencil, ShoppingBag, ToggleLeft, ToggleRight, Trash2, X } from "lucide-react";
import type { PiPromptTemplateListResult, PiPromptTemplateSummary, ProjectResourceOverrides } from "../../../shared/types";
import { t } from "../i18n";
import { CodeMirrorEditor } from "../components/app/CodeMirrorEditor";
import { PromptStoreTab } from "./PromptStoreTab";
import { ContentTabs } from "./ContentTabs";
import { Input } from "../components/ui-shadcn/input";
import { Textarea } from "../components/ui-shadcn/textarea";
import { CreateResourceCard, CreateResourceField } from "./ConfigShared";
import type { ResourceScope } from "./ResourceScopeSelector";
import { globalPromptOverrideKey } from "../../../shared/resourceIdentity";
import { isProjectDiscoverySource } from "./resourceScopeModel";

/**
 * Runtime-discovered package/settings prompts are owned by pi/package settings,
 * not PromptManager's editable prompt directory. Keep them visibly read-only:
 * their empty toggle action is intentional, not a missing handler.
 */
function DiscoveredPromptRow(props: {
	item: {
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
			<TableCell className="w-[22rem] max-w-[22rem]">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<FileText size={14} strokeWidth={1.8} className="shrink-0 text-text-tertiary" />
						<strong className="min-w-0 flex-1 break-words whitespace-normal">/{item.name}</strong>
						<span className="skill-state" title={t("config.resourceManagedHint")}>
							{t("config.source.global")}
						</span>
						<span className={`skill-state ${item.enabled ? "enabled" : "disabled"}`}>{item.enabled ? t("common.enabled") : t("common.disabled")}</span>
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{item.sourceLabel}</span>
				</div>
			</TableCell>
			<TableCell className="whitespace-normal break-words text-caption leading-relaxed text-text-secondary" title={item.description}>
				{item.description}
			</TableCell>
			<TableCell className="w-44 text-right">
				<span className="text-caption text-muted-foreground" title={t("config.resourceManagedHint")}>
					{t("config.resourceManaged")}
				</span>
			</TableCell>
		</TableRow>
	);
}

export function PromptsTab(props: {
	scope: ResourceScope;
	/** Project id used by online prompt imports; global scope passes undefined. */
	projectId?: string;
	scopeSelector?: ReactNode;
	projectOverrides: ProjectResourceOverrides;
	discoveryPrompts: Array<{
		name: string;
		path: string;
		sourceId: string;
		sourceLabel: string;
		description: string;
		enabled: boolean;
		managed: boolean;
	}>;
	data: PiPromptTemplateListResult;
	loading: boolean;
	creating: boolean;
	newName: string;
	newDescription: string;
	/** 当前正在编辑的模板，null 表示未打开编辑器 */
	editingTemplate: PiPromptTemplateSummary | null;
	/** 编辑器内容 */
	editContent: string;
	/** 编辑器是否正在加载 */
	editLoading: boolean;
	/** 编辑器是否正在保存 */
	editSaving: boolean;
	onRefresh: () => void;
	onOpenRoot: () => void;
	onChangeNewName: (value: string) => void;
	onChangeNewDescription: (value: string) => void;
	onCreate: () => void;
	onDelete: (template: PiPromptTemplateSummary) => void;
	onEdit: (template: PiPromptTemplateSummary) => void;
	onRename: (template: PiPromptTemplateSummary, newName: string) => Promise<void>;
	onToggle: (template: PiPromptTemplateSummary, enabled: boolean) => void;
	onCancelEdit: () => void;
	onQuickSave: () => void;
	onChangeEditContent: (value: string) => void;
	onSaveEdit: () => void;
}) {
	const { data } = props;
	// Project scope renders project-owned templates first, then inherited global templates.
	const visibleTemplates = data.templates.filter((template) => props.scope === "project" || template.scope !== "project").sort((left, right) => Number(right.scope === "project") - Number(left.scope === "project"));
	const projectTemplates = visibleTemplates.filter((template) => template.scope === "project");
	const globalTemplates = visibleTemplates.filter((template) => template.scope !== "project");
	const disabledGlobalKeys = new Set(props.projectOverrides.disabledGlobalPrompts);
	// discovery 行去重：与本地列表同名的条目只保留本地行（带操作），列表只显示一次
	const localPromptNames = new Set(visibleTemplates.map((template) => template.name.toLowerCase()));
	const uniqueDiscoveryPrompts = props.discoveryPrompts.filter((item) => !localPromptNames.has(item.name.toLowerCase()));
	const visibleTemplateCount = visibleTemplates.length;
	const canCreate = props.newName.trim().length > 0 && props.newDescription.trim().length > 0;

	// tab 切换："local"（本地模板） 或 "store"（在线商店）
	const [promptTab, setPromptTab] = useState<"local" | "store">("local");

	// Prompt 重命名状态
	const [renamingTemplate, setRenamingTemplate] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [renameBusy, setRenameBusy] = useState(false);

	useEffect(() => {
		// The shared scope can change without unmounting a row. Cancel any global rename
		// that has become an inherited, read-only project row before it can submit.
		if (props.scope === "project" && renamingTemplate !== null) {
			setRenamingTemplate(null);
			setRenameValue("");
		}
	}, [props.scope, renamingTemplate]);

	// 编辑器提示状态
	const [showHint, setShowHint] = useState(false);
	const prevSaving = useRef(props.editSaving);

	// 当编辑器打开时，显示快捷键提示
	useEffect(() => {
		if (props.editingTemplate) {
			setShowHint(true);
			/* savedHint 已改用 toast (sonner) */
			const timer = setTimeout(() => setShowHint(false), 3000);
			return () => clearTimeout(timer);
		}
	}, [props.editingTemplate]);

	// 保存完成后显示 toast 提示（改用 sonner）
	useEffect(() => {
		if (prevSaving.current && !props.editSaving) {
			showNotice(t("config.promptSavedHint"), 2000);
		}
		prevSaving.current = props.editSaving;
	});

	// Ctrl+S / Cmd+S 快捷键保存
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				if (props.editingTemplate && !props.editSaving) {
					props.onQuickSave();
				}
			}
		},
		[props.editingTemplate, props.editSaving, props.onQuickSave],
	);

	/** 渲染单条模板行（重命名/开关/编辑/删除由局部状态驱动）。 */
	const renderTemplateRow = (template: PiPromptTemplateSummary) => {
		const isRenaming = renamingTemplate === template.path;
		const handleRename = async () => {
			if (inherited) {
				setRenamingTemplate(null);
				return;
			}
			if (renameBusy || !renameValue.trim() || renameValue.trim() === template.name) {
				setRenamingTemplate(null);
				return;
			}
			setRenameBusy(true);
			try {
				await props.onRename(template, renameValue.trim());
				setRenamingTemplate(null);
			} finally {
				setRenameBusy(false);
			}
		};
		const inherited = props.scope === "project" && template.scope !== "project";
		const disabledHere = inherited && disabledGlobalKeys.has(globalPromptOverrideKey(template.name));
		const effectiveEnabled = template.enabled !== false && !disabledHere;
		return (
			<Fragment key={template.path}>
				<TableRow key={`${template.path}-item`}>
					<TableCell className="w-[22rem] max-w-[22rem]">
						{isRenaming && !inherited ? (
							<div className="flex items-center gap-1">
								<Input
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void handleRename();
										if (e.key === "Escape") setRenamingTemplate(null);
									}}
									autoFocus
									disabled={renameBusy}
								/>
								<Button variant="ghost" size="icon-sm" className="size-7" onClick={handleRename} disabled={renameBusy} title={t("common.confirm")}>
									<Check size={14} strokeWidth={2} />
								</Button>
								<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setRenamingTemplate(null)} disabled={renameBusy} title={t("common.cancel")}>
									<X size={14} strokeWidth={2} />
								</Button>
							</div>
						) : (
							<button type="button" className="prompts-list-item-info" onClick={() => props.onEdit(template)} disabled={inherited} title={inherited ? undefined : t("common.edit")}>
								<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
									<FileText size={14} strokeWidth={1.8} className="shrink-0 text-text-tertiary" />
									<strong className="min-w-0 flex-1 break-words whitespace-normal">/{template.name}</strong>
									<span className={`skill-state ${effectiveEnabled ? "enabled" : "disabled"}`}>{effectiveEnabled ? t("common.enabled") : t("common.disabled")}</span>
								</span>
							</button>
						)}
					</TableCell>
					<TableCell className="whitespace-normal break-words text-caption leading-relaxed text-text-secondary" title={template.description}>
						{template.description}
					</TableCell>
					<TableCell className="w-44 text-right">
						<div className="flex min-w-max justify-end gap-1">
							<Button variant="ghost" size="icon-sm" className={`size-7${effectiveEnabled ? " text-primary" : ""}`} disabled={inherited && template.enabled === false} onClick={() => props.onToggle(template, !effectiveEnabled)} title={effectiveEnabled ? t("common.disable") : t("common.enabled")}>
								{effectiveEnabled ? <ToggleRight size={18} strokeWidth={1.8} /> : <ToggleLeft size={18} strokeWidth={1.8} />}
							</Button>
							{!inherited ? (
								<>
									<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => props.onEdit(template)} title={t("common.edit")}>
										<Pencil size={14} strokeWidth={1.8} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-7"
										onClick={() => {
											setRenamingTemplate(template.path);
											setRenameValue(template.name);
										}}
										title={t("common.rename")}
									>
										<FileEdit size={14} strokeWidth={1.8} />
									</Button>
									<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => props.onDelete(template)} title={t("common.delete")}>
										<Trash2 size={14} strokeWidth={1.8} />
									</Button>
								</>
							) : null}
						</div>
					</TableCell>
				</TableRow>
			</Fragment>
		);
	};

	useEffect(() => {
		if (props.editingTemplate) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [props.editingTemplate, handleKeyDown]);

	return (
		<div className="prompts-tab">
			<div className="mb-3 flex items-center justify-between gap-3">
				{/* Scope stays available while Local/Store content changes below. */}
				<ContentTabs
					value={promptTab}
					onValueChange={(v) => {
						if (v !== "local" && v !== "store") return;
						setPromptTab(v);
						// 切回本地时刷新列表（原 TabsTrigger onClick 行为迁到 onValueChange 统一处理）
						if (v === "local") props.onRefresh();
					}}
					items={[
						{ value: "local", label: t("config.nav.prompts") },
						{ value: "store", label: t("config.promptStoreTab"), icon: <ShoppingBag size={14} strokeWidth={1.8} /> },
					]}
				/>
				{/* 全局下拉：商店 tab 右侧、Tabs 行内（不进 Table） */}
				<div className="shrink-0">{props.scopeSelector}</div>
			</div>

			{promptTab === "store" ? (
				<PromptStoreTab projectId={props.scope === "project" ? props.projectId : undefined} onImported={props.onRefresh} />
			) : (
				<>
					<div className="mb-3 flex items-center justify-between gap-3">
						<div>
							<span className="font-mono text-xs tabular-nums text-text-tertiary">{t("config.count.prompts", { count: visibleTemplateCount })}</span>
							<small className="prompts-restart-hint">{t("config.restartHint")}</small>
						</div>
						<div className="prompts-toolbar-actions flex items-center gap-1.5">
							<Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
								{t("common.refresh")}
							</Button>
							<Button variant="secondary" size="sm" onClick={props.onOpenRoot}>
								{t("config.openFolder")}
							</Button>
						</div>
					</div>

					<CreateResourceCard
						title={t("config.createPrompt")}
						submit={
							<Button size="sm" variant="default" disabled={!canCreate || props.creating} onClick={props.onCreate}>
								{props.loading || props.creating ? t("common.loading") : t("config.create")}
							</Button>
						}
					>
						<CreateResourceField label={t("config.name")}>
							<Input value={props.newName} placeholder={t("config.promptNamePlaceholder")} onChange={(e) => props.onChangeNewName(e.target.value)} />
						</CreateResourceField>
						<CreateResourceField label={t("config.description")}>
							<Textarea className="min-h-[72px] resize-y" value={props.newDescription} placeholder={t("config.promptDescriptionPlaceholder")} onChange={(e) => props.onChangeNewDescription(e.target.value)} />
						</CreateResourceField>
					</CreateResourceCard>

					<section className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
						{visibleTemplateCount === 0 ? (
							<div className="py-12 text-center text-control text-text-tertiary">{t("config.noPrompts")}</div>
						) : (
							<Table className="table-fixed">
								<TableHeader>
									<TableRow>
										<TableHead className="w-[22rem]">{t("config.name")}</TableHead>
										<TableHead>{t("config.description")}</TableHead>
										<TableHead className="w-44 text-right">{t("config.actions")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{/* 项目组：项目模板 + 项目侧托管资源 */}
									{props.scope === "project" && projectTemplates.length > 0 ? (
										<TableRow>
											<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
												{t("config.resourceGroup.project")}
											</TableCell>
										</TableRow>
									) : null}
									{projectTemplates.map((template) => renderTemplateRow(template))}
									{props.scope === "project" && uniqueDiscoveryPrompts.filter((item) => isProjectDiscoverySource(item.sourceId)).map((item) => <DiscoveredPromptRow key={`discovered:${item.path}`} item={item} />)}
									{/* 全局组：全局模板 + 继承的全局托管资源 */}
									{props.scope === "project" && globalTemplates.length > 0 ? (
										<TableRow>
											<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
												{t("config.resourceGroup.global")}
											</TableCell>
										</TableRow>
									) : null}
									{globalTemplates.map((template) => renderTemplateRow(template))}
									{props.scope === "project" && uniqueDiscoveryPrompts.filter((item) => !isProjectDiscoverySource(item.sourceId)).map((item) => <DiscoveredPromptRow key={`discovered:${item.path}`} item={item} />)}
								</TableBody>
							</Table>
						)}
					</section>

					{/* 编辑弹框 */}
					{props.editingTemplate && (
						<div className="prompts-editor-backdrop" onClick={props.onCancelEdit}>
							<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
								<div className="file-diff-header">
									<span className="file-diff-header-file">
										{props.editingTemplate.name}.md
										{showHint && <span className="file-diff-hint">{t("config.promptSaveHint")}</span>}
									</span>
									<div className="file-diff-header-actions">
										<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={props.onCancelEdit}>
											<X size={18} strokeWidth={2.2} aria-hidden="true" />
										</Button>
									</div>
								</div>
								{props.editLoading ? (
									<div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
								) : (
									<div className="prompts-monaco-wrap">
										<CodeMirrorEditor value={props.editContent} onChange={props.onChangeEditContent} />
									</div>
								)}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}

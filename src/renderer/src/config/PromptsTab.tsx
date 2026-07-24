import { showNotice } from "../utils/notice";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileEdit, Pencil, ShoppingBag, Trash2, X } from "lucide-react";
import type {
	CreatePiPromptTemplateInput,
	PiPromptTemplateListResult,
	PiPromptTemplateSummary,
} from "../../../shared/types";
import { t } from "../i18n";
import { CloseIconButton } from "../components/ui/IconButton";
import { LazyMonacoEditor } from "../components/ui/LazyMonacoEditor";
import { PromptStoreTab } from "./PromptStoreTab";

export function PromptsTab(props: {
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
	onCancelEdit: () => void;
	onQuickSave: () => void;
	onChangeEditContent: (value: string) => void;
	onSaveEdit: () => void;
}) {
	const { data } = props;
	const canCreate = props.newName.trim().length > 0 && props.newDescription.trim().length > 0;

	// tab 切换："local"（本地模板） 或 "store"（在线商店）
	const [promptTab, setPromptTab] = useState<"local" | "store">("local");

	// Prompt 重命名状态
	const [renamingTemplate, setRenamingTemplate] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [renameBusy, setRenameBusy] = useState(false);

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
	const handleKeyDown = useCallback((e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "s") {
			e.preventDefault();
			if (props.editingTemplate && !props.editSaving) {
				props.onQuickSave();
			}
		}
	}, [props.editingTemplate, props.editSaving, props.onQuickSave]);

	useEffect(() => {
		if (props.editingTemplate) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [props.editingTemplate, handleKeyDown]);

	return (
		<div className="prompts-tab">
			{/* tab 切换栏 */}
			<div className="prompts-tab-bar">
				<button
					className={`prompts-tab-btn ${promptTab === "local" ? "active" : ""}`}
					onClick={() => { setPromptTab("local"); props.onRefresh(); }}
				>
					{t("config.nav.prompts")}
				</button>
				<button
					className={`prompts-tab-btn ${promptTab === "store" ? "active" : ""}`}
					onClick={() => setPromptTab("store")}
				>
					<ShoppingBag size={14} strokeWidth={1.8} />
					{t("config.promptStoreTab")}
				</button>
			</div>

			{promptTab === "store" ? (
				<PromptStoreTab
					onImported={props.onRefresh}
				/>
			) : (
				<>
					<div className="config-toolbar">
				<div>
					<span className="config-count">
						{t("config.count.prompts", { count: data.templates.length })}
					</span>
					<small className="prompts-restart-hint">{t("config.restartHint")}</small>
				</div>
				<div className="prompts-toolbar-actions">
					<button
						className="config-btn"
						onClick={props.onRefresh}
						disabled={props.loading}
					>
						{t("common.refresh")}
					</button>
					<button className="config-btn blue" onClick={props.onOpenRoot}>
						{t("config.openFolder")}
					</button>
				</div>
			</div>

			<section className="prompt-create-card">
				<strong>{t("config.createPrompt")}</strong>
				<label className="prompt-create-label">
					<span>{t("config.name")}</span>
					<input
						value={props.newName}
						placeholder={t("config.promptNamePlaceholder")}
						onChange={(e) => props.onChangeNewName(e.target.value)}
					/>
				</label>
				<label className="prompt-create-label">
					<span>{t("config.description")}</span>
					<textarea
						className="prompt-create-textarea"
						value={props.newDescription}
						placeholder={t("config.promptDescriptionPlaceholder")}
						onChange={(e) => props.onChangeNewDescription(e.target.value)}
						rows={3}
					/>
				</label>
				<button
					className="config-btn primary"
					disabled={!canCreate || props.creating}
					onClick={props.onCreate}
				>
					{props.loading || props.creating ? t("common.loading") : t("config.create")}
				</button>
			</section>

			<section className="prompts-list">
				{data.templates.length === 0 ? (
					<div className="config-empty">{t("config.noPrompts")}</div>
				) : (
					data.templates.map((template) => {
						const isRenaming = renamingTemplate === template.path;
						const handleRename = async () => {
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
						return (
							<div key={template.path} className="prompts-list-item">
								{isRenaming ? (
									<div className="skill-rename-inline">
										<input
											value={renameValue}
											onChange={(e) => setRenameValue(e.target.value)}
											onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); if (e.key === "Escape") setRenamingTemplate(null); }}
											autoFocus
											disabled={renameBusy}
										/>
										<button className="config-icon-btn" onClick={handleRename} disabled={renameBusy} title={t("common.confirm")}>
											<Check size={14} strokeWidth={2} />
										</button>
										<button className="config-icon-btn" onClick={() => setRenamingTemplate(null)} disabled={renameBusy} title={t("common.cancel")}>
											<X size={14} strokeWidth={2} />
										</button>
									</div>
								) : (
									<button
										type="button"
										className="prompts-list-item-info"
										onClick={() => props.onEdit(template)}
										title={t("common.edit")}
									>
										<strong>/{template.name}</strong>
										<span className="prompts-list-item-desc">{template.description}</span>
									</button>
								)}
								<div className="prompts-list-item-actions">
									<button
										className="config-icon-btn"
										onClick={() => props.onEdit(template)}
										title={t("common.edit")}
									>
										<Pencil size={14} strokeWidth={1.8} />
									</button>
									<button
										className="config-icon-btn"
										onClick={() => { setRenamingTemplate(template.path); setRenameValue(template.name); }}
										title={t("common.rename")}
									>
										<FileEdit size={14} strokeWidth={1.8} />
									</button>
									<button
										className="config-icon-btn danger"
										onClick={() => props.onDelete(template)}
										title={t("common.delete")}
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</button>
								</div>
							</div>
						);
					})
				)}
			</section>

				{/* 编辑弹框 */}
				{props.editingTemplate && (
				<div
					className="prompts-editor-backdrop"
					onClick={props.onCancelEdit}
				>
					<div
						className="prompts-editor-modal"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="file-diff-header">
							<span className="file-diff-header-file">
								{props.editingTemplate.name}.md
								{showHint && <span className="file-diff-hint">{t("config.promptSaveHint")}</span>}
							</span>
							<div className="file-diff-header-actions">
								<CloseIconButton
									label={t("common.close")}
									onClick={props.onCancelEdit}
								/>
							</div>
						</div>
						{props.editLoading ? (
							<div className="config-empty">{t("common.loading")}</div>
						) : (
							<div className="prompts-monaco-wrap">
								<LazyMonacoEditor
									value={props.editContent}
									onChange={props.onChangeEditContent}
								/>
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

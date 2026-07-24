import { useState } from "react";
import { Check, FileEdit, Pencil, ShoppingBag, ToggleLeft, ToggleRight, Trash2, X, Store, Globe } from "lucide-react";
import type {
	CreatePiSkillInput,
	PiSkillListResult,
	PiSkillLocation,
	PiSkillSummary,
} from "../../../shared/types";
import { t } from "../i18n";
import { SkillStoreTab } from "./SkillStoreTab";
import { SkillHubStorePanel } from "./SkillHubStorePanel";

export function SkillsTab(props: {
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
	onToggle: (skill: PiSkillSummary, enabled: boolean) => void;
	onDelete: (skill: PiSkillSummary) => void;
	onEdit: (skill: PiSkillSummary) => void;
	onRename: (skill: PiSkillSummary, newName: string) => Promise<void>;
}) {
	const { data } = props;
	// 一级 tab：本地 / 商店
	const [skillTab, setSkillTab] = useState<"local" | "store">("local");
	// 二级 tab（商店内）：选择供应商
	const [storeSource, setStoreSource] = useState<"promptchat" | "skillhub">("skillhub");
	const [locationPickerOpen, setLocationPickerOpen] = useState(false);
	const canCreate = props.newName.trim() && props.newDescription.trim();
	// 按选中的位置目录过滤 skill 列表
	const filteredSkills = data.skills.filter((s) => s.sourceId === props.newLocationId);
	const selectedLocation =
		data.locations.find((location) => location.id === props.newLocationId) ??
		data.locations[0];
	return (
		<div className="skills-tab">
			{/* 一级 tab：本地 / 商店 */}
			<div className="prompts-tab-bar">
				<button
					className={`prompts-tab-btn ${skillTab === "local" ? "active" : ""}`}
					onClick={() => { setSkillTab("local"); props.onRefresh(); }}
				>
					{t("config.nav.skills")}
				</button>
				<button
					className={`prompts-tab-btn ${skillTab === "store" ? "active" : ""}`}
					onClick={() => setSkillTab("store")}
				>
					<ShoppingBag size={14} strokeWidth={1.8} />
					{t("config.promptStoreTab")}
				</button>
			</div>

			{skillTab === "store" ? (
				<div className="skills-store-content">
					{/* 二级 tab：供应商切换 */}
					<div className="prompts-tab-bar skills-store-source-bar">
						<button
							className={`prompts-tab-btn ${storeSource === "skillhub" ? "active" : ""}`}
							onClick={() => setStoreSource("skillhub")}
						>
							<Store size={14} strokeWidth={1.8} />
							{t("config.tabs.skillHub")}
						</button>
						<button
							className={`prompts-tab-btn ${storeSource === "promptchat" ? "active" : ""}`}
							onClick={() => setStoreSource("promptchat")}
						>
							<Globe size={14} strokeWidth={1.8} />
							Prompt.chat
						</button>
					</div>
					{storeSource === "skillhub" ? (
						<SkillHubStorePanel />
					) : (
						<SkillStoreTab
							onImported={props.onRefresh}
							locationId={props.newLocationId}
						/>
					)}
				</div>
			) : (
				<>
					<div className="config-toolbar">
				<div>
					<span className="config-count">
						{t("config.count.skills", { count: filteredSkills.length })}
					</span>
					<small className="skills-restart-hint">
						{t("config.restartHint")}
					</small>
				</div>
				<div className="skills-toolbar-actions">
					<button className="config-btn" onClick={props.onRefresh} disabled={props.loading}>
						{t("common.refresh")}
					</button>
					<button className="config-btn blue" onClick={props.onOpenRoot}>
						{t("config.openFolder")}
					</button>
				</div>
			</div>

			<section className="skill-create-card">
				<strong>{t("config.createSkill")}</strong>
				<div className="skill-create-grid">
					<label>
						<span>{t("config.name")}</span>
						<input
							value={props.newName}
							placeholder={t("config.skillNamePlaceholder")}
							onChange={(event) => props.onChangeNewName(event.target.value)}
						/>
					</label>
					<label>
						<span>{t("config.location")}</span>
						<div
							className="skill-location-picker"
							onBlur={() => {
								// 先让菜单项的 mouseDown 完成选中，再关闭弹层；否则点击选项时可能只触发焦点切换，表现为不回填。
								window.setTimeout(() => setLocationPickerOpen(false), 80);
							}}
						>
							<button
								type="button"
								className={locationPickerOpen ? "open" : ""}
								onMouseDown={(event) => {
									event.preventDefault();
									setLocationPickerOpen((open) => !open);
								}}
							>
								<span>{selectedLocation?.label ?? t("config.chooseFolder")}</span>
								<b>⌄</b>
							</button>
							{locationPickerOpen && (
								<div className="skill-location-menu">
									{data.locations.map((location) => (
										<button
											key={location.id}
											type="button"
											className={location.id === props.newLocationId ? "active" : ""}
											onMouseDown={(event) => {
												event.preventDefault();
												// 自定义下拉只改变保存位置，不立即创建，避免用户误触后写入文件。
												props.onChangeNewLocation(location.id);
												setLocationPickerOpen(false);
											}}
										>
											<strong>{location.label}</strong>
											<small>{location.path}</small>
										</button>
									))}
								</div>
							)}
						</div>
					</label>
				</div>
				<label className="skill-description-field">
					<span>{t("config.description")}</span>
					<textarea
						value={props.newDescription}
						placeholder={t("config.skillUseWhenPlaceholder")}
						onChange={(event) => props.onChangeNewDescription(event.target.value)}
					/>
				</label>
				<button
					className="config-btn primary"
					onClick={props.onCreate}
					disabled={!canCreate || props.creating}
				>
					{props.creating ? t("config.creatingSkill") : t("config.addSkill")}
				</button>
			</section>

			<div className="skills-list">
				{filteredSkills.length === 0 ? (
					<div className="config-empty">{t("config.emptySkills")}</div>
				) : (
					filteredSkills.map((skill) => (
						<SkillCard
							key={skill.id}
							skill={skill}
							onToggle={props.onToggle}
							onDelete={props.onDelete}
							onEdit={props.onEdit}
							onRename={props.onRename}
						/>
					))
				)}
			</div>
		</>
			)}
		</div>
	);
}

function SkillCard(props: {
	skill: PiSkillSummary;
	onToggle: (skill: PiSkillSummary, enabled: boolean) => void;
	onDelete: (skill: PiSkillSummary) => void;
	onEdit: (skill: PiSkillSummary) => void;
	onRename: (skill: PiSkillSummary, newName: string) => Promise<void>;
}) {
	const { skill } = props;
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(skill.name);
	const [renameBusy, setRenameBusy] = useState(false);

	const handleRename = async () => {
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
		<article className="session-card skill-card">
			<div className="session-card-display">
				<button
					type="button"
					className="session-card-inner skill-card-main"
					onClick={() => props.onEdit(skill)}
					title={t("common.edit")}
				>
					<div className="session-card-title skill-title-row">
						{renaming ? (
							<div className="skill-rename-inline">
								<input
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); if (e.key === "Escape") setRenaming(false); }}
									autoFocus
									disabled={renameBusy}
								/>
								<button className="config-icon-btn" onClick={handleRename} disabled={renameBusy} title={t("common.confirm")}>
									<Check size={14} strokeWidth={2} />
								</button>
								<button className="config-icon-btn" onClick={() => setRenaming(false)} disabled={renameBusy} title={t("common.cancel")}>
									<X size={14} strokeWidth={2} />
								</button>
							</div>
						) : (
							<strong>{skill.name}</strong>
						)}
						<div className="skill-badges">
							<span className={`skill-state ${skill.enabled ? "enabled" : "disabled"}`}>
								{skill.enabled ? t("common.enabled") : t("common.disabled")}
							</span>
							{!skill.valid && <span className="skill-state invalid">{t("config.needsFix")}</span>}
						</div>
					</div>
					<small>{skill.description || t("config.skillDescriptionMissing")}</small>
					<small>{skill.sourceLabel} · {skill.path}</small>
					{skill.warnings.length > 0 && (
						<ul className="skill-warnings">
							{skill.warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					)}
				</button>
				<div className="prompts-list-item-actions">
					<button
						className="config-icon-btn"
						onClick={() => props.onToggle(skill, !skill.enabled)}
						title={skill.enabled ? t("common.disable") : t("common.enabled")}
						style={skill.enabled ? { color: "var(--color-accent)" } : undefined}
					>
						{skill.enabled ? <ToggleRight size={18} strokeWidth={1.8} /> : <ToggleLeft size={18} strokeWidth={1.8} />}
					</button>
					<button
						className="config-icon-btn"
						onClick={() => props.onEdit(skill)}
						title={t("common.edit")}
					>
						<Pencil size={14} strokeWidth={1.8} />
					</button>
					<button
						className="config-icon-btn"
						onClick={() => { setRenaming(true); setRenameValue(skill.name); }}
						title={t("common.rename")}
					>
						<FileEdit size={14} strokeWidth={1.8} />
					</button>
					<button
						className="config-icon-btn danger"
						onClick={() => props.onDelete(skill)}
						title={t("common.delete")}
					>
						<Trash2 size={14} strokeWidth={1.8} />
					</button>
				</div>
			</div>
		</article>
	);
}

export type { CreatePiSkillInput };

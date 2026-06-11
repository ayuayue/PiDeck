import { useState } from "react";
import type {
	CreatePiSkillInput,
	PiSkillListResult,
	PiSkillLocation,
	PiSkillSummary,
} from "../../../shared/types";

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
	onOpenFolder: (skill: PiSkillSummary) => void;
}) {
	const { data } = props;
	const [locationPickerOpen, setLocationPickerOpen] = useState(false);
	const canCreate = props.newName.trim() && props.newDescription.trim();
	const selectedLocation =
		data.locations.find((location) => location.id === props.newLocationId) ??
		data.locations[0];
	return (
		<div className="skills-tab">
			<div className="config-toolbar">
				<div>
					<span className="config-count">{data.skills.length} 个 Skill</span>
					<small className="skills-restart-hint">
						修改后需要新建或重启 agent 才会生效
					</small>
				</div>
				<div className="skills-toolbar-actions">
					<button className="config-btn" onClick={props.onRefresh} disabled={props.loading}>
						刷新
					</button>
					<button className="config-btn blue" onClick={props.onOpenRoot}>
						打开目录
					</button>
				</div>
			</div>

			<section className="skill-create-card">
				<strong>新建 Skill</strong>
				<div className="skill-create-grid">
					<label>
						<span>名称</span>
						<input
							value={props.newName}
							placeholder="my-skill"
							onChange={(event) => props.onChangeNewName(event.target.value)}
						/>
					</label>
					<label>
						<span>位置</span>
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
								<span>{selectedLocation?.label ?? "选择目录"}</span>
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
					<span>描述</span>
					<textarea
						value={props.newDescription}
						placeholder="Use when..."
						onChange={(event) => props.onChangeNewDescription(event.target.value)}
					/>
				</label>
				<button
					className="config-btn primary"
					onClick={props.onCreate}
					disabled={!canCreate || props.creating}
				>
					{props.creating ? "创建中…" : "创建 Skill"}
				</button>
			</section>

			<div className="skills-list">
				{data.skills.length === 0 ? (
					<div className="config-empty">暂无 Skill，可先创建一个全局 Skill。</div>
				) : (
					data.skills.map((skill) => (
						<SkillCard
							key={skill.id}
							skill={skill}
							onToggle={props.onToggle}
							onDelete={props.onDelete}
							onOpenFolder={props.onOpenFolder}
						/>
					))
				)}
			</div>
		</div>
	);
}

function SkillCard(props: {
	skill: PiSkillSummary;
	onToggle: (skill: PiSkillSummary, enabled: boolean) => void;
	onDelete: (skill: PiSkillSummary) => void;
	onOpenFolder: (skill: PiSkillSummary) => void;
}) {
	const { skill } = props;
	return (
		<article className="session-card skill-card">
			<div className="session-card-display">
				<div className="session-card-inner skill-card-main">
					<div className="session-card-title skill-title-row">
						<strong>{skill.name}</strong>
						<div className="skill-badges">
							<span className={`skill-state ${skill.enabled ? "enabled" : "disabled"}`}>
								{skill.enabled ? "启用" : "禁用"}
							</span>
							{!skill.valid && <span className="skill-state invalid">需修复</span>}
						</div>
					</div>
					<small>{skill.description || "缺少 description，pi 不会加载该 skill。"}</small>
					<small>{skill.sourceLabel} · {skill.path}</small>
					{skill.warnings.length > 0 && (
						<ul className="skill-warnings">
							{skill.warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					)}
				</div>
				<div className="session-card-actions skill-card-actions">
					<button className="session-rename-button" onClick={() => props.onToggle(skill, !skill.enabled)}>
						{skill.enabled ? "禁用" : "启用"}
					</button>
					<button className="session-rename-button" onClick={() => props.onOpenFolder(skill)}>打开</button>
					<button className="session-rename-button danger" onClick={() => props.onDelete(skill)}>删除</button>
				</div>
			</div>
		</article>
	);
}

export type { CreatePiSkillInput };

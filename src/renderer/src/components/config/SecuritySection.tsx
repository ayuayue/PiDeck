/**
 * 安全管理配置面板（Pi 管理弹框 → 安全管理）
 *
 * 功能：
 * - 总开关（enabled）：关闭时安全门扩展完全放行（零干预默认）；
 * - 全局默认等级：未设置会话级覆盖的会话使用；
 * - 等级管理：内置 off/standard/strict 三档 + 用户自定义；每档可配置
 *   工具动作（allow/ask/deny）、bash 危险命令正则、目录边界、敏感文件保护、兜底动作；
 * - 会话级覆盖在会话输入框切换（见 SecurityLevelMenu），不在此处管理。
 *
 * 数据流：本组件只做「草稿编辑 + 保存」；保存走 api.security.updateConfig
 * → SecurityStore 校验/持久化 → 写策略快照 → 运行中的安全门扩展 2s 内热更新。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
	createDefaultSecurityConfig,
	type SecurityAction,
	type SecurityConfig,
	type SecurityLevelConfig,
	type SecurityPathPolicy,
	type SecurityToolName,
} from "../../../../shared/types";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { Switch } from "../ui-shadcn/switch";
import { Textarea } from "../ui-shadcn/textarea";
import { t } from "../../i18n";

const api = (window as unknown as { piDesktop: { security: {
	getConfig: () => Promise<SecurityConfig>;
	updateConfig: (patch: Partial<SecurityConfig>) => Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }>;
} } }).piDesktop;

const TOOL_ORDER: SecurityToolName[] = ["read", "write", "edit", "bash", "grep", "find", "ls", "ask_question"];

const ACTION_OPTIONS: Array<{ value: SecurityAction; label: string }> = [
	{ value: "allow", label: "放行" },
	{ value: "ask", label: "确认" },
	{ value: "deny", label: "拒绝" },
];

/** 安全管理面板暴露给父级（ConfigModal 顶部统一保存按钮）的能力。 */
export type SecuritySectionHandle = {
	/** 保存当前草稿；返回是否成功（失败详情已写入错误区）。 */
	save: () => Promise<boolean>;
};

type SecuritySectionProps = {
	/** 草稿脏状态变化上报（true=有未保存修改）；卸载时上报 false 供父级清标记。 */
	onDirtyChange?: (dirty: boolean) => void;
};

/** 复制一份等级草稿（深拷贝，避免直接改共享引用） */
function cloneLevel(level: SecurityLevelConfig): SecurityLevelConfig {
	return {
		...level,
		toolActions: { ...level.toolActions },
		denyBashPatterns: [...level.denyBashPatterns],
		customAllowDirs: [...level.customAllowDirs],
		denyDirs: [...level.denyDirs],
	};
}

export const SecuritySection = forwardRef<SecuritySectionHandle, SecuritySectionProps>(
	function SecuritySection({ onDirtyChange }, ref) {
		const [config, setConfig] = useState<SecurityConfig>(() => createDefaultSecurityConfig());
		const [loading, setLoading] = useState(true);
		const [saving, setSaving] = useState(false);
		const [dirty, setDirty] = useState(false);
		const [expandedLevelId, setExpandedLevelId] = useState<string | null>(null);
		const [error, setError] = useState<string | null>(null);

		useEffect(() => {
			let cancelled = false;
			api.security
				.getConfig()
				.then((loaded) => {
					if (cancelled) return;
					setConfig(loaded);
				})
				.catch((e: unknown) => {
					if (!cancelled) setError(e instanceof Error ? e.message : String(e));
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
			return () => {
				cancelled = true;
			};
		}, []);

		// dirty 变化上报父级（ConfigModal 顶部统一保存按钮的黄点/可用态依赖它）
		useEffect(() => {
			onDirtyChange?.(dirty);
		}, [dirty, onDirtyChange]);

		// 组件卸载（切换 tab / 关闭弹框）时上报 false，避免父级残留“假脏”标记
		useEffect(() => {
			return () => onDirtyChange?.(false);
		}, [onDirtyChange]);

	const updateLevel = useCallback((levelId: string, patch: Partial<SecurityLevelConfig>) => {
		setConfig((current) => ({
			...current,
			levels: current.levels.map((level) =>
				level.id === levelId ? { ...cloneLevel(level), ...patch } : level,
			),
		}));
		setDirty(true);
	}, []);

	const handleSave = useCallback(async (): Promise<boolean> => {
		// 防重入：保存进行中忽略再次触发（顶部按钮与关闭确认可能并发点击）
		if (saving) return false;
		setSaving(true);
		setError(null);
		try {
			const result = await api.security.updateConfig({
				enabled: config.enabled,
				defaultLevelId: config.defaultLevelId,
				levels: config.levels,
			});
			if (!result.ok) {
				setError(result.error);
				return false;
			}
			setConfig(result.config);
			setDirty(false);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	}, [config, saving]);

	// 供父级顶部统一保存按钮调用（saveByKey → security）
	useImperativeHandle(ref, () => ({ save: () => handleSave() }), [handleSave]);

	const handleReset = useCallback(() => {
		setConfig(createDefaultSecurityConfig());
		setDirty(true);
	}, []);

	const handleAddCustom = useCallback(() => {
		const base = config.levels.find((level) => level.id === "standard") ?? config.levels[0];
		const stamp = Date.now().toString(36).slice(-4);
		const next: SecurityLevelConfig = {
			...cloneLevel(base),
			id: `custom-${stamp}`,
			name: `${t("security.customLevelName")} ${stamp}`,
			description: "",
			builtin: false,
		};
		setConfig((current) => ({ ...current, levels: [...current.levels, next] }));
		setExpandedLevelId(next.id);
		setDirty(true);
	}, [config.levels]);

	const handleDeleteLevel = useCallback((levelId: string) => {
		setConfig((current) => {
			const levels = current.levels.filter((level) => level.id !== levelId);
			// 删除的等级若为默认等级，回退 standard（保证 defaultLevelId 始终有效）
			const defaultLevelId =
				current.defaultLevelId === levelId ? "standard" : current.defaultLevelId;
			return { ...current, levels, defaultLevelId };
		});
		setDirty(true);
	}, []);

	const builtinCount = useMemo(
		() => config.levels.filter((level) => level.builtin).length,
		[config.levels],
	);

	if (loading) {
		return <div className="py-12 text-center text-control text-muted-foreground">{t("common.loading")}</div>;
	}

	return (
		<div className="security-section flex flex-col gap-4">
			{/* 总开关 */}
			<div className="security-header flex items-start justify-between gap-3 rounded-md border border-border/60 bg-muted/30 p-3.5">
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-control font-semibold">
						{t("security.enabledTitle")}
					</div>
					<p className="mt-1 text-micro leading-relaxed text-muted-foreground">
						{t("security.enabledHint")}
					</p>
				</div>
				<Switch
					checked={config.enabled}
					onCheckedChange={(checked) => {
						setConfig((current) => ({ ...current, enabled: checked }));
						setDirty(true);
					}}
					aria-label={t("security.enabledTitle")}
				/>
			</div>

			{/* 全局默认等级 */}
			<div className="security-default flex items-center justify-between gap-3">
				<label className="text-control font-medium" htmlFor="security-default-level">
					{t("security.defaultLevelTitle")}
				</label>
				<Select
					value={config.defaultLevelId}
					onValueChange={(value) => {
						setConfig((current) => ({ ...current, defaultLevelId: value }));
						setDirty(true);
					}}
				>
					<SelectTrigger id="security-default-level" className="w-52">
						<SelectValue placeholder={t("security.selectLevel")} />
					</SelectTrigger>
					<SelectContent>
						{config.levels.map((level) => (
							<SelectItem key={level.id} value={level.id}>
								{level.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* 等级列表 */}
			<div className="security-levels flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<span className="text-micro font-semibold text-muted-foreground">{t("security.levelsTitle")}</span>
					<div className="flex gap-1.5">
						<Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
							{t("security.reset")}
						</Button>
						<Button variant="secondary" size="sm" onClick={handleAddCustom} disabled={saving}>
							{t("security.addLevel")}
						</Button>
					</div>
				</div>
				{config.levels.map((level) => (
					<SecurityLevelCard
						key={level.id}
						level={level}
						expanded={expandedLevelId === level.id}
						onToggle={() => setExpandedLevelId(expandedLevelId === level.id ? null : level.id)}
						onChange={(patch) => updateLevel(level.id, patch)}
						onDelete={() => handleDeleteLevel(level.id)}
						isOnlyBuiltin={builtinCount === 1 && level.builtin === true}
					/>
				))}
			</div>

			{error && (
				<div className="rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">
					{error}
				</div>
			)}
		</div>
	);
});

/** 单个等级卡片：折叠态显示摘要，展开态编辑全部字段。 */
function SecurityLevelCard(props: {
	level: SecurityLevelConfig;
	expanded: boolean;
	onToggle: () => void;
	onChange: (patch: Partial<SecurityLevelConfig>) => void;
	onDelete: () => void;
	/** 内置等级仅剩一个时禁止删除（保证至少保留一档） */
	isOnlyBuiltin: boolean;
}) {
	const { level, expanded, onToggle, onChange } = props;
	const toolSummary = TOOL_ORDER.map((tool) => {
		const action = level.toolActions[tool] ?? level.defaultAction;
		return `${tool}:${action}`;
	}).join(" · ");

	return (
		<div className="security-level-card rounded-md border border-border/60 bg-card">
			<div className="flex items-center gap-2 px-3 py-2">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={onToggle}
				>
					<span className="truncate text-control font-semibold">{level.name}</span>
					{level.builtin && (
						<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
							{t("security.builtinBadge")}
						</span>
					)}
					{!expanded && (
						<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
							{level.description || toolSummary}
						</span>
					)}
				</button>
				{!level.builtin && (
					<Button
						variant="ghost"
						size="icon-sm"
						className="size-6 text-muted-foreground hover:text-danger"
						aria-label={t("common.delete")}
						title={t("common.delete")}
						disabled={props.isOnlyBuiltin}
						onClick={props.onDelete}
					>
						<Trash2 size={13} aria-hidden="true" />
					</Button>
				)}
			</div>

			{expanded && (
				<div className="flex flex-col gap-3 border-t border-border/40 px-3 py-3">
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.levelName")}</label>
							<Input
								value={level.name}
								onChange={(e) => onChange({ name: e.target.value })}
								disabled={level.builtin}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.levelDescription")}</label>
							<Input
								value={level.description}
								onChange={(e) => onChange({ description: e.target.value })}
							/>
						</div>
					</div>

					{/* 工具动作表 */}
					<div className="flex flex-col gap-1">
						<span className="text-micro text-muted-foreground">{t("security.toolActionsTitle")}</span>
						<div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
							{TOOL_ORDER.map((tool) => (
								<div key={tool} className="flex items-center justify-between gap-2">
									<span className="text-control text-muted-foreground">
										{t(`security.tool.${tool}`)}
									</span>
									<Select
										value={level.toolActions[tool] ?? level.defaultAction}
										onValueChange={(value) =>
											onChange({ toolActions: { ...level.toolActions, [tool]: value as SecurityAction } })
										}
									>
										<SelectTrigger className="h-7 w-24">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{ACTION_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							))}
						</div>
						<p className="text-micro text-muted-foreground/80">{t("security.toolActionsHint")}</p>
					</div>

					{/* bash 危险命令 */}
					<div className="flex flex-col gap-1">
						<label className="text-micro text-muted-foreground">{t("security.denyBashTitle")}</label>
						{/*
						 * 行列表输入框（危险命令/允许目录/禁止目录）转换时只 trim、不 filter 空行：
						 * 若把尾部空行滤掉，受控 value 由数组 join("
") 回填会吞掉刚敲的回车
						 * （表现为「结尾没法回车，只能中间回车」）。空行由主进程
						 * SecurityStore.normalizeConfig → sanitizeLineList 收敛，不落入策略。
						 */}
						<Textarea
							rows={4}
							className="font-mono text-micro"
							placeholder={t("security.denyBashPlaceholder")}
							value={level.denyBashPatterns.join("\n")}
							onChange={(e) =>
								onChange({
									denyBashPatterns: e.target.value
										.split("\n")
										.map((line) => line.trim())
								})
							}
						/>
					</div>

					{/* 目录边界 */}
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.pathPolicyTitle")}</label>
							<Select
								value={level.pathPolicy}
								onValueChange={(value) => onChange({ pathPolicy: value as SecurityPathPolicy })}
							>
								<SelectTrigger className="h-8">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="unrestricted">{t("security.pathPolicy.unrestricted")}</SelectItem>
									<SelectItem value="workspace">{t("security.pathPolicy.workspace")}</SelectItem>
									<SelectItem value="custom">{t("security.pathPolicy.custom")}</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.defaultActionTitle")}</label>
							<Select
								value={level.defaultAction}
								onValueChange={(value) => onChange({ defaultAction: value as SecurityAction })}
							>
								<SelectTrigger className="h-8">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ACTION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{level.pathPolicy === "custom" && (
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.customAllowDirsTitle")}</label>
							<Textarea
								rows={2}
								className="font-mono text-micro"
								placeholder={t("security.dirsPlaceholder")}
								value={level.customAllowDirs.join("\n")}
								onChange={(e) =>
									onChange({
										customAllowDirs: e.target.value
											.split("\n")
											.map((line) => line.trim())
									})
								}
							/>
						</div>
					)}

					<div className="flex flex-col gap-1">
						<label className="text-micro text-muted-foreground">{t("security.denyDirsTitle")}</label>
						<Textarea
							rows={2}
							className="font-mono text-micro"
							placeholder={t("security.dirsPlaceholder")}
							value={level.denyDirs.join("\n")}
							onChange={(e) =>
								onChange({
									denyDirs: e.target.value
										.split("\n")
										.map((line) => line.trim())
								})
							}
						/>
					</div>

					<div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2">
						<span className="text-control text-muted-foreground">{t("security.protectSensitiveTitle")}</span>
						<Switch
							checked={level.protectSensitivePaths}
							onCheckedChange={(checked) => onChange({ protectSensitivePaths: checked })}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

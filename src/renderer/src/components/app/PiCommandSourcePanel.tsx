import { useState } from "react";
import { Check, FolderOpen, Pencil, Plus, RefreshCw, Terminal, Trash2 } from "lucide-react";
import type { PiInstallation } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { installationRowActions, groupInstallations, piInstallationBadge, piInstallationBadgeKey, piInstallationSourceKey, piInstallationVersionKey, piInstallationVersionNoteKey } from "../../utils/piInstallationOptions";

/**
 * pi 命令来源面板：**一块列表同时管“系统里有哪些 pi”和“我自己加的路径”**。
 *
 * 为什么合并（2026-09-30 设置页改造）：原先拆成「自定义 pi 路径」（一个输入框 + 浏览/校验/清除）
 * 与「检测到的 pi 安装」（另一个列表 + 又一组浏览按钮），同一个动作出现在两处，
 * 用户不知道该看哪个；而且自定义路径只能存一条、存进去就看不到它和别的关系。
 * 合并后：来源只是行上的标签，用户看的是「PiDeck 能用哪几个 pi」。
 *
 * 职责边界：只做呈现与局部编辑态（哪一行在编辑、添加框是否展开），
 * 校验/落盘/切换全部走 props 给的命令（由 usePiUpdate 统一管状态与 IPC）。
 */
export type PiCommandSourcePanelProps = {
	installations: PiInstallation[];
	/** 正在校验的路径（该行/该按钮 loading） */
	applyingPath?: string | null;
	/** 切换为当前使用 */
	onChoose: (path: string) => void;
	/** 添加一条自定义路径（校验 → 入池 → 立即使用）；不传 = 只读模式（环境弹窗首启引导） */
	onAddCustomPath?: (path: string) => Promise<void> | void;
	/** 编辑一条自定义路径（原地替换，保留位置） */
	onUpdateCustomPath?: (previousPath: string, nextPath: string) => Promise<void> | void;
	/** 移除一条自定义路径 */
	onRemoveCustomPath?: (path: string) => Promise<void> | void;
	/** 系统文件选择器挑 pi 可执行文件（走添加流程） */
	onBrowse?: () => void;
	browsing?: boolean;
	/** 重新扫描本机安装 */
	onRecheck?: () => void;
	rechecking?: boolean;
	/** 反查交互式登录 shell（zsh / 自定义 PATH 场景） */
	onShellProbe?: () => void;
	shellProbing?: boolean;
	/** dialog = 环境弹窗内的紧凑卡片；settings = 设置页内的管理面板 */
	variant: "dialog" | "settings";
};

export function PiCommandSourcePanel(props: PiCommandSourcePanelProps) {
	const { installations, variant } = props;
	const manageable = typeof props.onAddCustomPath === "function";
	const [adding, setAdding] = useState(false);
	const [draftPath, setDraftPath] = useState("");
	const [editingPath, setEditingPath] = useState<string | null>(null);
	const [editingDraft, setEditingDraft] = useState("");
	const { detected, userAdded } = groupInstallations(installations);
	const hasNewest = installations.some((item) => item.isNewest);
	// 设置页里安装可能有十几份（nvm/mise/pnpm 各自的 shim 都算）：限高滚动，别把整页顶下去。
	// 子项带 shrink-0：限高 flex 列里子项默认会被压缩。
	const listClass = variant === "settings" ? "m-0 flex max-h-64 list-none flex-col gap-1 overflow-y-auto p-0 pr-1" : "m-0 flex list-none flex-col gap-1 p-0";

	const submitAdd = async () => {
		const value = draftPath.trim();
		if (!value || !props.onAddCustomPath) return;
		// 先收起输入框：命令失败时由 hook 弹提示，成功时列表会多出一行。
		await props.onAddCustomPath(value);
		setDraftPath("");
		setAdding(false);
	};

	const submitEdit = async () => {
		const previous = editingPath;
		const next = editingDraft.trim();
		setEditingPath(null);
		if (!previous || !next || next === previous || !props.onUpdateCustomPath) return;
		await props.onUpdateCustomPath(previous, next);
	};

	return (
		<div className="flex flex-col gap-2.5">
			{variant === "dialog" && (
				<div className="flex flex-col gap-1">
					<strong className="text-text-primary text-control">{t("environment.installsTitle", { count: installations.length })}</strong>
					<small className="text-text-secondary text-caption leading-relaxed">{t("environment.installsDesc")}</small>
				</div>
			)}

			{/* 动作行：检测/反查/重置检测标记（设置页）与添加路径 */}
			{variant === "settings" && (
				<div className="flex flex-wrap items-center gap-2">
					{props.onRecheck && (
						<Button variant="outline" size="sm" className="h-auto gap-1.5 px-3 py-1.5 shadow-none" onClick={props.onRecheck} disabled={props.rechecking}>
							<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
							{t("environment.installsRecheck")}
						</Button>
					)}
					{props.onShellProbe && (
						<Button variant="outline" size="sm" className="h-auto gap-1.5 px-3 py-1.5 shadow-none" onClick={props.onShellProbe} disabled={props.shellProbing}>
							<Terminal size={14} strokeWidth={2} aria-hidden="true" />
							{t("environment.installsShellProbe")}
						</Button>
					)}
					{manageable && (
						<Button variant="outline" size="sm" className="h-auto gap-1.5 px-3 py-1.5 shadow-none" onClick={() => setAdding((prev) => !prev)}>
							<Plus size={14} strokeWidth={2} aria-hidden="true" />
							{t("environment.installsAdd")}
						</Button>
					)}
				</div>
			)}

			{/* 添加表单：粘贴或浏览，校验通过才入列表 */}
			{manageable && adding && (
				<div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-panel px-3 py-2.5">
					<small className="text-text-secondary text-caption leading-relaxed">{t("environment.installsAddHint")}</small>
					<div className="flex flex-wrap items-center gap-2">
						<Input type="text" className="min-w-[220px] flex-1" value={draftPath} placeholder="/usr/local/bin/pi" onChange={(event) => setDraftPath(event.target.value)} />
						{props.onBrowse && (
							<Button variant="outline" size="sm" className="h-auto gap-1.5 px-3 py-1.5 shadow-none" onClick={props.onBrowse} disabled={props.browsing}>
								<FolderOpen size={14} strokeWidth={2} aria-hidden="true" />
								{t("environment.installsBrowse")}
							</Button>
						)}
						<Button variant="default" size="sm" className="h-auto px-3 py-1.5 shadow-none" onClick={() => void submitAdd()} disabled={!draftPath.trim() || props.applyingPath === draftPath.trim()}>
							{t("environment.installsAddConfirm")}
						</Button>
					</div>
				</div>
			)}

			{/* 自动检测到的安装 */}
			{variant === "settings" && detected.length > 0 && <small className="text-text-tertiary text-caption">{t("environment.installsAutoDetected")}</small>}
			<ul className={listClass}>
				{detected.map((installation) => (
					<InstallationRow key={installation.path} installation={installation} applyingPath={props.applyingPath} onChoose={props.onChoose} onUpdateCustomPath={props.onUpdateCustomPath} onRemoveCustomPath={props.onRemoveCustomPath} variant={variant} hasNewest={hasNewest} />
				))}
			</ul>

			{/* 用户自己添加的路径 */}
			{variant === "settings" && userAdded.length > 0 && <small className="text-text-tertiary text-caption">{t("environment.installsUserAdded")}</small>}
			<ul className={listClass}>
				{userAdded.map((installation) => (
					<InstallationRow
						key={installation.path}
						installation={installation}
						applyingPath={props.applyingPath}
						onChoose={props.onChoose}
						onUpdateCustomPath={props.onUpdateCustomPath}
						onRemoveCustomPath={props.onRemoveCustomPath}
						variant={variant}
						hasNewest={hasNewest}
						editing={editingPath === installation.path}
						editingDraft={editingDraft}
						onEditingDraftChange={setEditingDraft}
						onStartEditing={() => {
							setEditingPath(installation.path);
							setEditingDraft(installation.path);
						}}
						onCancelEditing={() => setEditingPath(null)}
						onSubmitEditing={() => void submitEdit()}
					/>
				))}
			</ul>

			{/* 环境弹窗（首启引导）里的只读动作行：添加/编辑交给设置页，这里只解决「用哪份」 */}
			{(props.onShellProbe || props.onBrowse) && variant === "dialog" && (
				<div className="flex flex-wrap items-center gap-2">
					{props.onBrowse && (
						<Button variant="outline" size="sm" className="h-auto gap-1.5 px-3 py-1.5 text-caption shadow-none" onClick={props.onBrowse} disabled={props.browsing}>
							<FolderOpen size={13} strokeWidth={2} aria-hidden="true" />
							{t("environment.installsBrowse")}
						</Button>
					)}
					{props.onShellProbe && (
						<Button variant="outline" size="sm" className="h-auto gap-1.5 px-3 py-1.5 text-caption shadow-none" onClick={props.onShellProbe} disabled={props.shellProbing}>
							<Terminal size={13} strokeWidth={2} aria-hidden="true" />
							{props.shellProbing ? t("environment.installsApplying") : t("environment.installsShellProbe")}
						</Button>
					)}
					{variant === "dialog" && <small className="text-text-tertiary text-caption">{t("environment.installsShellProbeHint")}</small>}
				</div>
			)}
		</div>
	);
}

type InstallationRowProps = {
	installation: PiInstallation;
	applyingPath?: string | null;
	onChoose: (path: string) => void;
	onUpdateCustomPath?: (previousPath: string, nextPath: string) => Promise<void> | void;
	onRemoveCustomPath?: (path: string) => Promise<void> | void;
	variant: "dialog" | "settings";
	hasNewest: boolean;
	editing?: boolean;
	editingDraft?: string;
	onEditingDraftChange?: (value: string) => void;
	onStartEditing?: () => void;
	onCancelEditing?: () => void;
	onSubmitEditing?: () => void;
};

function InstallationRow(props: InstallationRowProps) {
	const { installation, variant } = props;
	const actions = installationRowActions(installation);
	const badge = piInstallationBadge(installation);
	const badgeKey = piInstallationBadgeKey(badge);
	const versionNoteKey = badge ? null : piInstallationVersionNoteKey(installation, props.hasNewest);
	const versionKey = piInstallationVersionKey(installation);
	const applying = props.applyingPath === installation.path;
	const compact = variant === "dialog";

	// 行内编辑：只有用户自己添加的路径可以改（自动发现的是系统事实，改它没有意义）。
	if (props.editing) {
		return (
			<li className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-panel px-3 py-2">
				<Input type="text" className="w-full font-mono" value={props.editingDraft ?? ""} onChange={(event) => props.onEditingDraftChange?.(event.target.value)} />
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="default" size="sm" className="h-auto px-3 py-1.5 shadow-none" onClick={props.onSubmitEditing} disabled={applying || !(props.editingDraft ?? "").trim()}>
						{t("environment.installsEditConfirm")}
					</Button>
					<Button variant="ghost" size="sm" className="h-auto px-2 py-1.5 shadow-none" onClick={props.onCancelEditing}>
						{t("environment.installsEditCancel")}
					</Button>
				</div>
			</li>
		);
	}

	return (
		<li className="flex shrink-0 items-center gap-3 rounded-md border border-border-subtle bg-bg-panel px-2.5 py-1.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-1.5">
					{/* 路径是主角：单行截断，完整值进 title，不让它把卡片撑高 */}
					<code className="min-w-0 flex-1 truncate font-mono text-text-primary text-caption" title={installation.path}>
						{installation.path}
					</code>
					{/* 只显示一个徽章（当前使用 > 终端默认 > 较新） */}
					{badgeKey && (
						<span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-0.5 text-text-primary text-caption">
							{badge === "active" && <Check size={11} strokeWidth={3} aria-hidden="true" />}
							{t(badgeKey)}
						</span>
					)}
					{installation.missing && <span className="shrink-0 text-danger text-caption">{t("environment.installMissing")}</span>}
				</div>
				{/* 来源 / 版本 / 版本提示挤在同一行：以前各占一行，四份安装就占满一整屏 */}
				<div className="flex min-w-0 items-center gap-1.5 text-text-tertiary text-caption">
					<span className="truncate">{t(piInstallationSourceKey(installation.source))}</span>
					<span className="shrink-0" aria-hidden="true">
						·
					</span>
					<span className="shrink-0">{installation.version ? `v${installation.version}` : t(versionKey ?? "environment.installVersionUnknown")}</span>
					{versionNoteKey && <span className="shrink-0">· {t(versionNoteKey)}</span>}
					{installation.managedRoot && <span className="truncate">· {installation.managedRoot}</span>}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1">
				{actions.canUse && (
					<Button variant="secondary" size="sm" className="h-auto shrink-0 px-2.5 py-1 shadow-none" onClick={() => props.onChoose(installation.path)} disabled={applying || installation.missing}>
						{applying ? t("environment.installsApplying") : t("environment.installsUse")}
					</Button>
				)}
				{/* 编辑/移除只对「我添加的」开放：自动发现的项是系统事实，不给改 */}
				{actions.canEdit && props.onStartEditing && !compact && (
					<>
						<Button variant="ghost" size="sm" className="h-auto gap-1 px-1.5 py-1 text-text-secondary text-caption shadow-none" onClick={props.onStartEditing} aria-label={t("environment.installsEdit")} title={t("environment.installsEdit")}>
							<Pencil size={13} strokeWidth={2} aria-hidden="true" />
							{t("environment.installsEdit")}
						</Button>
						{props.onRemoveCustomPath && (
							<Button variant="ghost" size="sm" className="h-auto gap-1 px-1.5 py-1 text-text-secondary text-caption shadow-none" onClick={() => void props.onRemoveCustomPath?.(installation.path)} aria-label={t("environment.installsRemove")} title={t("environment.installsRemove")}>
								<Trash2 size={13} strokeWidth={2} aria-hidden="true" />
								{t("environment.installsRemove")}
							</Button>
						)}
					</>
				)}
			</div>
		</li>
	);
}

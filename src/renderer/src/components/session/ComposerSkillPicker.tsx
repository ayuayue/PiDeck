import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { ChevronLeft, CornerDownLeft, Eye, Loader2, Sparkles } from "lucide-react";
import { toSkillInvocationToken } from "../../composerBehavior";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { projectByIdAtomFamily } from "../../atoms";
import type { AgentBackend, DshSkillView } from "../../../../shared/types";
import { emptyProjectResourceDiscovery, type SkillCatalogEntry, mergePiSkillCatalog } from "../../../../shared/skillCatalog";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui-shadcn/command";
import { Button } from "../ui-shadcn/button";
import { PickerDialog } from "./ComposerComponents";
import { showNotice } from "../../utils/notice";

/** 选择面板条目直接复用 shared/skillCatalog 的统一模型（pi 与 DSH 同一形状）。 */
type SkillItem = SkillCatalogEntry;

/** 技能详情预览态：正文懒加载（点击眼睛/插入时才读 SKILL.md，列表加载不背文件 IO）。 */
type SkillDetailState = {
	item: SkillItem;
	loading: boolean;
	content?: string;
	error: string | null;
};

export function ComposerSkillPicker(props: {
	/** 按会话后端选数据源：pi = 项目资源技能 + 全局技能，dsh = DSH 部署技能目录。 */
	backend: AgentBackend;
	/** pi 后端需要项目 ID 才能读取项目技能。 */
	projectId?: string;
	/** DSH 运行中会话的 Agent（skill.list 走 runtime wire，含活跃会话的实时命令）。 */
	agentId?: string;
	/** 会话记录 id：DSH 没有运行中 agent 时用它读目录（共享文件扫描 + host 权威结果并集，不要求会话启动）。 */
	sessionId?: string;
	onClose: () => void;
	onPick: (name: string) => void;
	/** 一键插入技能正文到输入框（controller insertSkillContent）；传了才显示插入按钮。 */
	onInsertContent?: (content: string) => void;
}) {
	const [items, setItems] = useState<SkillItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [detail, setDetail] = useState<SkillDetailState | null>(null);

	// 数据源随后端分叉：pi 走 projectResources.list（项目技能）+ skills.list
	// （全局技能：~/.pi/agent/skills 与 ~/.agents/skills），DSH 走 listDshSkills
	// （G7 skill.list 只读目录）。DSH 运行中会话传 agentId；草稿会话传 { sessionId }
	// （主进程懒建/复用 host 会话，不启动 agent），已激活但无 runtime 的历史会话
	// 仍要求先启动（不能换新 host id）。pi 无项目时仍能读全局技能（不整面板阻塞）。
	// 内置聊天项目（builtin-chat）没有项目级资源目录：不发起 project-resources:list
	// （后端虽已对 chat 返回空结果兜底，前端直接跳过可省一次 IPC 并避免把
	// 「项目技能」这类概念混进纯聊天上下文）。inventory 未加载时 kind 未知，
	// 仍按有项目处理，由后端空结果兜底，不会报错。
	const chatProject = useAtomValue(projectByIdAtomFamily(props.projectId ?? ""));
	const isChatSessionProject = chatProject?.kind === "chat";
	// 内置聊天项目没有项目级资源目录，不发起 project-resources:list；inventory 未加载时
	// kind 未知，仍按有项目处理，由后端对 chat 返回空结果兜底，不会报错。
	const hasProjectResources = Boolean(props.projectId) && !isChatSessionProject;
	// DSH 没有运行中 agent 时也能读目录：主进程先扫描本地技能根（通用 SKILL.md 逻辑），
	// 能拿到 host 权威列表时再做并集（preset/插件技能不漏）。引导页等虚拟会话 id
	// （renderer: 前缀）没有 catalog 记录，仍走「启动后可读」提示。
	const dshCatalogSessionId = props.backend === "dsh" && !props.agentId && props.sessionId && !props.sessionId.startsWith("renderer:") ? props.sessionId : undefined;

	useEffect(() => {
		if (props.backend === "dsh" && !props.agentId && !dshCatalogSessionId) {
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		const load =
			props.backend === "pi"
				? Promise.all([
						hasProjectResources ? desktopApi.projectResources.list(props.projectId as string).then((result) => result.skills) : Promise.resolve([]),
						desktopApi.skills.list().then((result) => result.skills),
						desktopApi.projectResources.discovery(props.projectId).catch(() => emptyProjectResourceDiscovery()),
					]).then(([projectSkills, globalSkills, discovery]) => mergePiSkillCatalog({ projectSkills, globalSkills, discovery }))
				: (async (): Promise<SkillItem[]> => {
						// 运行中会话按 agentId 读（runtime 权威）；无 runtime 时按 catalog sessionId 读
						// （文件扫描 + host 结果并集）。两者都没有时上面已提前 return。
						const target = props.agentId !== undefined ? props.agentId : dshCatalogSessionId !== undefined ? { sessionId: dshCatalogSessionId } : undefined;
						if (target === undefined) return [];
						const list: DshSkillView[] = await desktopApi.sessions.listDshSkills(target);
						return list.map<SkillItem>((skill) => ({
							name: skill.name,
							description: skill.description,
							whenToUse: skill.whenToUse,
							userOnly: !skill.modelInvocable,
						}));
					})();
		void load
			.then((next) => {
				if (!cancelled) setItems(next);
			})
			.catch((reason) => {
				if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [hasProjectResources, isChatSessionProject, props.backend, props.projectId, props.agentId, dshCatalogSessionId]);

	/** 读技能正文：白名单校验在主进程（只允许全局/项目技能位置），渲染层只传 path。 */
	function readContent(item: SkillItem): Promise<string | undefined> {
		if (!item.path) return Promise.resolve(undefined);
		return desktopApi.skills.readContent(item.path).then((result) => result.content);
	}

	/** 点眼睛打开详情：懒加载正文，失败时内联展示原因（与列表加载失败同款 detail）。 */
	function openDetail(item: SkillItem) {
		setDetail({ item, loading: true, error: null });
		void readContent(item)
			.then((content) => {
				setDetail((prev) => (prev?.item.name === item.name ? { item, content, loading: false, error: null } : prev));
			})
			.catch((reason) => {
				setDetail((prev) =>
					prev?.item.name === item.name
						? {
								item,
								loading: false,
								error: reason instanceof Error ? reason.message : String(reason),
							}
						: prev,
				);
			});
	}

	/** 一键插入正文：点击时先读 SKILL.md 再整段塞进输入框（读失败给 toast 定位）。 */
	function insertContent(item: SkillItem) {
		void readContent(item)
			.then((content) => {
				if (content !== undefined) props.onInsertContent?.(content);
			})
			.catch((reason) => {
				showNotice(reason instanceof Error ? reason.message : String(reason), 4000);
			});
	}

	// 详情预览态：替换列表为「返回 + 正文」（复用 prompt picker 的内联预览设计）
	if (detail) {
		return (
			<PickerDialog title={t("app.skillPreviewTitle", { name: "/" + detail.item.name })} onClose={props.onClose} className="skill-picker">
				<div className="picker-preview-inline">
					<div className="flex items-center justify-between gap-2">
						<Button type="button" variant="ghost" className="h-auto gap-1 px-1 text-caption" onClick={() => setDetail(null)} title={t("app.skillPreviewBack")}>
							<ChevronLeft size={16} strokeWidth={2.2} />
							{t("app.skillPreviewBack")}
						</Button>
						{/* 预览里同样可以一键插入全文（与条目上的插入按钮入口并列） */}
						{props.onInsertContent && (
							<Button type="button" variant="outline" size="sm" className="h-7 gap-1" disabled={!detail.content} onClick={() => detail.content !== undefined && props.onInsertContent?.(detail.content)} title={t("app.pickerInsertContent")}>
								<CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
								{t("app.pickerInsertContent")}
							</Button>
						)}
					</div>
					{detail.loading ? (
						<div className="flex items-center justify-center gap-2 py-6 text-caption text-muted-foreground">
							<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
							{t("app.skillPickerLoading")}
						</div>
					) : detail.error ? (
						/* 正文读取失败：通用文案走 i18n，原始错误只作内部详情辅助排查。 */
						<div className="flex flex-col items-center gap-1.5 px-4 py-6 text-caption">
							<span className="font-medium text-foreground">{t("app.skillContentLoadFailed")}</span>
							<span className="text-muted-foreground">{t("app.skillPickerLoadFailedNote")}</span>
							<pre className="max-h-28 w-full overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-micro leading-relaxed text-muted-foreground">{detail.error}</pre>
						</div>
					) : (
						<pre className="picker-preview-content">{detail.content}</pre>
					)}
				</div>
			</PickerDialog>
		);
	}

	// DSH 且没有运行中 Agent、也没有 catalog 会话（如引导页虚拟会话）：给定位原因而非误报为空。
	const blockedByAgent = props.backend === "dsh" && !props.agentId && !dshCatalogSessionId;
	// pi 无项目资源（无普通项目 / 内置聊天项目）：只显示全局技能，不阻塞；
	// 区分提示语让用户知道当前范围。
	const globalOnly = props.backend === "pi" && !hasProjectResources;

	return (
		<PickerDialog title={t("app.skillPickerTitle")} hint={t("app.skillPickerHint")} onClose={props.onClose} className="skill-picker">
			<Command>
				<CommandInput placeholder={t("app.skillPickerSearchPlaceholder")} autoFocus />
				<CommandList className="max-h-[min(420px,55vh)]">
					{/* cmdk 的 Empty 只在列表有数据且过滤后无匹配时才有意义；
					    loading/出错/缺上下文等非列表态由下方自定义块承担，避免双提示。 */}
					{!loading && !error && !blockedByAgent && <CommandEmpty>{t("app.skillPickerSearchEmpty")}</CommandEmpty>}
					{loading ? (
						<div className="flex items-center justify-center gap-2 py-6 text-caption text-muted-foreground">
							<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
							{t("app.skillPickerLoading")}
						</div>
					) : error ? (
						/* 加载失败给出原因详情（skill.list 会抛真实错误）：通用文案走 i18n，
						   原始错误信息只作内部详情展示，辅助排查（如 pi 技能目录损坏/DSH wire 失败）。 */
						<div className="flex flex-col items-center gap-1.5 px-4 py-6 text-caption">
							<span className="font-medium text-foreground">{t("app.skillPickerLoadFailed")}</span>
							<span className="text-muted-foreground">{t("app.skillPickerLoadFailedNote")}</span>
							{error && <pre className="max-h-28 w-full overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-micro leading-relaxed text-muted-foreground">{error}</pre>}
						</div>
					) : blockedByAgent ? (
						<div className="px-6 py-10 text-center text-caption text-muted-foreground">{t("app.skillPickerNoAgent")}</div>
					) : items.length === 0 ? (
						/* 区分三种空态：chat 项目/无项目时只可能是全局为空；有项目时是项目+全局都为空。 */
						<div className="px-6 py-10 text-center text-caption text-muted-foreground">{globalOnly ? (isChatSessionProject ? t("app.skillPickerChatProject") : t("app.skillPickerNoProject")) : t("app.skillPickerEmpty")}</div>
					) : (
						items.map((skill) => (
							/* 双行条目与 prompt/模型选择器对齐：首行图标 + 真实斜杠命令 + 徽标，
							   次行描述截断 + 右侧详情/插入按钮。旧 picker-palette-* 单行排版弃用。 */
							<CommandItem key={skill.name} value={`/${skill.name}`} keywords={[skill.name, skill.description, skill.whenToUse ?? "", toSkillInvocationToken(props.backend, skill.name)]} onSelect={() => props.onPick(skill.name)} className="group min-h-10 items-center gap-2.5 rounded-md px-3 py-2">
								<span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/70 text-muted-foreground">
									<Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-1.5">
										{/* 展示与真实调用命令一致的斜杠形态：pi 是 /skill:名称，DSH 是 /名称。
										    让用户看到的就是插入后会在草稿里出现的内容，避免选了却调不动的困惑。 */}
										<span className="truncate font-mono text-control font-semibold text-foreground" title={`/${toSkillInvocationToken(props.backend, skill.name)}`}>
											/{toSkillInvocationToken(props.backend, skill.name)}
										</span>
										{/* 来源徽标：全局 / 项目（title 显示完整目录），让用户知道技能从哪里来 */}
										{skill.source && (
											<span className="shrink-0 inline-flex items-center rounded bg-sky-500/12 px-1.5 py-0.5 text-micro font-medium text-sky-600 dark:text-sky-400" title={skill.sourceLabel}>
												{skill.source === "global" ? t("app.skillBadgeGlobal") : t("app.skillBadgeProject")}
											</span>
										)}
										{skill.userOnly && <span className="shrink-0 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-micro font-medium text-amber-600 dark:text-amber-400">{t("dshTools.skillUserOnly")}</span>}
									</span>
									{skill.description && (
										<span className="mt-0.5 block truncate text-caption text-muted-foreground" title={skill.description}>
											{skill.description}
										</span>
									)}
								</span>
								{/* 详情（眼睛）与一键插入：仅 pi 技能有正文读取通道时才显示；DSH 技能由宿主管理。 */}
								{skill.path && (
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										title={t("common.preview")}
										onClick={(e) => {
											e.stopPropagation();
											openDetail(skill);
										}}
									>
										<Eye size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
								)}
								{skill.path && props.onInsertContent && (
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										title={t("app.pickerInsertContent")}
										onClick={(e) => {
											e.stopPropagation();
											insertContent(skill);
										}}
									>
										<CornerDownLeft size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
								)}
							</CommandItem>
						))
					)}
				</CommandList>
			</Command>
		</PickerDialog>
	);
}

/**
 * Web 端技能/扩展资产面板（第二批）：查看已装技能与扩展、开关启停。
 *
 * 与桌面设置页同源（SkillManager / ExtensionManager 经 /api/skills* /api/extensions*）。
 * 边界：只做启停，不做安装/卸载/更新（那些需要宿主操作与商店流程）。
 * 扩展开关写入配置，需重启会话生效（面板内提示）。
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Puzzle } from "lucide-react";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Switch } from "@/components/ui-shadcn/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui-shadcn/tabs";
import { listWebExtensions, listWebSkills, toggleWebExtension, toggleWebSkill, type WebExtensionSummary, type WebSkillSummary } from "./webApi";

type AssetsState = { phase: "loading" } | { phase: "ready"; skills: WebSkillSummary[]; extensions: WebExtensionSummary[]; conflicts: { builtIn: string; thirdParty: string }[] } | { phase: "error"; message: string };

export function WebSkillsExtensionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [state, setState] = useState<AssetsState>({ phase: "loading" });

	const reload = useCallback(async () => {
		setState({ phase: "loading" });
		try {
			const [skillResult, extensionResult] = await Promise.all([listWebSkills(), listWebExtensions()]);
			setState({ phase: "ready", skills: skillResult.skills, extensions: extensionResult.extensions, conflicts: extensionResult.conflicts });
		} catch (error) {
			setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}, []);

	useEffect(() => {
		if (open) void reload();
	}, [open, reload]);

	const onSkillToggle = async (skill: WebSkillSummary, enabled: boolean) => {
		// 乐观更新；失败回滚并刷新（name+sourceId 定位，后端持久化按 name）
		const snapshot = state;
		if (snapshot.phase !== "ready") return;
		setState({ ...snapshot, skills: snapshot.skills.map((item) => (item === skill ? { ...item, enabled } : item)) });
		try {
			const updated = await toggleWebSkill(skill.name, skill.sourceId, enabled);
			if (snapshot.phase === "ready") {
				setState({ ...snapshot, skills: snapshot.skills.map((item) => (item.name === updated.name && item.sourceId === updated.sourceId ? updated : item)) });
			}
		} catch {
			void reload();
		}
	};

	const onExtensionToggle = async (extension: WebExtensionSummary, enabled: boolean) => {
		const snapshot = state;
		if (snapshot.phase !== "ready") return;
		setState({ ...snapshot, extensions: snapshot.extensions.map((item) => (item === extension ? { ...item, enabled } : item)) });
		try {
			await toggleWebExtension(extension.source, enabled, extension.scope);
		} catch {
			void reload();
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* [&>*]:min-w-0：DialogContent 是 grid，直接子项默认 min-width:auto，内部 p.truncate（nowrap）
			    的 min-content 会把轨道顶宽溢出弹层右缘（移动走查 #2）；给子项归零后 truncate 正常收敛。 */}
			<DialogContent className="max-h-[80dvh] overflow-hidden sm:max-w-lg [&>*]:min-w-0">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Puzzle className="size-4" />
						{t("web.assetsTitle")}
					</DialogTitle>
				</DialogHeader>
				{state.phase === "loading" ? (
					<p className="py-8 text-center text-sm text-text-muted">{t("web.assetsLoading")}</p>
				) : state.phase === "error" ? (
					<p className="py-8 text-center text-sm text-red-500">{state.message}</p>
				) : (
					<Tabs defaultValue="skills" className="flex min-h-0 flex-col">
						<TabsList className="self-start">
							<TabsTrigger value="skills">{t("web.tabSkills")}</TabsTrigger>
							<TabsTrigger value="extensions">{t("web.tabExtensions")}</TabsTrigger>
						</TabsList>
						<TabsContent value="skills" className="min-h-0 overflow-y-auto">
							{state.skills.length === 0 ? (
								<p className="py-6 text-center text-sm text-text-muted">{t("web.skillsEmpty")}</p>
							) : (
								<ul className="flex flex-col gap-1.5">
									{state.skills.map((skill) => (
										<li key={`${skill.sourceId}:${skill.name}`} className="flex items-start gap-2 rounded-md border border-border bg-bg-surface px-2.5 py-2">
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{skill.name}
													<span className="ml-1.5 text-micro font-normal text-text-muted">{skill.sourceLabel}</span>
												</p>
												{skill.description ? <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{skill.description}</p> : null}
												{skill.warnings.length > 0 ? (
													<p className="mt-0.5 flex items-center gap-1 text-micro text-amber-500">
														<AlertTriangle className="size-3 shrink-0" />
														<span className="truncate">{skill.warnings[0]}</span>
													</p>
												) : null}
											</div>
											<Switch checked={skill.enabled} aria-label={t("web.skillToggle")} onCheckedChange={(checked) => void onSkillToggle(skill, checked)} />
										</li>
									))}
								</ul>
							)}
						</TabsContent>
						<TabsContent value="extensions" className="min-h-0 overflow-y-auto">
							<p className="mb-2 text-micro text-text-muted">{t("web.extensionRestartHint")}</p>
							{state.extensions.length === 0 ? (
								<p className="py-6 text-center text-sm text-text-muted">{t("web.extensionsEmpty")}</p>
							) : (
								<ul className="flex flex-col gap-1.5">
									{state.extensions.map((extension) => (
										<li key={extension.id} className="flex items-start gap-2 rounded-md border border-border bg-bg-surface px-2.5 py-2">
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{extension.source}
													{extension.currentVersion ? <span className="ml-1.5 text-micro font-normal text-text-muted">v{extension.currentVersion}</span> : null}
													{extension.builtIn ? <span className="ml-1.5 rounded bg-primary/10 px-1 text-micro text-primary">{t("common.builtIn")}</span> : null}
												</p>
												{state.conflicts.some((conflict) => conflict.thirdParty === extension.source) ? <p className="mt-0.5 text-micro text-amber-500">{t("web.extensionConflict", { name: state.conflicts.find((conflict) => conflict.thirdParty === extension.source)?.builtIn ?? "" })}</p> : null}
											</div>
											<Switch checked={extension.enabled ?? true} aria-label={t("web.extensionToggle")} onCheckedChange={(checked) => void onExtensionToggle(extension, checked)} />
										</li>
									))}
								</ul>
							)}
						</TabsContent>
					</Tabs>
				)}
			</DialogContent>
		</Dialog>
	);
}

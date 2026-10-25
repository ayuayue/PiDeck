import { Button } from "../components/ui-shadcn/button";
import { useState } from "react";
import { Copy, Download } from "lucide-react";
import type { PiExtensionListResult, PiExtensionSummary, PiPackageInfo } from "../../../shared/types";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";

/** PiDeck 内置扩展名 → source 文件名映射 */
const PIDEK_BUILTIN_SOURCE: Record<string, string> = {
	"pi-deck-todo": "pi-deck-todo.ts",
	"pi-deck-plan-mode": "pi-deck-plan-mode.ts",
	"pi-deck-goal-mode": "pi-deck-goal-mode.ts",
	"pi-deck-ask-question": "pi-deck-ask-question.ts",
	"pi-deck-nul-redirect-fix": "pi-deck-nul-redirect-fix.ts",
};

/** 推荐扩展包：描述走 i18n（descriptionKey），不在组件里硬编码中英文案。 */
type RecommendedPackage = Omit<PiPackageInfo, "description"> & { descriptionKey: TranslationKey };
const RECOMMENDED_PACKAGES: RecommendedPackage[] = [
	{
		name: "pi-deck-todo",
		descriptionKey: "config.extRecommended.piDeckTodo",
		installCmd: "npm:@earendil-works/pi-deck-todo",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-plan-mode",
		descriptionKey: "config.extRecommended.piDeckPlanMode",
		installCmd: "npm:@earendil-works/pi-deck-plan-mode",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-goal-mode",
		descriptionKey: "config.extRecommended.piDeckGoalMode",
		installCmd: "npm:@earendil-works/pi-deck-goal-mode",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-ask-question",
		descriptionKey: "config.extRecommended.piDeckAskQuestion",
		installCmd: "npm:@earendil-works/pi-deck-ask-question",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-nul-redirect-fix",
		descriptionKey: "config.extRecommended.piDeckNulRedirectFix",
		installCmd: "npm:@earendil-works/pi-deck-nul-redirect-fix",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "context-mode",
		descriptionKey: "config.extRecommended.contextMode",
		installCmd: "npm:context-mode",
		tags: ["extension"],
		downloads: "107K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/context-mode",
		repoUrl: "https://github.com/mksglu/context-mode",
	},
	{
		name: "pi-web-access",
		descriptionKey: "config.extRecommended.piWebAccess",
		installCmd: "npm:pi-web-access",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-web-access",
		repoUrl: "https://github.com/nicobailon/pi-web-access",
	},
	{
		name: "pi-mcp-adapter",
		descriptionKey: "config.extRecommended.piMcpAdapter",
		installCmd: "npm:pi-mcp-adapter",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
		repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
	},
	{
		name: "pi-subagents",
		descriptionKey: "config.extRecommended.piSubagents",
		installCmd: "npm:pi-subagents",
		tags: ["extension"],
		downloads: "92K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-subagents",
		repoUrl: "https://github.com/nicobailon/pi-subagents",
	},
];

/**
 * 推荐扩展包面板（当前隐藏：{false && ...}，扩展商店已取代该入口）。
 * 保留为独立组件便于日后恢复；安装复用扩展管理链路。
 */
export function RecommendedPackagesPanel(props: { data: PiExtensionListResult; onRefresh: () => void }) {
	const [installingSources, setInstallingSources] = useState<Set<string>>(() => new Set());

	const handleInstall = async (pkg: Pick<PiPackageInfo, "name" | "installCmd">) => {
		setInstallingSources((current) => new Set(current).add(pkg.installCmd));
		try {
			// 对已移除的内置扩展，走恢复流程而非 npm 安装
			const builtInSource = pkg.name.startsWith("pi-deck-") ? PIDEK_BUILTIN_SOURCE[pkg.name] : undefined;
			if (builtInSource) {
				await window.piDesktop.extensions.restoreBuiltIn(builtInSource);
			} else {
				await window.piDesktop.extensions.install(pkg.installCmd);
			}
			props.onRefresh();
		} catch (e) {
			showNotice(t("config.extensionOperationFailed", { error: e instanceof Error ? e.message : String(e) }), 4500, "error");
		} finally {
			setInstallingSources((current) => {
				const next = new Set(current);
				next.delete(pkg.installCmd);
				return next;
			});
		}
	};

	return (
		<div className="config-section mb-5">
			<div className="mb-3 flex items-center justify-between">
				{/* 与设置弹窗分区标题同级：text-sm，避免 title 字号偏大 */}
				<h3 className="extensions-installed-title text-sm font-semibold tracking-tight text-foreground">{t("config.recommendedPackages")}</h3>
			</div>
			<p className="config-im-form-hint mb-3 text-caption text-muted-foreground">{t("config.recommendedPackagesHint")}</p>
			<div className="extensions-recommended-list">
				{RECOMMENDED_PACKAGES.map((pkg) => {
					// 内置扩展按 source 文件名匹配，npm 扩展按 installCmd 匹配
					const builtInSource = pkg.name.startsWith("pi-deck-") ? PIDEK_BUILTIN_SOURCE[pkg.name] : undefined;
					const builtInExt = builtInSource ? props.data.extensions.find((ext: PiExtensionSummary) => ext.builtIn && ext.source === builtInSource) : undefined;
					// 已部署（非移除状态）视为已安装；已移除的内置扩展允许恢复安装
					const alreadyInstalled = builtInExt ? builtInExt.enabled !== false : props.data.extensions.some((ext) => ext.source === pkg.installCmd);
					const installing = installingSources.has(pkg.installCmd);
					return (
						<div
							key={pkg.name}
							className="extensions-recommended-row"
							onClick={() => {
								// pi.dev 的详情路由使用 npm 包名,但查询参数可能是扩展内部展示名。
								const packageName = pkg.piPackageName ?? pkg.name;
								// 弹框内链接强制系统浏览器：window.open 会走 setWindowOpenHandler → 跟随 linkOpenMode，
								// internal 时内置浏览器在 Dialog 下层不可见同样被遮挡（与 openDocsInSystemBrowser 同规则）
								window.piDesktop.app.openExternal(`https://pi.dev/packages/${pkg.name}?name=${packageName}`, true);
							}}
							title={`${t("config.openPackageDetail")}: ${pkg.name}`}
						>
							<div className="extensions-recommended-info">
								<div className="extensions-recommended-name">
									<strong>{pkg.name}</strong>
									{alreadyInstalled && (
										<span className="config-im-connected-badge" style={{ marginLeft: 8 }}>
											{t("config.installed")}
										</span>
									)}
								</div>
								<div className="extensions-recommended-desc">{t(pkg.descriptionKey)}</div>
							</div>
							<div className="extensions-recommended-action" onClick={(e) => e.stopPropagation()}>
								{/* 安装中保持与图标按钮同尺寸，避免 config-btn 文本把操作区撑开错位 */}
								<Button variant="ghost" size="icon-sm" className="size-7" title={installing ? t("config.installing") : alreadyInstalled ? t("config.installed") : t("config.install")} onClick={() => handleInstall(pkg)} disabled={alreadyInstalled || installing} aria-busy={installing}>
									{installing ? <span className="skillhub-installing-dot animate-pideck-spin" aria-hidden="true" /> : <Download size={15} strokeWidth={1.8} aria-hidden="true" />}
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									className="size-7"
									title={t("common.copy")}
									onClick={(e) => {
										e.stopPropagation();
										const cmd = `pi install ${pkg.installCmd}`;
										writeClipboard(cmd);
										showNotice(t("app.codeCopied"), 1200);
									}}
								>
									<Copy size={14} strokeWidth={1.8} />
								</Button>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

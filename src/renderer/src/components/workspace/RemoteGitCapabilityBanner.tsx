import { t } from "../../i18n";
import type { GitCapabilityBannerItemId } from "../../utils/remoteGitCapabilityView";
import { describeGitCapabilityBanner } from "../../utils/remoteGitCapabilityView";
import type { ProjectGitCapabilities, ProjectServiceCapabilityReasons } from "../../services/projectServiceContracts";

/**
 * 能力条（G4b）：只在有入口被关闭时解释“缺什么、第一条稳定原因是什么”。
 *
 * 全部可用时不渲染：面板顶部常驻一行“暂存与提交 / 同步 / ... 可用”只是噪音，
 * 真正的可用入口已经由按钮本身表达。它不渲染按钮、不提供重试、不假装可用：
 * 能力只决定 UI 入口，具体操作授权仍由 main 逐次复验。
 * 判据在 utils/remoteGitCapabilityView.ts（纯函数，可单测）；本组件只做渲染。
 */
export function RemoteGitCapabilityBanner(props: {
	git: ProjectGitCapabilities;
	blocked?: ProjectServiceCapabilityReasons;
	/** 本面板真正门禁的入口子集；缺省 = 远端面板全集。 */
	items?: readonly GitCapabilityBannerItemId[];
}) {
	const lines = describeGitCapabilityBanner(props.git, props.blocked ?? {}, props.items);
	if (lines.length === 0) return null;
	return (
		<section data-testid="remote-git-capabilities" aria-label={t("remoteGit.capabilityTitle")} className="shrink-0 space-y-0.5 border-b border-border px-3 py-1 text-xs">
			<h3 className="font-medium text-text-secondary">{t("remoteGit.capabilityTitle")}</h3>
			<ul className="space-y-0.5">
				{lines.map((line) => (
					<li key={line.id} data-testid={`remote-git-capability-${line.id}`} className="flex flex-wrap items-baseline gap-x-1 text-text-secondary">
						<span className="min-w-0 break-words text-text-primary">{line.labels.map((key) => t(key)).join(" / ")}</span>
						<span className="shrink-0">{t("remoteGit.capabilityBlocked")}</span>
						{line.reasonKey === undefined ? null : <span className="min-w-0 break-words">{t(line.reasonKey)}</span>}
					</li>
				))}
			</ul>
		</section>
	);
}

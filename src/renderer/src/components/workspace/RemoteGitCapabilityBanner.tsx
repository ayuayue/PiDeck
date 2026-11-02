import { t } from "../../i18n";
import type { GitCapabilityBannerItemId } from "../../utils/remoteGitCapabilityView";
import { describeGitCapabilityBannerModel } from "../../utils/remoteGitCapabilityView";
import type { ProjectGitCapabilities, ProjectServiceCapabilityReasons } from "../../services/projectServiceContracts";

/**
 * 能力条（G4b）：面板顶部“现在能做什么、缺什么、第一条稳定原因是什么”。
 *
 * 双态：全部可用时给出一行可用入口标签；有不可用入口时逐条列出并附第一条稳定原因（同原因合并）。
 * 它不渲染按钮、不提供重试、不假装可用：能力只决定 UI 入口，具体操作授权仍由 main 逐次复验。
 * 判据在 utils/remoteGitCapabilityView.ts（纯函数，可单测）；本组件只做渲染。
 */
export function RemoteGitCapabilityBanner(props: {
	git: ProjectGitCapabilities;
	blocked?: ProjectServiceCapabilityReasons;
	/** 本面板真正门禁的入口子集；缺省 = 远端面板全集。 */
	items?: readonly GitCapabilityBannerItemId[];
}) {
	const model = describeGitCapabilityBannerModel(props.git, props.blocked ?? {}, props.items);
	if (model.available.length === 0 && model.blocked.length === 0) return null;
	return (
		<section data-testid="remote-git-capabilities" aria-label={t("remoteGit.capabilityTitle")} className="shrink-0 space-y-0.5 border-b border-border px-3 py-1 text-xs">
			<h3 className="font-medium text-text-secondary">{t("remoteGit.capabilityTitle")}</h3>
			{model.blocked.length === 0 ? (
				<p data-testid="remote-git-capabilities-available" className="flex flex-wrap items-baseline gap-x-1 text-text-secondary">
					<span className="min-w-0 break-words text-text-primary">{model.available.map((key) => t(key)).join(" / ")}</span>
					<span className="shrink-0">{t("remoteGit.capabilityAvailable")}</span>
				</p>
			) : (
				<ul className="space-y-0.5">
					{model.blocked.map((line) => (
						<li key={line.id} data-testid={`remote-git-capability-${line.id}`} className="flex flex-wrap items-baseline gap-x-1 text-text-secondary">
							<span className="min-w-0 break-words text-text-primary">{line.labels.map((key) => t(key)).join(" / ")}</span>
							<span className="shrink-0">{t("remoteGit.capabilityBlocked")}</span>
							{line.reasonKey === undefined ? null : <span className="min-w-0 break-words">{t(line.reasonKey)}</span>}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

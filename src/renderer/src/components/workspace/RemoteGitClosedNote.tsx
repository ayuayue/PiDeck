import { t } from "../../i18n";
import type { ProjectServiceCapabilityKey, ProjectServiceCapabilityReasons } from "../../services/projectServiceContracts";
import { gitCapabilityReasonKey } from "../../utils/remoteGitCapabilityView";

/**
 * 能力关闭时的区块占位：保留区块标题与一行原因，而不是让整块区域消失。
 *
 * 依据 ui-commercialization-plan.md（disabled 是必查态）：用户必须看得见入口，并能就地读到
 * 为什么不可用；把区块整个隐藏会让人以为功能不存在，也无从判断是「没做」还是「这台主机不行」。
 * 判据仍是 gitCapabilityReasonKey，未知原因码不猜文案。
 */
export function RemoteGitClosedNote(props: { capability: ProjectServiceCapabilityKey; blocked?: ProjectServiceCapabilityReasons }) {
	const reasonKey = gitCapabilityReasonKey(props.blocked?.[props.capability]);
	return (
		<p data-testid={`remote-git-closed-${props.capability}`} className="px-3 py-1 text-xs text-text-secondary">
			<span>{t("remoteGit.capabilityBlocked")}</span>
			{reasonKey === undefined ? null : <span> · {t(reasonKey)}</span>}
		</p>
	);
}

import { t } from "../../i18n";
import type { SessionFilterPill } from "../../sessionFilterPills";

/**
 * 来源过滤菜单的类别文案：品牌名与图标并列展示（纯图标列用户分不清徽标对应哪个来源）。
 * 模块级求值，与 SessionSourceBadge 的 SOURCE_LABELS 同一惯例。
 */
export const SOURCE_FILTER_LABELS: Record<SessionFilterPill, string> = {
	pi: t("sessionSource.pi"),
	codex: t("sessionSource.codex"),
	claude: t("sessionSource.claude"),
	qoder: t("sessionSource.qoder"),
	opencode: t("sessionSource.opencode"),
	zcode: t("sessionSource.zcode"),
	workbuddy: t("sessionSource.workbuddy"),
	codebuddy: t("sessionSource.codebuddy"),
	cursor: t("sessionSource.cursor"),
	kimi: t("sessionSource.kimi"),
	kimiwork: t("sessionSource.kimiwork"),
	minimax: t("sessionSource.minimax"),
	dsh: t("sessionBackend.dsh"),
	acp: t("sessionBackend.acp"),
	imagegen: t("sessionBackend.imagegen"),
};

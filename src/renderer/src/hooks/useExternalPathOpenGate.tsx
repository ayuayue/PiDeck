import { useCallback, useState } from "react";
import type { SecurityConfig } from "../../../shared/types";
import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import { desktopApi as api } from "../desktopApi";
import { t, type TranslationKey } from "../i18n";
import { evaluateExternalPathAccess, planExternalPathOpen, type ExternalPathAccessReason, type ExternalPathTargetKind } from "../utils/externalPathAccessPolicy";
import { showNotice } from "../utils/notice";

/**
 * 打开动作类别：read（把文件读进 PiDeck，左键默认）/ default-app（交系统默认应用）/
 * reveal（在系统文件管理器里定位）。只有 read 与 default-app 落在文件上时需要 stat 定类，
 * reveal 不读内容，直接在策略里归入无风险类别。
 */
export type ExternalPathOpenKind = "read" | "default-app" | "reveal";

export type ExternalPathOpenRequest = {
	/** 已词法解析出的绝对路径（项目外） */
	path: string;
	/** 动作类别（默认 read） */
	kind?: ExternalPathOpenKind;
	/** 判定用的会话身份：会话级安全等级覆盖优先于全局默认 */
	sessionId?: string;
	/** 判定用的工作目录（会话 runtime cwd） */
	cwd?: string;
	projectRoot?: string;
	/** 判定放行后继续打开（调用方提供，携带只读/scope 等语义） */
	proceed: () => void;
};

/** 会走到二次确认的三种原因（其余是放行/拒绝，不进弹框） */
type AskReason = Extract<ExternalPathAccessReason, "sensitive" | "outside-allowed-dirs" | "policy-unavailable">;

/** 二次确认原因 → 弹框副文案（说明「为什么问」） */
const ASK_REASON_KEYS: Record<AskReason, TranslationKey> = {
	sensitive: "app.fileLinkExternalReasonSensitive",
	"outside-allowed-dirs": "app.fileLinkExternalReasonOutsideAllowedDirs",
	"policy-unavailable": "app.fileLinkExternalReasonPolicyUnavailable",
};

function askReasonKey(reason: ExternalPathAccessReason): TranslationKey {
	return reason in ASK_REASON_KEYS ? ASK_REASON_KEYS[reason as AskReason] : "app.fileLinkExternalReasonOutsideAllowedDirs";
}

/** 拒绝原因 → 提示文案。当前策略下只有 denyDirs 会拒绝，其余分支均降级为「问一次」。 */
function blockReasonKey(reason: ExternalPathAccessReason): TranslationKey {
	return reason === "deny-dir" ? "app.fileLinkExternalReasonDenyDir" : askReasonKey(reason);
}

/**
 * 项目外文件链接的「用户意图门」。
 *
 * 会话内文件链接此前对项目外路径一律硬拒（弹「不在当前项目内」），哪怕用户当次安全等级
 * 是「关闭」。这里按安全等级 + 会话覆盖求值：放行 → 直接打开；需确认 → 弹 ConfirmDialog；
 * 被 denyDirs 列为禁地 → 提示拒绝；目录 / 文件管理器定位（不读内容、不执行）→ 直接打开。
 * 判定规则见 utils/externalPathAccessPolicy。
 *
 * 左键打开与右键菜单的「默认方式打开 / 在资源管理器中打开」共用同一套判定：左键由 App
 * 持有一份门，右键菜单由 MarkdownLink 自行持有一份（每个链接的菜单本来就是该组件自己的
 * UI 状态），两边都调 evaluateExternalPathAccess，弹框只有一个会处于 pending，因此同时
 * 只可能看到一扇窗。
 *
 * 边界：本门只是用户意图收集，不是安全边界（真正的边界在主进程 scope 校验与安全门扩展）。
 * 放行后的打开一律只读、不带 scope —— 这一点由调用方的 proceed 保证。
 */
export function useExternalPathOpenGate() {
	const [pending, setPending] = useState<{ request: ExternalPathOpenRequest; reason: ExternalPathAccessReason } | null>(null);

	const requestExternalPathOpen = useCallback(async (request: ExternalPathOpenRequest) => {
		// 读一次实时配置（等级可能刚在输入框改过）；读不到时交给策略 fail-safe 成「问一次」
		let config: SecurityConfig | null = null;
		try {
			config = await api.security.getConfig();
		} catch {
			config = null;
		}
		// 目标类别：reveal 不读内容（定位一个路径不会把它变成本地内容），直接归入无风险类别，
		// 不必 stat；其余先 stat 定类 —— 目录（含 default-app 落在目录上）会走系统文件管理器，
		// 策略据此跳过二次确认。stat 失败或不存在时按文件处理，后续 opener / shell.openPath
		// 会给出统一的失败提示。
		let targetKind: ExternalPathTargetKind = "file";
		if (request.kind === "reveal") {
			targetKind = "reveal";
		} else {
			try {
				const stat = await api.files.stat(request.path);
				if (stat.exists && stat.isDirectory) targetKind = "directory";
			} catch {
				targetKind = "file";
			}
		}
		const verdict = evaluateExternalPathAccess({ config, sessionId: request.sessionId, filePath: request.path, cwd: request.cwd, projectRoot: request.projectRoot, targetKind });
		const plan = planExternalPathOpen(verdict);
		if (plan.action === "blocked") {
			// 拒绝也要说清「为什么」+ 怎么自救：只有 denyDirs 会走到这里，提示可在安全管理里
			// 把目录移出禁止列表。（项目外打开一律不经系统默认应用，所以不存在「被诱导执行」。）
			showNotice(t("app.fileLinkExternalBlocked", { path: request.path, reason: t(blockReasonKey(plan.reason)) }), undefined, "error");
			return;
		}
		if (plan.action === "open") {
			request.proceed();
			return;
		}
		setPending({ request, reason: plan.reason });
	}, []);

	const dialog = pending ? (
		<ConfirmDialog
			title={t("app.fileLinkExternalOpenTitle")}
			message={t("app.fileLinkExternalOpenMessage", { path: pending.request.path, reason: t(askReasonKey(pending.reason)) })}
			confirmLabel={t("app.fileLinkExternalConfirm")}
			danger={pending.reason === "sensitive"}
			onConfirm={() => {
				const request = pending.request;
				setPending(null);
				request.proceed();
			}}
			onCancel={() => setPending(null)}
		/>
	) : null;

	return { requestExternalPathOpen, dialog };
}

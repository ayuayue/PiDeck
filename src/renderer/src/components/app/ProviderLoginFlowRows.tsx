import { Copy, ExternalLink } from "lucide-react";
import type { PiAuthFlowEvent } from "../../../../shared/types/piAuth";
import { t } from "../../i18n";
import { copyTextWithCopiedNotice } from "../../utils/clipboardNotice";
import { openInSystemBrowser } from "../../utils/openExternal";
import type { ProviderAuthEntry } from "../../utils/providerLoginFlow";
import { Button } from "../ui-shadcn/button";

/**
 * 登录流程的展示行。
 *
 * 为什么从弹框里拆出来：授权入口卡与日志行是两种密度完全不同的呈现（入口卡是主操作，
 * 日志只是背景信息），混在一个 switch 里会让弹框组件既管流程状态又管排版细节。
 * 链接一律走系统浏览器，与应用内浏览器面板的 display 设置无关。
 */

/** 授权入口卡：把「打开授权页 / 复制验证码」做成主操作，而不是一行需要用户自己点的小字链接。 */
export function AuthEntryCard({ entry }: { entry: ProviderAuthEntry }) {
	if (entry.kind === "device-code") {
		return (
			<div className="space-y-2 rounded-lg border border-border p-3">
				<p className="text-xs text-muted-foreground">{t("providerLogin.running.deviceCodeHint")}</p>
				{/* 验证码要能在另一台设备上手动输入，所以等宽大字 + 可选中，不折行。 */}
				<p className="font-mono text-xl tracking-[0.2em] select-text">{entry.userCode}</p>
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" onClick={() => openInSystemBrowser(entry.verificationUri)}>
						<ExternalLink />
						{t("providerLogin.running.openAuthPage")}
					</Button>
					<Button size="sm" variant="secondary" onClick={() => void copyTextWithCopiedNotice(entry.userCode)}>
						<Copy />
						{t("providerLogin.running.copyCode")}
					</Button>
				</div>
				<p className="break-all text-xs text-muted-foreground">{entry.verificationUri}</p>
			</div>
		);
	}
	return (
		<div className="space-y-2 rounded-lg border border-border p-3">
			{entry.instructions && <p className="text-xs text-muted-foreground">{entry.instructions}</p>}
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" onClick={() => openInSystemBrowser(entry.url)}>
					<ExternalLink />
					{t("providerLogin.running.openAuthPage")}
				</Button>
				<Button size="sm" variant="secondary" onClick={() => void copyTextWithCopiedNotice(entry.url)}>
					<Copy />
					{t("providerLogin.running.copyLink")}
				</Button>
			</div>
			<p className="break-all text-xs text-muted-foreground">{entry.url}</p>
		</div>
	);
}

/** 日志行：pi 的进度与提示。授权入口不在这里（见 `pickFlowLogEvents`），故兜底返回空。 */
export function FlowLogRow({ event }: { event: PiAuthFlowEvent }) {
	if (event.type === "info") {
		return (
			<div className="space-y-1 text-xs">
				<p className="whitespace-pre-wrap break-words">{event.message}</p>
				{event.links?.map((link) => (
					<button key={link.url} type="button" className="block break-all text-left text-primary underline" onClick={() => openInSystemBrowser(link.url)}>
						{link.label || link.url}
					</button>
				))}
			</div>
		);
	}
	if (event.type !== "progress") return null;
	return <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{event.message}</p>;
}

/**
 * DSH_HOME 共享 / 并发冲突提示（配置管理 → DSH → 概览）。
 *
 * 背景（issue #189 问题 1）：PiDeck 默认用用户真实 `~/.dsh`，与 dsh CLI 共用
 * settings.yaml / 插件状态文件；DSH 官方约束是「同一 DSH_HOME 只允许一个 host」，
 * 两实例并存会互相覆盖（实测：CLI 端选的主题数分钟内被前台 PiDeck 写回）。
 * PiDeck 无法阻断外部 dsh 进程（CLI 不遵守 PiDeck 锁文件），因此这里只做
 * 「说清楚 + 给官方隔离手段」——issue 明确要求「使用前告知共用目录」。
 *
 * 两级呈现，避免告警疲劳：
 * - externalHostPid（锁文件里另一个仍存活的 host）= 冲突**已发生** → 醒目警告；
 * - sharesCliHome（默认 ~/.dsh，未隔离）= 只是**风险**，且是默认形态 → 中性说明
 *   + 可粘贴的隔离命令（不占用警告色）。
 * 显式覆盖过目录（usingOverride）= 用户已主动隔离 → 完全不提示。
 */
import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../i18n";
import type { DshHomeSharingState } from "../../../shared/types/dshHome";

/** 命令行侧隔离命令：官方手段就是给 CLI 一个独立 DSH_HOME。
 *  只说「有风险」用户不知道怎么办；按平台给可直接粘贴的一行
 *  （与 dshRuntimeHint.ts 一致用 userAgent 判定，不引 Node/Electron 依赖）。 */
function isolationCommand(): string {
	return typeof navigator === "undefined" || navigator.userAgent.includes("Windows") ? "set DSH_HOME=%USERPROFILE%\\.dsh-cli" : "export DSH_HOME=$HOME/.dsh-cli";
}

export function DshHomeSharingNotice({ sharing }: { sharing?: DshHomeSharingState }) {
	if (!sharing) return null;
	const conflictPid = sharing.externalHostPid;

	// 冲突：确有另一个存活 host 在用同一目录 → 警告级别。
	if (conflictPid !== undefined) {
		return (
			<Notice tone="warning">
				<span className="text-caption font-semibold">{t("config.dsh.homeConflictTitle")}</span>
				<p className="text-micro leading-relaxed">{t("config.dsh.homeConflictHint", { pid: String(conflictPid) })}</p>
				<p className="font-mono text-micro leading-relaxed">{isolationCommand()}</p>
			</Notice>
		);
	}

	// 共用默认目录：风险提示（默认形态，用中性样式而非警告色）。
	if (!sharing.sharesCliHome) return null;
	return (
		<Notice tone="info">
			<span className="text-caption font-medium text-foreground">{t("config.dsh.homeSharedTitle")}</span>
			<p className="text-micro leading-relaxed">{t("config.dsh.homeSharedHint")}</p>
			<p className="font-mono text-micro leading-relaxed">{isolationCommand()}</p>
		</Notice>
	);
}

/** 两种色调共用外壳：warning = 冲突（warning 语义 token）；info = 常态风险说明（面板色）。 */
function Notice({ tone, children }: { tone: "warning" | "info"; children: ReactNode }) {
	const className = tone === "warning" ? "border-warning/40 bg-warning/10 text-warning" : "border-border-subtle bg-bg-panel text-muted-foreground";
	const Icon = tone === "warning" ? AlertTriangle : Info;
	return (
		<div role="status" className={`flex items-start gap-2 rounded-md border px-3.5 py-2.5 ${className}`}>
			<Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<div className="grid gap-0.5">{children}</div>
		</div>
	);
}

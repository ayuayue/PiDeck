/**
 * 外网访问操作指南弹窗：Cloudflare Tunnel（免注册公网隧道）与 Tailscale（私有组网）
 * 两个渠道的分步引导——前置安装命令、下载/管理台外链、访问方式与注意事项。
 * 文案全部走 i18n（zh-CN / en-US 同步），链接经 desktopApi.app.openExternal 走系统浏览器。
 */
import { memo, useCallback, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui-shadcn/tabs";
import { Button } from "../../ui-shadcn/button";

export type RemoteAccessGuideTab = "cloudflare" | "tailscale";

/** 可复制的命令行块：`winget install Cloudflare.cloudflared` 等。 */
function CommandBlock({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(() => {
		void navigator.clipboard
			.writeText(command)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => setCopied(false));
	}, [command]);
	return (
		<div className="flex items-start gap-2 rounded-md border border-border-subtle/70 bg-bg-muted/40 p-2">
			<code className="block flex-1 break-all font-mono text-caption text-text-primary">{command}</code>
			<Button variant="ghost" size="icon-xs" className="size-7 shrink-0 rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-secondary" title={copied ? t("settings.webCopied") : t("settings.webCopyUrl")} aria-label={copied ? t("settings.webCopied") : t("settings.webCopyUrl")} onClick={handleCopy}>
				{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
			</Button>
		</div>
	);
}

/** 指南外链按钮（系统浏览器打开）。 */
function GuideLink({ href, label }: { href: string; label: string }) {
	return (
		<Button variant="link" size="sm" className="h-auto p-0 text-caption" onClick={() => void desktopApi.app.openExternal(href, true).catch(() => undefined)}>
			{label}
			<ExternalLink className="ml-1 size-3" aria-hidden="true" />
		</Button>
	);
}

/** 有序步骤条目；children 放命令块/链接等富内容。 */
function GuideStep({ index, children }: { index: number; children: React.ReactNode }) {
	return (
		<li className="grid gap-1.5">
			<div className="flex items-start gap-2">
				<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-muted text-micro font-bold text-text-secondary">{index}</span>
				<div className="grid min-w-0 flex-1 gap-1.5">{children}</div>
			</div>
		</li>
	);
}

export const WebRemoteAccessGuideDialog = memo(function WebRemoteAccessGuideDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; tab: RemoteAccessGuideTab; onTabChange: (tab: RemoteAccessGuideTab) => void }) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("settings.remote.guide.title")}</DialogTitle>
					<DialogDescription>{t("settings.remote.guide.subtitle")}</DialogDescription>
				</DialogHeader>
				<Tabs value={props.tab} onValueChange={(value) => props.onTabChange(value as RemoteAccessGuideTab)}>
					<TabsList className="grid w-full grid-cols-2">
						<TabsTrigger value="cloudflare">{t("settings.remote.cf.title")}</TabsTrigger>
						<TabsTrigger value="tailscale">{t("settings.remote.ts.title")}</TabsTrigger>
					</TabsList>

					{/* ── Cloudflare Tunnel 指南 ── */}
					<TabsContent value="cloudflare" className="mt-3 grid gap-3">
						<p className="text-caption text-text-secondary">{t("settings.remote.guide.cf.intro")}</p>
						<ol className="grid gap-3">
							<GuideStep index={1}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.cf.step1")}</span>
								<CommandBlock command="winget install Cloudflare.cloudflared" />
								<p className="text-micro text-text-tertiary">{t("settings.remote.guide.cf.step1Mac")}</p>
								<CommandBlock command="brew install cloudflared" />
								<p className="text-micro text-text-tertiary">
									<GuideLink href="https://github.com/cloudflare/cloudflared/releases" label={t("settings.remote.guide.cf.releaseLink")} />
								</p>
							</GuideStep>
							<GuideStep index={2}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.cf.step2")}</span>
							</GuideStep>
							<GuideStep index={3}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.cf.step3")}</span>
							</GuideStep>
							<GuideStep index={4}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.cf.step4")}</span>
							</GuideStep>
						</ol>
						<div className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-caption text-text-secondary">{t("settings.remote.guide.cf.notice")}</div>
					</TabsContent>

					{/* ── Tailscale 指南 ── */}
					<TabsContent value="tailscale" className="mt-3 grid gap-3">
						<p className="text-caption text-text-secondary">{t("settings.remote.guide.ts.intro")}</p>
						<ol className="grid gap-3">
							<GuideStep index={1}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.ts.step1")}</span>
								<p className="text-micro text-text-tertiary">
									<GuideLink href="https://tailscale.com/download" label={t("settings.remote.guide.ts.downloadLink")} />
								</p>
							</GuideStep>
							<GuideStep index={2}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.ts.step2")}</span>
							</GuideStep>
							<GuideStep index={3}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.ts.step3")}</span>
							</GuideStep>
							<GuideStep index={4}>
								<span className="text-caption text-text-primary">{t("settings.remote.guide.ts.step4")}</span>
								<p className="text-micro text-text-tertiary">
									<GuideLink href="https://login.tailscale.com/admin/dns" label={t("settings.remote.guide.ts.adminLink")} />
								</p>
							</GuideStep>
						</ol>
						<div className="rounded-md border border-border-subtle/70 bg-bg-muted/30 p-2.5 text-caption text-text-secondary">{t("settings.remote.guide.ts.notice")}</div>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
});

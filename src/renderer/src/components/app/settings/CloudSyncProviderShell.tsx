import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { t } from "../../../i18n";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Button } from "../../ui-shadcn/button";
import { cn } from "../../../lib/utils";

/**
 * 云同步服务卡共享外壳：折叠头部（图标/标题/状态点）+ 编辑区容器 + 底部操作按钮组。
 * 五张 Provider 卡（WebDAV/S3/GitHub/本地文件夹/OneDrive/Google）共用同一挂载点，
 * 折叠交互与状态展示只在此定义一次。
 */

/** GitHub 官方 mark（lucide 新版本移除了品牌图标，这里用内联 SVG）。 */
export function GithubMarkIcon(props: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={props.className}>
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
		</svg>
	);
}

/** 表单字段：Label 在上 + 示例 placeholder（对齐 Netcatty 提示风格）。 */
export function Field(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1.5">
			<Label className="text-xs text-text-tertiary">{props.label}</Label>
			{props.children}
		</div>
	);
}

/** 密码输入：右侧眼睛按钮切换明文/密文。 */
export function SecretInput(props: { placeholder?: string; value: string; onChange: (value: string) => void }) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="relative">
			<Input type={visible ? "text" : "password"} placeholder={props.placeholder} value={props.value} onChange={(event) => props.onChange(event.target.value)} className="pr-9" />
			<button type="button" tabIndex={-1} aria-label={t("cloudSync.provider.showSecret")} title={t("cloudSync.provider.showSecret")} onClick={() => setVisible((prev) => !prev)} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-foreground">
				{visible ? <EyeOff size={15} /> : <Eye size={15} />}
			</button>
		</div>
	);
}

/** Provider 状态点：连接态用语义色，未连接灰色。 */
export function StatusDot(props: { status: string }) {
	return <span aria-hidden className={cn("inline-block size-2 rounded-full", props.status === "connected" ? "bg-success" : props.status === "connecting" ? "bg-warning" : props.status === "error" ? "bg-destructive" : "bg-text-tertiary/50")} />;
}

/** 头部右侧状态文案：connected > connecting > 已配置未连接 > 未连接。 */
function providerStatusLabel(status: string, configured: boolean): string {
	if (status === "connected") return t("cloudSync.provider.connected");
	if (status === "connecting") return t("cloudSync.provider.connecting");
	if (status === "disconnected" && configured) return t("cloudSync.provider.configured");
	return t("cloudSync.provider.disconnected");
}

/**
 * 折叠式服务卡外壳：点头部展开编辑区，收起时只显示状态行（对齐 Netcatty 布局）。
 * 编辑态由外壳持有；children 为函数以暴露 close()，供「取消」按钮收起编辑区。
 */
export function ProviderCardShell(props: { icon: React.ReactNode; title: string; description?: string; account?: string; status: string; configured: boolean; children: (close: () => void) => React.ReactNode }) {
	const [editing, setEditing] = useState(false);
	return (
		<div className="overflow-hidden rounded-lg border border-border-subtle">
			<div
				className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-accent/40"
				role="button"
				tabIndex={0}
				onClick={() => setEditing((prev) => !prev)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						setEditing((prev) => !prev);
					}
				}}
			>
				{editing ? <ChevronDown size={16} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={16} className="shrink-0 text-text-tertiary" />}
				<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">{props.icon}</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{props.title}</span>
					{props.description ? <span className="block truncate text-caption text-text-tertiary">{props.description}</span> : null}
				</span>
				{props.account ? <span className="shrink-0 truncate text-caption text-text-tertiary">{props.account}</span> : null}
				<span className="flex shrink-0 items-center gap-1.5 text-caption text-text-tertiary">
					<StatusDot status={props.status} />
					{providerStatusLabel(props.status, props.configured)}
				</span>
			</div>
			{editing ? <div className="space-y-3 border-t border-border-subtle px-4 py-4">{props.children(() => setEditing(false))}</div> : null}
		</div>
	);
}

/** 底部操作按钮组：主操作（保存并连接/浏览器授权）+ 可选取消/重连/移除。 */
export function ProviderActionBar(props: {
	primaryLabel: string;
	onPrimary: () => void;
	primaryDisabled?: boolean;
	/** 配置型卡片（WebDAV/S3/本地文件夹）的「取消」收起编辑区。 */
	onCancel?: () => void;
	configured: boolean;
	status: string;
	/** 已配置但未连接时的「连接」重试按钮。 */
	onReconnect?: () => void;
	onDisconnect?: () => void;
	/** 移除按钮样式：配置型卡片为 destructive ghost，OAuth 卡片为 outline（保持既有观感）。 */
	removeVariant?: "ghost" | "outline";
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 pt-1">
			<Button size="sm" onClick={props.onPrimary} disabled={props.primaryDisabled}>
				{props.primaryLabel}
			</Button>
			{props.onCancel ? (
				<Button size="sm" variant="outline" onClick={props.onCancel}>
					{t("common.cancel")}
				</Button>
			) : null}
			{props.configured && props.status === "disconnected" && props.onReconnect ? (
				<Button size="sm" variant="outline" onClick={props.onReconnect}>
					{t("cloudSync.provider.connect")}
				</Button>
			) : null}
			{props.configured && props.onDisconnect ? (
				<Button size="sm" variant={props.removeVariant ?? "ghost"} className={props.removeVariant === "outline" ? undefined : "text-destructive hover:text-destructive"} onClick={props.onDisconnect}>
					{t("cloudSync.provider.remove")}
				</Button>
			) : null}
		</div>
	);
}

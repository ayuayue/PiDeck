/**
 * 「用量查询」配置入口按钮（柱状图图标，模型页/认证页/DSH 页卡片头部图标组共用）。
 *
 * 行为：provider 命中内置用量模板（零配置自动生效）时不渲染——内置支持的供应商
 * 不需要配置入口，避免「没开启也能加载出来」的冗余按钮；未命中（或识别未返回）
 * 时保留按钮，让用户配置通用 / New API 模板。识别结果经 useProviderUsageRecognized
 * 模块级缓存，多卡片共享一次 IPC。
 */
import { BarChart3 } from "lucide-react";
import type { UsageProbeBackend } from "../../../../shared/types/providerUsage";
import { t } from "../../i18n";
import { useProviderUsageRecognized } from "../../hooks/useProviderUsage";
import { Button } from "../ui-shadcn/button";

export function UsageQueryEntryButton(props: {
	provider: string;
	backend?: UsageProbeBackend;
	onOpen: () => void;
	className?: string;
	iconClassName?: string;
}) {
	const recognized = useProviderUsageRecognized(props.provider, props.backend);
	// 内置命中 → 零配置自动生效，隐藏配置入口。
	if (recognized) return null;
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			className={props.className ?? "size-7"}
			onClick={(e) => {
				e.stopPropagation();
				props.onOpen();
			}}
			title={t("config.usageProbe.entry")}
			aria-label={t("config.usageProbe.entry")}
			data-testid="provider-usage-configure-icon"
		>
			<BarChart3 className={props.iconClassName ?? "size-3.5"} aria-hidden="true" />
		</Button>
	);
}

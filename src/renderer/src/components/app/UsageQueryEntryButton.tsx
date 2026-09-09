/**
 * 「用量查询」入口按钮（柱状图图标，模型页/认证页/DSH 卡片头部图标组共用）。
 *
 * 行为：**常驻**。这里既是探针配置入口（通用 / New API / Cookie 模板），也是
 * provider 级「是否启用用量查询」开关的唯一位置（弹窗里的开关，默认关）——
 * 之前命中内置模板就隐藏按钮，导致认证页/部分模型卡片看不到这个图标、也找不到开关，
 * 已改为无条件渲染。
 */
import { BarChart3 } from "lucide-react";
import type { UsageProbeBackend } from "../../../../shared/types/providerUsage";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

export function UsageQueryEntryButton(props: {
	provider: string;
	backend?: UsageProbeBackend;
	onOpen: () => void;
	className?: string;
	iconClassName?: string;
}) {
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

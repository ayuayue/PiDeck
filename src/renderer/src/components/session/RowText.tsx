import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * 过程行的**文本段**：把同一行里混排的文本（14px 正文 / 12px 详情 / 12px 等宽命令·路径）
 * 钉在同一条基线上。
 *
 * 为什么需要它（2026-09 用户按截图反复反馈「详情偏上、没纵向居中」）：
 * 过程行容器是 `flex items-center`，即**按盒子居中**。盒子居中时文本基线落在
 * `行中心 + (ascent − descent) / 2` —— 只由**字体度量**决定。等宽字体（ui-monospace /
 * Liberation Mono）的 (ascent − descent) 比正文 CJK 字体小，同一行里混排必然差约 3px；
 * 并且行高在推导中被约掉，改 line-height 只会动 0.04px（曾按此思路改过
 * `--text-chat-detail--line-height`，实测无效，已回滚）。
 *
 * 唯一在字体层面正确的做法是**按基线对齐**：把要共基线的文本放进 `items-baseline` 组，
 * 组自身作为**一个** flex 项被外层 `items-center` 居中。注意必须把该行**所有**文本项
 * 都放进来——只把相邻的「耗时 + 等宽详情」入组、把 14px 工具名留在组外，实测仍有 1.5px 偏差。
 *
 * 盒子类元素（图标 / 徽章 / chevron / 状态 pill）**不要**放进来：它们有自己的垂直居中
 * 语义，入组需逐个 `self-center`。放组外由行容器居中即可。
 *
 * 组件只负责「共基线」这条策略（`inline-flex items-baseline gap-2`），伸缩行为由调用方给：
 * 需要撑满剩余宽度的行传 `flex-[1_1_auto]`，只占内容的行不用传。
 *
 * `data-row-text` 是 e2e 断言「同行文本共基线」的稳定锚点
 * （见 `e2e/process-group-display.spec.ts`）。
 */
export const RowText = ({ className, ...props }: ComponentProps<"span">) => <span data-row-text="" className={cn("inline-flex min-w-0 items-baseline gap-2", className)} {...props} />;

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 跨设置、配置和反馈面板复用的区块标题。
 *
 * 标题和描述必须在同一组件内定义，避免不同业务页分别调整 font-size/font-weight
 * 后产生视觉层级漂移；外层 className 只负责保留各面板自己的布局和间距规则。
 * titleClassName / descriptionClassName 用于面板级视觉变体（如设置页的弱化分区标题），
 * 缺省时使用通用默认样式。
 */
export function SectionHeading(props: { title: ReactNode; description?: ReactNode; className?: string; titleClassName?: string; descriptionClassName?: string }) {
	return (
		<div className={cn("flex flex-col gap-1", props.className)}>
			<strong className={props.titleClassName ?? "text-control font-semibold leading-5 text-foreground"}>{props.title}</strong>
			{props.description && <small className={props.descriptionClassName ?? "text-caption font-normal leading-4 text-muted-foreground"}>{props.description}</small>}
		</div>
	);
}

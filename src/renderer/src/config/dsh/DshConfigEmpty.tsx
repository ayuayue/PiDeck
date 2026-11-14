/** 空列表占位：DSH 配置页各分区共用（模型/预设/插件无数据时的提示块）。 */
export function DshConfigEmpty(props: { text: string }) {
	return <div className="rounded-sm border border-border-subtle bg-bg-panel px-3.5 py-8 text-center text-control text-muted-foreground">{props.text}</div>;
}

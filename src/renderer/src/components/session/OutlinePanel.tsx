import { useAtomValue } from "jotai";
import type { ComponentProps } from "react";
import { outlineItemsAtom } from "../../atoms/session-outline-atoms";
import { ConversationOutline } from "./SurfaceComponents";

type OutlinePanelProps = Omit<ComponentProps<typeof ConversationOutline>, "items">;

/**
 * 大纲导航面板宿主：自行订阅 outlineItemsAtom，避免 App 根组件
 * 随消息流式更新重渲染（大纲条目只在这里消费）。
 */
export function OutlinePanel(props: OutlinePanelProps) {
	const items = useAtomValue(outlineItemsAtom);
	return <ConversationOutline items={items} {...props} />;
}

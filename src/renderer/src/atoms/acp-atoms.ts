import { atom } from "jotai";
import type { AcpToolConfig } from "../../../shared/types/acp";

/**
 * 已登记的 ACP CLI 工具表(settings.acpTools 的只读快照)。
 *
 * 数据流:App 挂载时经 desktopApi.acp.listTools() 拉取;设置页保存成功后用
 * 返回的规范化表整表回写。工具表只在设置页改动,频率极低,不做事件订阅。
 * 新建会话菜单据此列出「ACP 工具会话」可选项;空表时菜单显示引导项。
 */
export const acpToolsAtom = atom<AcpToolConfig[]>([]);

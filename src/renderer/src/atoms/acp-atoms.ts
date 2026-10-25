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

/**
 * ACP 总开关快照(settings.acpEnabled,默认 false=opt-in)。
 *
 * 新建会话菜单只在 acpEnabled=true 且工具表非空时列 ACP 入口(关闭时主进程
 * 也不注册 ACP 网关);变更重启生效,快照只在挂载时拉一次,频率与工具表同级。
 */
export const acpEnabledAtom = atom<boolean>(false);

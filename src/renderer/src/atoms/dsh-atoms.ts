/**
 * DSH 领域渲染层状态（agent 预设目录缓存）。
 *
 * agentPreset.list 是 host 侧 live 目录（用户可在 dsh-web / 配置文件增删），
 * 会话头胶囊与草稿期模式选择器都要解析 id → 显示名，这里做进程内共享缓存。
 *
 * 注意：本文件保持纯状态（atoms + 纯函数），不 import desktopApi——
 * atoms/index.ts 会被 Node 测试（runtimeAtoms 等）整体加载，而 desktopApi
 * 顶层访问 window（浏览器/Electron 才有），顶层依赖会把整个 atoms 面炸掉。
 * 目录加载逻辑（loadDshAgentPresets / 刷新与 TTL）放在 utils/dshAgentPresets.ts，
 * 本文件只留纯状态与查询函数。
 */
import { atom } from "jotai";
import type { DshRuntimeInstallPhase, DshRuntimeStatus } from "../../../shared/types/dshRuntime";

/** agentPreset.list 名单行的身份字段（与 DshHost.listAgentPresets 返回子集一致）。 */
export type DshAgentPresetIdentity = {
	id: string;
	isDefault: boolean;
	name?: string;
	description?: string;
	broken?: string;
};

/**
 * DSH runtime 安装态快照（AgentRuntimeProvider 阶段 1，IPC dsh-runtime:get-status）。
 * 初值 checking；useDshRuntimeStatusSync（App 挂载一份）拉取并订阅变更写入。
 * 消费方：ConfigModal（DSH Tab 门控）、CommonTab（默认后端选项）、
 * App（defaultAgentBackend 钳制）。atoms/index.ts 会被 Node 测试整体加载，
 * 加载逻辑必须留在 hook，本文件保持纯状态。
 */
export const dshRuntimeStatusAtom = atom<DshRuntimeStatus>({ state: "checking" });

/**
 * DSH runtime 安装进度快照（IPC dsh-runtime:install-progress）。
 *
 * phase=null 表示空闲。进度是主进程编排的持续事件流（下载可长达数十秒），
 * 由 useDshRuntimeInstallProgressSync（App 挂载一份）订阅写入；
 * DshRuntimeSection 只读 atom——切配置分页/关掉设置弹窗再回来，进度不丢。
 * 与 dshRuntimeStatusAtom 同理：本文件保持纯状态，订阅逻辑留在 hook。
 */
export type DshInstallProgressState = {
	phase: DshRuntimeInstallPhase | null;
	/** 0-100：downloading 按已收字节占比，其余阶段取阶段内离散值。 */
	percent: number;
	/** phase=error 时的用户可见原因（主进程已填好文案）。 */
	error?: string;
};

export const dshInstallProgressAtom = atom<DshInstallProgressState>({
	phase: null,
	percent: 0,
});

/** 目录缓存：null = 未加载或加载失败（可重试）；[] = 已确认部署未装配预设。 */
export const dshAgentPresetsAtom = atom<DshAgentPresetIdentity[] | null>(null);

/** 目录中标记为部署默认的 preset id（无装配/无标记时 undefined）。 */
export function dshDefaultPresetId(presets: DshAgentPresetIdentity[] | null): string | undefined {
	if (!presets || presets.length === 0) return undefined;
	return presets.find((preset) => preset.isDefault === true)?.id;
}

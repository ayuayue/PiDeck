import { atom } from "jotai";
import type { DataEnvMode, ImportProgress } from "../../../shared/types/dataEnv";

/**
 * dev 首启数据模式选择弹窗（dataEnvDecisionRequired 事件置位；用户完成选择后由弹窗复位）。
 * 事件仅由主进程在 dev 打包首启未决策时推送一次，本会话内不重复弹。
 */
export const dataEnvDecisionRequiredAtom = atom<boolean>(false);

/** 数据目录标记警告弹窗载荷（dataEnvMismatchDetected 事件携带目录内 dataMode；null=无警告）。 */
export const dataEnvMismatchAtom = atom<{ dataModeInDir: DataEnvMode } | null>(null);

/** 数据导入进度快照（dataEnvImportProgress 推送；DataImportProgressDialog 渲染消费）。 */
export const dataEnvImportProgressAtom = atom<ImportProgress | null>(null);

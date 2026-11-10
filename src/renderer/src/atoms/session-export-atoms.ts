import { atom } from "jotai";

/** 导出对话框只持有稳定会话身份；原始消息不放进全局 atom。 */
export const sessionExportRequestAtom = atom<{ sessionId: string } | null>(null);

import { atom } from "jotai";
import type { TpsDisplayMode } from "../../../shared/types/settings";

/** 已保存的 TPS 模式镜像；所有会话显示面订阅同一份设置。 */
export const tpsDisplayModeAtom = atom<TpsDisplayMode>("streaming");

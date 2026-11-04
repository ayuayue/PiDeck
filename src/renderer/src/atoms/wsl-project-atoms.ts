import { atom } from "jotai";

/**
 * WSL 目录选择弹框的开关（`docs/wsl-project-in-distro-io-plan.md` Wave 0）。
 *
 * 与 `remoteEnrollDialogOpenAtom` 同理由：侧栏「+」、空态引导、设置 → 连接里的档案行都可能发起添加，
 * 而弹框只全应用挂一处。值即「用哪个档案」：`{ hostId }` 走该档案，`{}` 走全局 WSL 模式，null 关闭。
 */
export const wslProjectPickerAtom = atom<{ hostId?: string } | null>(null);

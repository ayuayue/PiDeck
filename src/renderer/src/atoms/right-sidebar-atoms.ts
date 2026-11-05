import { atom } from "jotai";

/**
 * 会话状态（待办 / 子代理）当前是否只挂在右侧边栏。
 *
 * 由 App 按设置 sessionStatusPlacement 写入（placement === "sidebar"）。SessionView /
 * SessionStartSurface 据此**始终**隐藏输入框上方的同类折叠条：用户把显示位置选到右侧边栏后，
 * 输入框上方就不再出现，与下半区此刻是展开还是收起无关。
 *
 * 收起态的信息可见性由 tab 栏上的计数角标兜底（见 statusPanel/SessionStatusPanel 的
 * CollapsedStatusBar）；展开/收起偏好照旧持久化在 localStorage `pid:right-sidebar-stack-v1`，
 * 不因切换设置被重置。
 *
 * 2027-02 之前这里是「面板可见地展示某会话」的 atomFamily + rightSidebarStatusSessionIdAtom，
 * 面板一收起横栏就重新出现，造成「选了右侧边栏，输入框上方还是能看到待办」。
 */
export const sessionStatusInSidebarAtom = atom(false);

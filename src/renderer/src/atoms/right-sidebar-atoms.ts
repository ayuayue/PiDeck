import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { registerSessionFamilyForDisposal } from "./session-family-registry";

/**
 * 右侧边栏「会话状态」面板的跨组件状态。
 *
 * rightSidebarStatusSessionIdAtom：面板当前「可见地」展示的会话（抽屉打开 + 下半区展开 +
 * 有会话），否则 null。SessionView / SessionStartSurface 据此隐藏输入框上方的
 * 待办/子代理折叠条，避免同屏重复；只命中这一个会话，分屏另一栏不受影响。
 *
 * 2027-02 移除「最近一轮 run」系列 atom：它们的唯一消费者是面板的文件 tab，
 * 文件修改已改为每轮末尾的 chip 行（turn/TurnFileChanges），不再需要跨组件发布 run。
 */
export const rightSidebarStatusSessionIdAtom = atom<string | null>(null);

export const sessionStatusInSidebarAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => atom((get) => get(rightSidebarStatusSessionIdAtom) === sessionId)));

import {
  createContext,
  useContext,
  useMemo,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentTab, AgentUiResponse, ChatMessage, GitBranchInfo, ImageContent, Project } from "../../../../shared/types";
import type { QueuedPrompt } from "../../hooks/useQueuedPrompt";
import type { NoticeId } from "../../utils/notice";
import type { TerminalDockStateByOwner } from "../../terminalDockState";

/** 打开会话文件时由栏级 injector 绑定的解析与授权上下文。 */
export type SessionFileOpenContext = {
  baseDir?: string;
  projectId?: string;
  projectRoot?: string;
};

/**
 * 会话栏共享服务：跨分屏双栏稳定不变的回调与资源。
 * 身份（sessionId / focused）不进这里，避免大 props 袋透传。
 */
export type SessionPaneServices = {
  /** 把某会话从预览 Tab 晋升为常驻 Tab（发消息等主动交互时调用；非预览时幂等） */
  promoteSessionToPermanent: (sessionId: string) => void;
  isLanWeb: boolean;
  showToast: (msg: string, dur?: number) => void;
  onOpenFile: (path: string, line?: number, context?: SessionFileOpenContext) => void;
  onDiffFile: (path: string) => void;
  onPreviewImage: (img: ImageContent | null) => void;
  abortAgent: (agentId?: string) => Promise<void>;
  restartActiveAgent: (agentId?: string) => Promise<void>;
  runCreateSessionDraft: () => Promise<void>;
  enqueueSessionPrompt: (
    sessionId: string,
    snapshot: {
      displayText: string;
      message: string;
      images?: ImageContent[];
      agentMode: string;
      behavior?: "steer" | "followUp";
    },
  ) => boolean;
  insertQuickPrompt: (sessionId: string, message: string) => void;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  resendUserMessage?: (message: ChatMessage) => void;
  editMessage?: (messageId: string, newText: string, entryId?: string) => void;
  deleteMessage?: (messageId: string, entryId?: string) => void;
  forkFromUserMessage?: (message: ChatMessage) => void;
  forkingMessageId?: string | null;
  openSidebarSessionById?: (projectId: string, sessionId: string) => Promise<void>;
  /** 后台 Ask toast「前往会话」：按 sessionId 聚焦目标会话并登记常驻 Tab（App 级实现） */
  focusAskSessionById?: (sessionId: string) => void;
  agents: AgentTab[];
  queuedPromptsBySession: Record<string, QueuedPrompt[]>;
  queueRetract: (sessionId: string, prompt: QueuedPrompt) => void;
  queueDiscard: (sessionId: string, promptId: string) => void;
  queueChangeBehavior: (sessionId: string, promptId: string, behavior: "steer" | "followUp") => void;
  queueFlushBySessionRef: MutableRefObject<Set<string>>;
  restartingAgentId: string | null;
  sessionDurationByAgent: Record<string, number>;
  activeProjectId: string | undefined;
  gitInfo: GitBranchInfo;
  /** 底栏分支下拉的切换回调（owner 为 App 级 switchBranch，保持 Git 面板同步） */
  onSwitchBranch: (branch: string) => void;
  showThinking: boolean;
  validCommandNames: Set<string>;
  validFilePaths: Set<string>;
  terminalStatesByOwner: TerminalDockStateByOwner;
  availableTerminalHeight: number;
  /** App 级激活 owner 键（agent:<id> / project:<id>）：分屏去重参照 + 大纲按钮状态） */
  activeTerminalOwnerKey?: string;
  /** 按 owner key 开关终端（分屏各栏用自己的 owner 调，不再只写「当前激活 owner」） */
  setTerminalOpenByOwnerKey: (ownerKey: string, open: boolean) => void;
  setTerminalCollapsedByOwnerKey: (ownerKey: string, collapsed: boolean) => void;
  /** 回写终端分屏高度（全局单份，useTerminalDock 内部持久化） */
  setTerminalHeight: (height: number) => void;
  environmentDialog: boolean;
  /** 修改内置对话区（Chat）的聊天记录保存目录（弹选择器 + 主进程写入 + 重扫会话） */
  changeChatPath: (project: Project) => Promise<void>;
  showNotice: (
    msg: string,
    dur?: number,
    kind?: "info" | "warning" | "error",
  ) => NoticeId | undefined;
  api: {
    sessions: {
      sendUiResponse: (input: {
        sessionId: string;
        requestId: string;
        agentId: string;
        runtimeGeneration: number;
        response: AgentUiResponse;
      }) => Promise<void>;
    };
  };
  jumpToMessageRef: MutableRefObject<((messageId: string) => void) | null>;
  layoutRefs: {
    chatHeaderRef: RefObject<HTMLDivElement | null>;
    composerRef: RefObject<HTMLElement | null>;
    composerOffsetHeight: number;
    terminalRowHeight: number;
  };
  /** 面板级退出分屏（全屏按钮）：该会话从布局移除，同组兄弟合并占据其位置 */
  exitSessionSplit: (sessionId: string) => void;
};

const SessionPaneServicesContext = createContext<SessionPaneServices | null>(null);

export function SessionPaneServicesProvider(props: {
  value: SessionPaneServices;
  children: ReactNode;
}) {
  // 调用方应尽量 memo value；此处再包一层避免无意义的 Provider identity 抖动误导
  const value = useMemo(() => props.value, [props.value]);
  return (
    <SessionPaneServicesContext.Provider value={value}>
      {props.children}
    </SessionPaneServicesContext.Provider>
  );
}

export function useSessionPaneServices(): SessionPaneServices {
  const value = useContext(SessionPaneServicesContext);
  if (!value) {
    throw new Error("useSessionPaneServices must be used under SessionPaneServicesProvider");
  }
  return value;
}

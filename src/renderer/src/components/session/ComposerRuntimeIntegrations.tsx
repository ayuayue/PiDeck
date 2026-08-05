import { useAtomValue } from "jotai";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms";
import { useFeishuBridge } from "../../hooks/useFeishuBridge";
import { FeishuLinkIndicator } from "../feishu/FeishuLinkIndicator";
import { ExtensionWidgetCard } from "./ComposerParts";

export type RuntimeHandle = {
  agentId: string;
  runtimeGeneration: number;
};

export function sameRuntimeHandle(
  left: RuntimeHandle | undefined,
  right: RuntimeHandle | undefined,
): boolean {
  return left?.agentId === right?.agentId &&
    left?.runtimeGeneration === right?.runtimeGeneration;
}

export function widgetDismissalScope(
  sessionId: string,
  runtimeGeneration: number | undefined,
): string {
  return `${sessionId}:${runtimeGeneration ?? "detached"}`;
}

export function isCoherentComposerRuntimeUi(
  runtime: RuntimeHandle | undefined,
  runtimeUi: { agentId: string; runtimeGeneration: number } | undefined,
): boolean {
  return Boolean(
    runtime &&
    runtimeUi &&
    runtimeUi.agentId === runtime.agentId &&
    runtimeUi.runtimeGeneration === runtime.runtimeGeneration,
  );
}

export type ComposerRuntimeSlots = {
  widgets: ReactNode;
  feishuIndicator: ReactNode;
};

export function ComposerRuntimeIntegrations(props: {
  sessionId: string;
  widgetsCollapsed?: boolean;
  children: (slots: ComposerRuntimeSlots) => ReactNode;
}) {
  const runtime = useAtomValue(
    sessionRuntimeBySessionIdAtomFamily(props.sessionId),
  );
  const runtimeUi = useAtomValue(
    sessionRuntimeUiBySessionIdAtomFamily(props.sessionId),
  );
  const feishu = useFeishuBridge();
  const [sessionBotId, setSessionBotId] = useState<string>();
  // 关闭是「临时」的：dismiss 只存在组件内存，不写入 localStorage，
  // 刷新 / 重挂载 / 切换会话后自动恢复，widget 不会永久消失。
  const [dismissedBySession, setDismissedBySession] = useState<Record<string, string[]>>({});
  const botRequestSequenceRef = useRef(0);
  const runtimeHandleRef = useRef<RuntimeHandle | undefined>(undefined);
  const runtimeHandle = runtime?.agentId
    ? {
        agentId: runtime.agentId,
        runtimeGeneration: runtime.runtimeGeneration,
      }
    : undefined;
  runtimeHandleRef.current = runtimeHandle;

  useEffect(() => {
    const sequence = ++botRequestSequenceRef.current;
    setSessionBotId(undefined);
    if (!runtimeHandle) return;
    const expected = runtimeHandle;
    void feishu.getSessionBot(props.sessionId).then((botId) => {
      if (
        sequence === botRequestSequenceRef.current &&
        sameRuntimeHandle(runtimeHandleRef.current, expected)
      ) {
        setSessionBotId(botId);
      }
    }).catch(() => undefined);
  }, [
    props.sessionId,
    runtimeHandle?.agentId,
    runtimeHandle?.runtimeGeneration,
    feishu.bindings,
  ]);

  useEffect(() => {
    if (!sessionBotId) return;
    if (!feishu.bots.some((bot) => bot.id === sessionBotId)) {
      setSessionBotId(undefined);
    }
  }, [feishu.bots, sessionBotId]);

  const coherentRuntimeUi = isCoherentComposerRuntimeUi(runtimeHandle, runtimeUi)
    ? runtimeUi
    : undefined;
  const dismissalScope = widgetDismissalScope(
    props.sessionId,
    runtimeHandle?.runtimeGeneration,
  );
  const dismissed = dismissedBySession[dismissalScope] ?? [];
  const widgets = coherentRuntimeUi?.widgets ?? {};

  function dismissWidget(widgetKey: string) {
    setDismissedBySession((current) => {
      const existing = current[dismissalScope] ?? [];
      if (existing.includes(widgetKey)) return current;
      return {
        ...current,
        [dismissalScope]: [...existing, widgetKey],
      };
    });
  }

  async function setRuntimeBot(sessionId: string, botId: string | null) {
    const expected = runtimeHandleRef.current;
    // 不拦截无 runtime 的请求：历史会话未启动 Agent 时，主进程 feishuSessionBotSet
    // 会先自动启动 runtime 再建飞书镜像（与桌面端启动同一链路）。此处拦截会导致
    // 「打开历史会话点飞书连接」永远静默失败。
    const result = await feishu.setSessionBot(sessionId, botId);
    if (result.success) {
      // 请求前无 runtime（expected 为空）时主进程已代为启动，绑定结果必须生效；
      // 仅当请求期间 runtime 被替换（A→B）时才丢弃旧结果，避免 UI 与真实绑定不一致。
      if (!expected || sameRuntimeHandle(runtimeHandleRef.current, expected)) {
        setSessionBotId(botId ?? undefined);
      }
    }
    return result;
  }

  const widgetSlot = props.widgetsCollapsed || Object.keys(widgets).length === 0
    ? null
    : (
        <div className="extension-widgets-container">
          {Object.entries(widgets)
            .filter(([widgetKey]) => !dismissed.includes(widgetKey))
            .map(([widgetKey, lines]) => (
              <ExtensionWidgetCard
                key={`${props.sessionId}:${runtimeHandle?.runtimeGeneration}:${widgetKey}`}
                widgetKey={widgetKey}
                lines={lines}
                sessionIdOrPath={props.sessionId}
                onClose={() => dismissWidget(widgetKey)}
              />
            ))}
        </div>
      );
  // main 对齐：只要有已配置的 Bot 就显示飞书入口。Agent 未启动时点连接会由主进程
  // 自动启动 runtime 并绑定（feishuSessionBotSet 内 activateRuntime），不再需要先手动启动。
  const feishuSlot = feishu.bots.length > 0 ? (
    <FeishuLinkIndicator
      status={feishu.status}
      bots={feishu.bots}
      activeSessionId={props.sessionId}
      activeBotId={feishu.activeBotId}
      sessionBotId={sessionBotId}
      isConnected={feishu.isConnected}
      connecting={feishu.connecting}
      onConnectByBot={feishu.connectByBot}
      onDisconnect={feishu.disconnect}
      onSetSessionBot={setRuntimeBot}
    />
  ) : null;

  return <>{props.children({ widgets: widgetSlot, feishuIndicator: feishuSlot })}</>;
}

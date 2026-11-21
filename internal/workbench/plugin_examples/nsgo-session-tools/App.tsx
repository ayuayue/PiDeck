import { host, signal, Text, View } from "nsgo";
import { Button } from "nsgo/ui";
import { summarizeSessions, type SessionTotals } from "./sessions";

// One signed bundle exports two UI components and a function. Loading the
// function runtime does not mount UI or start a request at module scope.
export async function readSessionTotals(): Promise<SessionTotals> {
  const rows = await host.call("sessions.list", { limit: 200 }, { timeout: 5000 });
  return summarizeSessions(rows);
}

// A host may provide translated copy through JSON props. Standalone example
// hosts keep the Chinese defaults; no host values or callbacks cross the VM.
type SessionCopy = {
  title: string;
  totals: string;
  backends: string;
  badge: string;
  empty: string;
  waiting: string;
  busy: string;
  updated: string;
  denied: string;
  refresh: string;
  refreshBadge: string;
};
const defaultCopy: SessionCopy = {
  title: "会话统计",
  totals: "{sessions} 个会话 · {messages} 条消息",
  backends: "pi：{pi} · ACP：{acp}",
  badge: "会话数：{sessions}",
  empty: "暂无统计",
  waiting: "等待刷新",
  busy: "正在读取摘要…",
  updated: "已更新",
  denied: "宿主未授予会话摘要权限",
  refresh: "刷新统计",
  refreshBadge: "刷新徽标",
};
type SessionProps = { title?: string; copy?: Partial<SessionCopy> };

function formatTotals(template: string, totals: SessionTotals): string {
  return template.replace(/\{(sessions|messages|pi|acp)\}/g,
    (_match, key: keyof SessionTotals) => String(totals[key]));
}

function sessionState(copy: SessionCopy) {
  const totals = signal<SessionTotals | null>(null);
  const busy = signal(false);
  const status = signal(copy.waiting);
  function refresh() {
    if (busy()) return;
    busy.set(true);
    status.set(copy.busy);
    readSessionTotals().then(
      (value) => {
        totals.set(value);
        busy.set(false);
        status.set(copy.updated);
      },
      (error) => {
        totals.set(null);
        busy.set(false);
        status.set(error?.code === "ERR_ACCESS_DENIED"
          ? copy.denied : String(error?.message ?? error));
      },
    );
  }
  return { totals, busy, status, refresh };
}

export function SessionPanel(props: SessionProps = {}) {
  const copy = { ...defaultCopy, ...props.copy };
  const state = sessionState(copy);
  state.refresh();
  return (
    <View testID="session-tools-panel" class="gap-3 p-4">
      <Text class="text-lg font-semibold">{props.title ?? copy.title}</Text>
      <Text testID="session-tools-totals">
        {() => {
          const totals = state.totals();
          return totals ? formatTotals(copy.totals, totals) : copy.empty;
        }}
      </Text>
      <Text testID="session-tools-backends">
        {() => {
          const totals = state.totals();
          return totals ? formatTotals(copy.backends, totals) : "";
        }}
      </Text>
      <Button text={copy.refresh} testID="session-tools-refresh"
        disabled={state.busy()} onPress={state.refresh} />
      <Text testID="session-tools-status" role="status">{state.status}</Text>
    </View>
  );
}

export function SessionBadge(props: SessionProps = {}) {
  const copy = { ...defaultCopy, ...props.copy };
  const state = sessionState(copy);
  state.refresh();
  return (
    <View testID="session-tools-badge" class="gap-2 p-3">
      <Text testID="session-tools-badge-totals">
        {() => {
          const totals = state.totals();
          return totals ? formatTotals(copy.badge, totals) : copy.empty;
        }}
      </Text>
      <Button text={copy.refreshBadge} testID="session-tools-badge-refresh"
        disabled={state.busy()} onPress={state.refresh} />
      <Text role="status">{state.status}</Text>
    </View>
  );
}

import { host, signal, Text, View } from "nsgo";
import { Button } from "nsgo/ui";
import { summarizeSessions, type SessionTotals } from "./sessions";

// One signed bundle exports two UI components and a function. Loading the
// function runtime does not mount UI or start a request at module scope.
export async function readSessionTotals(): Promise<SessionTotals> {
  const rows = await host.call("sessions.list", { limit: 200 }, { timeout: 5000 });
  return summarizeSessions(rows);
}

function sessionState() {
  const totals = signal<SessionTotals | null>(null);
  const busy = signal(false);
  const status = signal("等待刷新");
  function refresh() {
    if (busy()) return;
    busy.set(true);
    status.set("正在读取摘要…");
    readSessionTotals().then(
      (value) => {
        totals.set(value);
        busy.set(false);
        status.set("已更新");
      },
      (error) => {
        totals.set(null);
        busy.set(false);
        status.set(error?.code === "ERR_ACCESS_DENIED"
          ? "宿主未授予会话摘要权限" : String(error?.message ?? error));
      },
    );
  }
  return { totals, busy, status, refresh };
}

export function SessionPanel(props: { title: string }) {
  const state = sessionState();
  state.refresh();
  return (
    <View testID="session-tools-panel" class="gap-3 p-4">
      <Text class="text-lg font-semibold">{props.title}</Text>
      <Text testID="session-tools-totals">
        {() => {
          const totals = state.totals();
          return totals ? `${totals.sessions} 个会话 · ${totals.messages} 条消息` : "暂无统计";
        }}
      </Text>
      <Text testID="session-tools-backends">
        {() => {
          const totals = state.totals();
          return totals ? `pi：${totals.pi} · ACP：${totals.acp}` : "";
        }}
      </Text>
      <Button text="刷新统计" testID="session-tools-refresh"
        disabled={state.busy()} onPress={state.refresh} />
      <Text testID="session-tools-status" role="status">{state.status}</Text>
    </View>
  );
}

export function SessionBadge() {
  const state = sessionState();
  state.refresh();
  return (
    <View testID="session-tools-badge" class="gap-2 p-3">
      <Text testID="session-tools-badge-totals">
        {() => {
          const totals = state.totals();
          return totals ? `会话数：${totals.sessions}` : "暂无统计";
        }}
      </Text>
      <Button text="刷新徽标" testID="session-tools-badge-refresh"
        disabled={state.busy()} onPress={state.refresh} />
      <Text role="status">{state.status}</Text>
    </View>
  );
}

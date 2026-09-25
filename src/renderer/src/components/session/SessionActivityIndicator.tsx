import { useMemo } from "react";
import { atom, useAtomValue } from "jotai";
import { LoaderCircle } from "lucide-react";
import { sessionRuntimeUiByIdAtom } from "../../atoms/session-atoms";
import { hasPendingAskForSession } from "../../utils/askUi";
import { t } from "../../i18n";

/** 标题、侧栏和项目汇总共用同一运行指示；等待用户输入不是计算中。 */
export function SessionActivityIndicator(props: { status?: string | null; sessionId?: string; waiting?: boolean; busy?: boolean }) {
	const pendingAtom = useMemo(() => atom((get) => hasPendingAskForSession(props.sessionId, get(sessionRuntimeUiByIdAtom))), [props.sessionId]);
	const pending = useAtomValue(pendingAtom);
	const waiting = props.waiting || pending || props.status === "waiting" || props.status === "pending";
	const running = props.busy || (!waiting && (props.status === "running" || props.status === "starting"));
	if (running) return <LoaderCircle className="session-activity-spinner size-3 shrink-0 animate-pideck-spin text-warning" aria-label={t("app.statusRunning")} />;
	if (waiting) return <span className="session-activity-waiting size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />;
	if (props.status === "idle") return <span className="size-1.5 shrink-0 rounded-full bg-info" aria-label={t("app.statusIdle")} />;
	if (props.status === "error") return <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-label={t("app.statusError")} />;
	return null;
}

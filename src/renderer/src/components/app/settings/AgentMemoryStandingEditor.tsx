/**
 * 「记忆」tab 的常驻指令（STANDING.md）编辑区。
 *
 * STANDING 的语义是「用户显式同意、每条会话都注入的常驻指令」，所以它**不是** Agent 工具的
 * 写入 target——写入口只开在这里，与「用户手改文件」同级。编辑的就是文件原文：条目之间用
 * `§` 独行分隔（与其它记忆文件同一分节格式），保存时整文件替换并强制重同步检索索引。
 *
 * 与开关不同，这里不走设置 draft/保存流程：记忆文件在 Agent 会话里也可能被读，
 * 用户点「保存」就应该立即生效，不该等整份设置一起保存。
 */

import { useCallback, useEffect, useState } from "react";
import { Save } from "lucide-react";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Textarea } from "../../ui-shadcn/textarea";
import { describeAgentMemoryCode } from "./agentMemoryLabels";

/** 与 FILE_BUDGETS.standing.maxChars 同源：超限在输入侧就挡住，保存按钮禁用。 */
const STANDING_MAX_CHARS = 4000;

export function AgentMemoryStandingEditor(props: { onChanged?: () => void }) {
	const [content, setContent] = useState("");
	const [saved, setSaved] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const result = await desktopApi.agentMemory.standingRead();
		if (result.ok) {
			setContent(result.value);
			setSaved(result.value);
		} else {
			setError(describeAgentMemoryCode(result.code));
		}
		setLoading(false);
	}, []);

	useEffect(() => {
		void refresh().catch((cause: unknown) => {
			setError(cause instanceof Error ? cause.message : String(cause));
			setLoading(false);
		});
	}, [refresh]);

	const dirty = content !== saved;
	const overBudget = content.length > STANDING_MAX_CHARS;

	const runSave = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await desktopApi.agentMemory.standingWrite({ content });
			if (result.ok) {
				setSaved(content);
				props.onChanged?.();
			} else {
				setError(describeAgentMemoryCode(result.code));
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			{loading ? (
				<p className="text-xs text-fg-muted">{t("settings.agentMemoryStandingLoading")}</p>
			) : (
				<>
					<Textarea value={content} onChange={(event) => setContent(event.target.value)} rows={6} maxLength={STANDING_MAX_CHARS + 500} placeholder={t("settings.agentMemoryStandingPlaceholder")} className="min-h-28 font-mono text-xs" />
					<div className="flex items-center justify-between gap-3">
						<span className={`text-xs ${overBudget ? "text-destructive" : "text-muted-foreground"}`}>{t("settings.agentMemoryStandingChars", { chars: String(content.length), max: String(STANDING_MAX_CHARS) })}</span>
						<Button size="sm" disabled={!dirty || overBudget || busy} onClick={() => void runSave()}>
							<Save className="size-3.5" />
							{t("settings.agentMemoryStandingSave")}
						</Button>
					</div>
				</>
			)}
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

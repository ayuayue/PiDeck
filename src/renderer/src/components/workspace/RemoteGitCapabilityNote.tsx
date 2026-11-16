import { Info } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { shouldShowRemoteGitCapabilityNote, type RemoteGitCapabilityNoteContext, type RemoteGitCapabilityNoteKind } from "../../utils/remoteGitCapabilityNotes";

/**
 * 远端 Git 能力说明条：只解释「这个位置没有哪些能力」，不渲染任何假按钮或成功分支。
 * 文案复用现有 live key（historyReadOnly / commitHint / compareHint），多仓说明新增 repoScopeSingle。
 */
const NOTE_KEYS: Record<RemoteGitCapabilityNoteKind, TranslationKey> = {
	history: "remoteGit.historyReadOnly",
	commit: "remoteGit.commitHint",
	repoScope: "remoteGit.repoScopeSingle",
	compare: "remoteGit.compareHint",
};

export function RemoteGitCapabilityNote(props: { kind: RemoteGitCapabilityNoteKind; context?: RemoteGitCapabilityNoteContext }) {
	if (!shouldShowRemoteGitCapabilityNote(props.kind, props.context)) return null;
	return (
		// 与本机面板的说明文字同一个声音：小字号、三级文字色，不占一整段视觉重量。
		<p data-testid={`remote-git-capability-note-${props.kind}`} className="flex items-start gap-1 px-2.5 py-1 text-micro leading-[18px] text-[var(--git-desc-fg)]">
			<Info size={11} aria-hidden="true" className="mt-[3px] shrink-0" />
			<span className="min-w-0">{t(NOTE_KEYS[props.kind])}</span>
		</p>
	);
}

import { ScratchPadPanel } from "./ScratchPadPanel";
import type { useScratchPad } from "../../hooks/useScratchPad";

/** 抽屉只负责呈现；关闭末帧仍由 WorkspaceDrawerHost 保留，草稿与保存计时器不随面板卸载。 */
export function ScratchPadDrawer({ controller }: { controller: ReturnType<typeof useScratchPad> }) {
	return (
		<ScratchPadPanel
			drafts={controller.drafts}
			currentDraftPath={controller.currentDraftPath}
			content={controller.content}
			mode={controller.mode}
			isSaving={controller.isSaving}
			hasError={controller.hasError}
			onChangeContent={controller.setContent}
			onSetMode={controller.setMode}
			onToggleCheckbox={controller.toggleTaskCheckbox}
			onExport={() => void controller.exportFile()}
			onSelectDraft={(path) => void controller.selectDraft(path)}
			onCreateDraft={() => void controller.createDraft()}
			onDeleteDraft={(path) => void controller.deleteDraft(path)}
			onClose={controller.close}
		/>
	);
}

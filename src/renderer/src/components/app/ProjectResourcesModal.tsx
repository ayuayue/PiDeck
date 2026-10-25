import { FolderOpen, X } from "lucide-react";
import { ConfigPane } from "../../ConfigModal";
import { isChatProject } from "../../rendererUtils";
import type { Project } from "../../../../shared/types";
import { t } from "../../i18n";
import { Alert, AlertDescription } from "../ui-shadcn/alert";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";

/**
 * Project-context resource manager.
 * The resource pages themselves are owned by ConfigPane so the project menu and
 * Settings share the same list/store/editor behavior. This shell only fixes the
 * project scope and keeps the project selector out of the context-menu flow.
 */
export function ProjectResourcesModal(props: { project: Project; onClose: () => void }) {
	const chatProject = isChatProject(props.project);

	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} stagger className="config-modal flex h-[min(760px,calc(100vh-32px))] w-[80vw] max-w-[80vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1300px,80vw)]">
				<DialogHeader className="shrink-0 gap-1 border-b border-border-subtle px-6 py-4 text-left">
					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0">
							<DialogTitle className="flex items-center gap-2 text-base">
								<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
									<FolderOpen aria-hidden="true" />
								</span>
								{t("projectResources.title")}
							</DialogTitle>
							<DialogDescription className="mt-1 truncate font-mono text-micro" title={props.project.path}>
								{props.project.path}
							</DialogDescription>
						</div>
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>

				{chatProject ? (
					<div className="flex min-h-0 flex-1 items-center justify-center px-6">
						<Alert className="max-w-md">
							<AlertDescription className="text-center">{t("projectResources.chatUnsupported")}</AlertDescription>
						</Alert>
					</div>
				) : (
					<ConfigPane resourceOnly projectId={props.project.id} projectKind={props.project.kind} projectName={props.project.name} projects={[props.project]} onClose={props.onClose} onSaved={() => undefined} />
				)}
			</DialogContent>
		</Dialog>
	);
}

import { useEffect, useRef, useState } from "react";
import { FileEdit } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import { CodeMirrorEditor } from "../components/app/CodeMirrorEditor";
import { useConfigEditor } from "./useConfigEditorApi";
import { t } from "../i18n";

/** Remote file extensions use the same source editor, with a version captured when the dialog opens. */
export function RemoteExtensionSourceButton({ path, onSaved }: { path: string; onSaved: () => void }) {
	const { api } = useConfigEditor();
	const [open, setOpen] = useState(false);
	const [discard, setDiscard] = useState(false);
	const [content, setContent] = useState("");
	const [baseline, setBaseline] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	useEffect(() => {
		setOpen(false);
		setContent("");
		setBaseline("");
		setBusy(false);
		setDiscard(false);
		return () => {
			generation.current += 1;
		};
	}, [api]);
	async function show() {
		const started = ++generation.current;
		setOpen(true);
		setBusy(true);
		setError(null);
		setContent("");
		setBaseline("");
		try {
			const text = await api.files.readContent(path);
			if (started === generation.current) {
				setContent(text);
				setBaseline(text);
			}
		} catch (caught) {
			if (started === generation.current) setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (started === generation.current) setBusy(false);
		}
	}
	async function save() {
		const started = generation.current;
		setBusy(true);
		setError(null);
		try {
			await api.files.writeContent(path, content);
			if (started === generation.current) {
				setBaseline(content);
				onSaved();
			}
		} catch (caught) {
			if (started === generation.current) setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (started === generation.current) setBusy(false);
		}
	}
	function close() {
		if (busy) return;
		if (content !== baseline) setDiscard(true);
		else setOpen(false);
	}
	return (
		<>
			<Button variant="ghost" size="icon-sm" title={t("remoteResources.source")} onClick={() => void show()}>
				<FileEdit data-icon="inline-start" />
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) close();
				}}
			>
				<DialogContent
					className="max-w-4xl"
					onEscapeKeyDown={(event) => {
						event.preventDefault();
						close();
					}}
				>
					<DialogHeader>
						<DialogTitle>{t("remoteResources.source")}</DialogTitle>
					</DialogHeader>
					<p className="truncate font-mono text-xs text-muted-foreground" title={path}>
						{path}
					</p>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<CodeMirrorEditor value={content} language="typescript" height="55vh" readOnly={busy} onChange={setContent} />
					<DialogFooter>
						<Button variant="outline" disabled={busy} onClick={close}>
							{t("common.close")}
						</Button>
						<Button disabled={busy || content === baseline} onClick={() => void save()}>
							{t(busy ? "common.loading" : "common.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{discard && (
				<ConfirmDialog
					title={t("editor.dirtyCloseTitle")}
					message={t("editor.dirtyCloseMessage", { file: path })}
					onCancel={() => setDiscard(false)}
					onConfirm={() => {
						setDiscard(false);
						setOpen(false);
					}}
				/>
			)}
		</>
	);
}

// 导入面板「粘贴 / 选择文件」入口：粘贴 Base64/选 .txt 文件 → 解析（加密则输密码）→ 上抛供应商草稿。
// 逻辑逐字恢复自 26de030fc^ 的 ModelsImportPanel 输入步（ADR 0024：双源共存，移除任一入口需用户决策）。
import { useRef, useState } from "react";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import type { ProviderConfig } from "./configTypes";
import { decodeModelsTransfer, type DecodeModelsTransferResult } from "./modelsTransfer";

interface ModelsImportPasteStepProps {
	onImported: (providers: Record<string, ProviderConfig>) => void;
}

const errorText = (error: Extract<DecodeModelsTransferResult, { ok: false }>["error"]): string => {
	if (error === "encrypted-no-password") return t("config.models.transfer.needPassword");
	if (error === "wrong-password") return t("config.models.transfer.wrongPassword");
	if (error === "unsupported-version") return t("config.models.transfer.unsupportedVersion");
	if (error === "wrong-kind") return t("config.models.transfer.wrongKind");
	return t("config.models.transfer.invalid");
};

/** 粘贴/文件导入入口步：解析成功即经 onImported 上抛，进入面板共享的勾选/冲突流程。 */
export function ModelsImportPasteStep(props: ModelsImportPasteStepProps) {
	const [text, setText] = useState("");
	const [password, setPassword] = useState("");
	const [needsPassword, setNeedsPassword] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const handleParse = async () => {
		const result = await decodeModelsTransfer(text, password.trim() || undefined);
		if (!result.ok) {
			if (result.error === "encrypted-no-password") setNeedsPassword(true);
			setError(errorText(result.error));
			return;
		}
		props.onImported(result.providers);
	};

	// 导入文件只应是小体积 base64 文本；限制 4MB 防误选大文件把渲染层堵死（自我 DoS 防护）。
	const handleFile = async (file: File) => {
		if (file.size > 4 * 1024 * 1024) {
			setError(t("config.models.transfer.invalid"));
			return;
		}
		setText(await file.text());
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* scroll-ok: bounded —— 行数有硬上限（受控分页 / 上限常量 / 固定枚举），不随数据无限增长。 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="space-y-3">
					<Label htmlFor="models-import-text">{t("config.models.transfer.pasteLabel")}</Label>
					<Input id="models-import-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("config.models.transfer.pastePlaceholder")} />
					<Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
						{t("config.models.transfer.pickFile")}
					</Button>
					<input
						ref={fileInputRef}
						type="file"
						accept=".txt"
						className="hidden"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void handleFile(file);
							e.target.value = ""; // 重置以复选同一文件
						}}
					/>
					{needsPassword && (
						<div className="space-y-1">
							<Label htmlFor="models-import-password">{t("config.models.transfer.password")}</Label>
							<Input id="models-import-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
						</div>
					)}
					{error && <p className="text-sm text-danger">{error}</p>}
				</div>
			</div>
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
				<Button size="sm" onClick={handleParse} disabled={!text.trim()}>
					{t("config.models.transfer.parse")}
				</Button>
			</div>
		</div>
	);
}

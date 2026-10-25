/**
 * 单供应商 pi ↔ DSH 一键互迁按钮。
 *
 * 点按钮后直接迁当前行；目标已有同名供应商时先确认覆盖。
 * 密钥是否带过去由主进程结果 copiedKey 告知，页面不回显明文。
 *
 * 覆盖确认走应用内的 ConfirmDialog 而不是 window.confirm：后者在 Electron 里是
 * 系统原生弹框，字体、配色、暗色主题都跟应用脱节（Web 端则是浏览器原生框），
 * 而且它会同步阻塞渲染进程。代价是流程要从「一句 if」拆成
 * 「预检 → 弹框 → 执行」三步——确认是异步的，没法再写在同一个函数体里。
 */
import { useState } from "react";
import { ArrowLeftRight, LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import type { ProviderMigrationDirection } from "../../../shared/types/providerMigration";

export function ProviderMigrationButton(props: {
	direction: ProviderMigrationDirection;
	provider: string;
	/** 迁完后刷新本页（pi 模型表 / DSH settings.describe）。 */
	onMigrated?: () => void;
	className?: string;
}) {
	const [busy, setBusy] = useState(false);
	/** 目标端已有同名供应商，等用户在弹框里确认覆盖 */
	const [overwritePending, setOverwritePending] = useState(false);
	const label = props.direction === "pi-to-dsh" ? t("config.migrate.toDsh") : t("config.migrate.toPi");

	/** 真正执行迁移（预检与覆盖确认都已完成） */
	const applyMigration = async () => {
		setBusy(true);
		try {
			const result = await desktopApi.config.applyProviderMigration(props.direction, props.provider);
			if (!result.ok) {
				showNotice(result.error || t("config.migrate.failed"), 5000);
				return;
			}
			showNotice(result.copiedKey ? t("config.migrate.okWithKey", { name: props.provider }) : t("config.migrate.okNoKey", { name: props.provider }), 4000);
			// 对端配置页可能已挂载但未重拉；广播后 DSH/Pi 模型页各自刷新。
			window.dispatchEvent(new CustomEvent("pideck:provider-migrated", { detail: { direction: props.direction, provider: props.provider } }));
			props.onMigrated?.();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : t("config.migrate.failed"), 5000);
		} finally {
			setBusy(false);
		}
	};

	const run = async () => {
		if (busy || !props.provider.trim()) return;
		// 第一步：预检。是否弹确认框取决于「目标端是否已有同名供应商」，所以先探一次。
		setBusy(true);
		let targetExists = false;
		try {
			const preview = await desktopApi.config.previewProviderMigration(props.direction);
			targetExists = Boolean(preview.providers.find((item) => item.name === props.provider)?.targetExists);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : t("config.migrate.failed"), 5000);
			setBusy(false);
			return;
		}
		// 先归位 busy 再决定下一步：弹框期间按钮不该停在 loading 态
		setBusy(false);
		if (targetExists) {
			setOverwritePending(true);
			return;
		}
		await applyMigration();
	};

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className={props.className ?? "size-7"}
				disabled={busy}
				title={label}
				aria-label={label}
				onClick={(event) => {
					event.stopPropagation();
					void run();
				}}
			>
				{busy ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <ArrowLeftRight className="size-3.5" aria-hidden="true" />}
			</Button>
			{overwritePending ? (
				<ConfirmDialog
					// 覆盖会替换对端的地址 / 模型 / 密钥，属破坏性操作
					danger
					title={t("config.migrate.overwriteTitle")}
					message={t("config.migrate.overwriteConfirm", { name: props.provider })}
					confirmLabel={t("config.migrate.overwriteAction")}
					onCancel={() => setOverwritePending(false)}
					onConfirm={() => {
						setOverwritePending(false);
						void applyMigration();
					}}
				/>
			) : null}
		</>
	);
}

import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import type { RemoteHostPinRequest } from "../../../../../shared/types/remoteHost";

/**
 * 指纹确认弹框：添加主机流程里**唯一必须由人做判断**的一步。
 *
 * 为什么不能像某些工具那样保存即完成：我们连的是用户自己的任意主机，没有中心信任源。TOFU
 * （首次使用即信任）等于把「中间人」变成默认结果，因此指纹必须展示给用户，由他对照自己的核验结果
 * 决定。这也是为什么这里没有「记住我的选择」——一次性确认才有意义。
 *
 * 指纹、主机、用户、端口都由主进程在推送里给出；渲染层**只能回答同意/拒绝**，不能自己构造或修改
 * 这些值（改一处都会让确认变成走过场）。
 */
export function FingerprintConfirmDialog(props: { request: RemoteHostPinRequest; busy: boolean; onAnswer: (choice: "approve" | "deny") => void }) {
	const { request } = props;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				// 关闭等同拒绝：没有确认就不该保存信任锚。
				if (!open) props.onAnswer("deny");
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("settings.connections.pin.title")}</DialogTitle>
					<DialogDescription>{t("settings.connections.pin.hint")}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2 text-body">
					<div className="flex items-center justify-between gap-3">
						<span className="text-muted-foreground">{t("settings.connections.pin.target")}</span>
						<span className="font-medium">
							{request.user}@{request.hostName}:{request.port}
						</span>
					</div>
					{/* 指纹是这一步的全部意义所在：等宽字体 + 可选中，方便用户逐字符对照。 */}
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground">{t("settings.connections.pin.fingerprints")}</span>
						<ul className="flex flex-col gap-0.5">
							{request.hostKeyFingerprints.map((fingerprint) => (
								<li key={fingerprint} className="select-all break-all font-mono text-label">
									{fingerprint}
								</li>
							))}
						</ul>
					</div>
					<p className="text-label text-muted-foreground">{t("settings.connections.pin.warning")}</p>
				</div>
				<DialogFooter>
					<Button variant="ghost" disabled={props.busy} onClick={() => props.onAnswer("deny")}>
						{t("settings.connections.pin.deny")}
					</Button>
					<Button disabled={props.busy} onClick={() => props.onAnswer("approve")}>
						{t("settings.connections.pin.approve")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

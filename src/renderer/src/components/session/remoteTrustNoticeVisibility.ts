import type { SessionRemoteTrustState } from "../../atoms/remote-trust-atoms";

/** 只显示需要用户处理的信任状态。 */
export function shouldShowRemoteTrustNotice(kind: SessionRemoteTrustState["kind"]): kind is "undecided" | "stale" {
	return kind === "undecided" || kind === "stale";
}

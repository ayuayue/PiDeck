import type { ComponentProps, ReactNode } from "react";
import { EnvironmentDialog } from "./OverlayParts";

export type EnvironmentOverlayProps = {
	open: boolean;
	dialog?: ComponentProps<typeof EnvironmentDialog>;
	children?: ReactNode;
};

/** Root boundary for environment detection; supports both dialog spread and wrapper patterns. */
export function EnvironmentOverlay({ open, dialog, children }: EnvironmentOverlayProps) {
	if (!open) return null;
	if (children) return <>{children}</>;
	return <EnvironmentDialog {...dialog!} />;
}

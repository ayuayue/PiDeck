import { createHash } from "node:crypto";
import { getAppLogger } from "../logging/sharedLogger";
import type { RootSessionPoolOptions } from "./RemoteRootSessionPool";

const rootKey = (root: string): string => createHash("sha256").update(root).digest("hex").slice(0, 16);

/** Lifecycle-only logging. Root hashes identify a boundary without disclosing its path. */
export const logRootPoolDiagnostic: NonNullable<RootSessionPoolOptions<unknown>["onDiagnostic"]> = (event) => {
	void getAppLogger()?.info("remote-root-pool", "Root pool " + event.action, {
		stats: event.stats,
		...(event.before === undefined ? {} : { before: event.before }),
		roots: event.roots.map(({ root, ...entry }) => ({ ...entry, rootKey: rootKey(root), helpers: 1 })),
		creatingRoots: event.creatingRoots.map(({ hostId, root }) => ({ hostId, rootKey: rootKey(root) })),
	});
};

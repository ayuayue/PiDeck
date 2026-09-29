import { join } from "node:path";
import { createRemoteHostReferenceRegistry } from "./RemoteHostReferenceSources";
import { RemoteHostRepair, type HostRepairFinding } from "./RemoteHostRepair";
import { RemoteHostStore, type RemoteHostStoreState } from "./RemoteHostStore";
import { SshHostPinStore } from "./SshHostPinStore";

export type RemoteHostCatalogView = { snapshot: RemoteHostStoreState; findings: readonly HostRepairFinding[] };

/** Read the local catalog and repair evidence without enrolling, deleting or reconnecting a host. */
export async function openRemoteHostCatalogView(userDataDir: string): Promise<RemoteHostCatalogView> {
	const pinStore = new SshHostPinStore(userDataDir);
	try {
		const readPin = pinStore.readPin.bind(pinStore);
		// Omitting deletePin also prevents the store's retired-pin cleanup on a list request.
		const store = await RemoteHostStore.open(userDataDir, {
			pinStore: {
				offer: async () => {
					throw new Error("REMOTE_FEATURE_DISABLED");
				},
				answer: async () => {
					throw new Error("REMOTE_FEATURE_DISABLED");
				},
				readPin,
			},
			referenceRegistry: createRemoteHostReferenceRegistry(join(userDataDir, "session-catalog.json"), join(userDataDir, "projects.json")),
		});
		const snapshot = store.getSnapshot();
		if (snapshot.status === "ready") return { snapshot, findings: [] };
		const repair = new RemoteHostRepair({
			userDataDir,
			store,
			pins: {
				readPin,
				verifyRoute: async () => {
					throw new Error("HOST_REPAIR_ROUTE_UNVERIFIED");
				},
				deletePin: async () => {
					throw new Error("HOST_REPAIR_NOT_APPLICABLE");
				},
			},
		});
		return { snapshot, findings: await repair.diagnose() };
	} finally {
		pinStore.dispose();
	}
}

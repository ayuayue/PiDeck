import type { SessionLocator } from "../../shared/types/session";

type SessionLocatorLookup = {
	getLocator(sessionId: string): SessionLocator | undefined;
};

/** Routes session file locations without letting an SSH locator reach local filesystem readers. */
export class SessionLocatorRouter {
	resolveSessionFilePath(sessionId: string, lookup: SessionLocatorLookup): string | undefined {
		const locator = lookup.getLocator(sessionId);
		return locator ? this.resolveFilePath(locator) : undefined;
	}

	resolveFilePath(locator: SessionLocator): string | undefined {
		if (locator.kind === "ssh") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		return locator.filePath;
	}
}

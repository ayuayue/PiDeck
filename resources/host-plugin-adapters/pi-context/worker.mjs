/** The third-party pure fold is compiled locally; no pi extension or HTTP server is loaded. */
import { buildSnapshot } from "./model.mjs";

self.addEventListener("message", ({ data }) => {
	try {
		self.postMessage({ id: data.id, ok: true, snapshot: buildSnapshot(data.entries) });
	} catch {
		self.postMessage({ id: data.id, ok: false });
	}
});

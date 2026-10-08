/** Local viewer adapter: bounded historical data, never a provider-request reconstruction. */
export const HISTORY_LIMITS = { sessions: 50, overviewEntries: 200, overviewBytes: 2 * 1024 * 1024, detailEntries: 1500, detailBytes: 8 * 1024 * 1024 };
const pause = () => new Promise((resolve) => setTimeout(resolve, 75));

/** Serial requests stay below the host broker's rate/concurrency limits. */
export class PiContextData {
	constructor(api, analyze, context, wait = pause) {
		this.api = api;
		this.analyze = analyze;
		this.context = context;
		this.wait = wait;
		this.epoch = 0;
		this.queue = Promise.resolve();
		this.catalog = null;
		this.overview = null;
		this.detail = null;
		this.status = { partial: false, unavailable: 0, missingPrompt: false };
	}

	updateContext(context) {
		const changed = this.context.projectId !== context.projectId || this.context.sessionId !== context.sessionId;
		this.context = context;
		if (changed) this.invalidate();
		return changed;
	}

	invalidate() {
		this.epoch += 1;
		this.catalog = null;
		this.overview = null;
		this.detail = null;
		this.status = { partial: false, unavailable: 0, missingPrompt: false };
	}

	check(epoch) {
		if (epoch !== this.epoch) throw new Error("plugin-context-changed");
	}

	async request(operation, epoch) {
		const pending = this.queue.then(async () => {
			await this.wait();
			this.check(epoch);
			const result = await operation();
			this.check(epoch);
			return result;
		});
		this.queue = pending.catch(() => undefined);
		return pending;
	}

	async sessions(epoch) {
		if (!this.context.projectId) return [];
		if (!this.catalog) {
			this.catalog = this.request(() => this.api.sessions.list(), epoch).then((page) => {
				this.check(epoch);
				this.status.partial ||= page.sessions.length > HISTORY_LIMITS.sessions || page.nextOffset !== null;
				return page.sessions.slice(0, HISTORY_LIMITS.sessions);
			});
		}
		return this.catalog;
	}

	/** Newest-first pages are folded back into chronological order, on one file revision. */
	async history(id, epoch, maxEntries, maxBytes) {
		const pages = [];
		let cursor;
		let version;
		let count = 0;
		let bytes = 0;
		let partial = false;
		for (;;) {
			const page = await this.request(() => this.api.sessions.entries(id, cursor), epoch);
			if (version !== undefined && version !== page.version) throw new Error("history-changed");
			version = page.version;
			const cost = new TextEncoder().encode(JSON.stringify(page.entries)).length;
			if (count + page.entries.length > maxEntries || bytes + cost > maxBytes) { partial = true; break; }
			pages.push(page.entries.filter((entry) => !entry.omitted && typeof entry.timestamp === "string"));
			count += page.entries.length;
			bytes += cost;
			partial ||= page.truncated;
			if (!page.nextCursor) break;
			if (!page.entries.length || (cursor && page.nextCursor.before >= cursor.before)) throw new Error("invalid-history-page");
			cursor = page.nextCursor;
			if (count >= maxEntries || bytes >= maxBytes) { partial = true; break; }
		}
		this.check(epoch);
		const entries = pages.reverse().flat();
		const snapshot = await this.analyze(entries);
		this.check(epoch);
		this.status.partial ||= partial;
		this.status.missingPrompt ||= snapshot.promptSections.length === 0 || snapshot.toolDefs.length === 0;
		return { snapshot, entries, partial };
	}

	list() {
		if (!this.overview) this.overview = this.buildList();
		return this.overview;
	}

	async buildList() {
		const epoch = this.epoch;
		const rows = [];
		for (const session of await this.sessions(epoch)) {
			if (!session.readable) { this.status.unavailable += 1; continue; }
			try {
				const { snapshot, entries, partial } = await this.history(session.id, epoch, HISTORY_LIMITS.overviewEntries, HISTORY_LIMITS.overviewBytes);
				let prompt = 0;
				let cached = 0;
				let activeMs = 0;
				for (const request of snapshot.requests) { prompt += request.prompt; cached += request.cacheRead; activeMs += request.durationMs; }
				rows.push({
					// The upstream field is an opaque catalog ID here, never an OS file path.
					file: session.id, id: session.id.slice(0, 8), cwd: session.projectId,
					title: session.title, time: new Date(session.createdAt).toISOString(), mtime: new Date(session.updatedAt).toISOString(),
					turns: snapshot.counts.turns, steps: snapshot.counts.steps, toolCalls: snapshot.counts.toolCalls,
					model: snapshot.model ?? session.model ?? "", composition: snapshot.composition, totalTokens: snapshot.totalTokens,
					lastMsg: (snapshot.userMsgs.at(-1)?.text ?? "").replace(/\s+/g, " ").slice(0, 80),
					cacheHit: prompt > 0 ? cached / prompt : -1, activeMs, partial, sampledEntries: entries.length,
				});
			} catch (error) {
				this.check(epoch);
				// A racing revision is not an unreadable session: never publish a mixed-revision overview.
				if (["stale-cursor", "history-changed", "plugin-revoked", "plugin-context-changed"].includes(error.message)) throw error;
				this.status.unavailable += 1;
			}
		}
		this.check(epoch);
		return rows;
	}

	async snapshot(id) {
		const epoch = this.epoch;
		// A focused session may be older than the overview cap. The broker, not a sampled list, owns authorization.
		if (typeof id !== "string" || !id) throw new Error("history-unavailable");
		if (!this.detail || this.detail.id !== id) {
			this.detail = { id, pending: this.history(id, epoch, HISTORY_LIMITS.detailEntries, HISTORY_LIMITS.detailBytes).then((result) => result.snapshot) };
		}
		const result = await this.detail.pending;
		this.check(epoch);
		return result;
	}
}

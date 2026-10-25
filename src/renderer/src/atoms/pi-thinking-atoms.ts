import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";

/** Runtime-scoped Pi capability result. A replacement process must never reuse it. */
export type PiRuntimeThinkingLevelsEntry = {
	agentId: string;
	runtimeGeneration: number;
	provider: string;
	modelId: string;
	status: "loading" | "resolved" | "fallback";
	/** Empty remains authoritative; undefined means old Pi or an unavailable query. */
	levels?: string[];
};

export type PiRuntimeThinkingLevelsTarget = Pick<PiRuntimeThinkingLevelsEntry, "agentId" | "runtimeGeneration" | "provider" | "modelId">;

export function matchesPiRuntimeThinkingLevelsTarget(entry: PiRuntimeThinkingLevelsEntry | undefined, target: PiRuntimeThinkingLevelsTarget): boolean {
	return entry?.agentId === target.agentId && entry.runtimeGeneration === target.runtimeGeneration && entry.provider === target.provider && entry.modelId === target.modelId;
}

function cloneEntry(entry: PiRuntimeThinkingLevelsEntry): PiRuntimeThinkingLevelsEntry {
	return {
		...entry,
		...(entry.levels ? { levels: [...entry.levels] } : {}),
	};
}

const piRuntimeThinkingLevelsBySessionIdAtom = atom<Record<string, PiRuntimeThinkingLevelsEntry | undefined>>({});

/** Per-session selector prevents another split pane's model switch from rerendering this picker. */
export const piRuntimeThinkingLevelsBySessionIdAtomFamily = atomFamily((sessionId: string) => selectAtom(piRuntimeThinkingLevelsBySessionIdAtom, (entries) => entries[sessionId], Object.is));

/** Begin at most one lookup for a runtime/model identity. */
export const beginPiRuntimeThinkingLevelsAtom = atom(null, (get, set, input: { sessionId: string; target: PiRuntimeThinkingLevelsTarget }) => {
	const current = get(piRuntimeThinkingLevelsBySessionIdAtom);
	if (matchesPiRuntimeThinkingLevelsTarget(current[input.sessionId], input.target)) return;
	set(piRuntimeThinkingLevelsBySessionIdAtom, {
		...current,
		[input.sessionId]: { ...input.target, status: "loading" },
	});
});

/**
 * Publish only if the request still belongs to the same runtime/model. This keeps
 * a late RPC response from an old agent or model switch from replacing newer data.
 */
export const resolvePiRuntimeThinkingLevelsAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			target: PiRuntimeThinkingLevelsTarget;
			levels?: string[];
		},
	) => {
		const current = get(piRuntimeThinkingLevelsBySessionIdAtom);
		if (!matchesPiRuntimeThinkingLevelsTarget(current[input.sessionId], input.target)) return;
		const next: PiRuntimeThinkingLevelsEntry = {
			...input.target,
			status: input.levels === undefined ? "fallback" : "resolved",
			...(input.levels ? { levels: [...input.levels] } : {}),
		};
		set(piRuntimeThinkingLevelsBySessionIdAtom, {
			...current,
			[input.sessionId]: cloneEntry(next),
		});
	},
);

/** Release per-session atom-family state when the session is permanently discarded. */
export const clearPiRuntimeThinkingLevelsAtom = atom(null, (get, set, sessionId: string) => {
	const current = get(piRuntimeThinkingLevelsBySessionIdAtom);
	if (!(sessionId in current)) return;
	const next = { ...current };
	delete next[sessionId];
	set(piRuntimeThinkingLevelsBySessionIdAtom, next);
	piRuntimeThinkingLevelsBySessionIdAtomFamily.remove(sessionId);
});

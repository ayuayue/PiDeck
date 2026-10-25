import { useAtomValue } from "jotai";
import { runtimeCapabilitiesByProjectIdAtomFamily, runtimeCapabilityByAgentIdAtomFamily } from "../atoms";

export function useRuntimeCapabilities(agentId?: string) {
	return useAtomValue(runtimeCapabilityByAgentIdAtomFamily(agentId ?? ""));
}

export function useProjectRuntimeCapabilities(projectId?: string) {
	return useAtomValue(runtimeCapabilitiesByProjectIdAtomFamily(projectId ?? ""));
}

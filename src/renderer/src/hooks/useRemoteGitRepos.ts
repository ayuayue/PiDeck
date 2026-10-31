import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteGitRepo } from "../../../shared/types/git";
import type { RemoteProject } from "../../../shared/types/project";
import { useProjectServices } from "./useProjectServices";
import { repositoryListingToSelector } from "../utils/remoteGitRepos";

type RemoteGitReposState = { repos?: RemoteGitRepo[]; truncated: boolean };

/**
 * Repository discovery for the panel's scope selector: one read per project identity plus an explicit reload after
 * the user refreshes or successfully initializes the root repository. Discovery is read-only and never decides the
 * selected scope by itself - the panel owns that state, so a reload can never move the view under the user.
 *
 * G4a: discovery is a service read (`ProjectServices.git.repos()`), never a preload channel of its own; a closed
 * `git.repos` capability means zero calls (the selector simply hides). The services runtime owns the fact/connection
 * subscriptions, so a new generation re-reads the list instead of the hook subscribing by itself.
 */
export function useRemoteGitRepos(project: RemoteProject) {
	const services = useProjectServices(project);
	const enabled = services.capabilities.git.repos;
	const [state, setState] = useState<RemoteGitReposState>({ truncated: false });
	const active = useRef(0);
	const reload = useCallback(async (): Promise<void> => {
		const generation = ++active.current;
		if (!enabled) {
			setState({ truncated: false });
			return;
		}
		try {
			const listing = await services.git.repos();
			// A stale answer from a previous project identity / generation must not populate the new selector.
			if (generation !== active.current) return;
			setState(repositoryListingToSelector(listing));
		} catch {
			// Discovery is an enhancement: a failed list hides the selector and leaves the root scope working. The
			// repository reads themselves report the stable error when the selected scope cannot be read.
			if (generation === active.current) setState({ truncated: false });
		}
	}, [services, enabled]);
	useEffect(() => {
		setState({ truncated: false });
		void reload();
		return () => {
			active.current += 1;
		};
	}, [services.generation, reload]);
	return { repos: state.repos, truncated: state.truncated, reload };
}

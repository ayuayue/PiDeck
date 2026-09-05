import { atom } from "jotai";

/** A renderer-owned save operation that must complete before update installation exits the process. */
export type UpdateInstallPreflightTask = () => Promise<boolean>;

/**
 * Active editors register a narrow flush callback here. This is callback coordination rather
 * than document state: each task owns its own dirty/error UI and unregisters on unmount.
 */
export const updateInstallPreflightTasksAtom = atom<Map<string, UpdateInstallPreflightTask>>(
  new Map(),
);

/** Run every registered flush even when one fails, so one pending editor cannot hide another. */
export async function flushUpdateInstallPreflight(
  tasks: Iterable<UpdateInstallPreflightTask>,
): Promise<boolean> {
  const results = await Promise.all(
    [...tasks].map(async (task) => {
      try {
        return await task();
      } catch {
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

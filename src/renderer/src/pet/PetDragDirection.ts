export type PetDragMode = "idle" | "running-left" | "running-right";

export type PetDragDirection = {
	anchorX: number;
	mode: PetDragMode;
};

const DIRECTION_THRESHOLD_PX = 6;

/** 累计水平位移达到阈值后切换方向，避免手部微抖让精灵反复转向。 */
export function updatePetDragDirection(state: PetDragDirection, currentX: number): PetDragDirection {
	const deltaX = currentX - state.anchorX;
	if (Math.abs(deltaX) < DIRECTION_THRESHOLD_PX) return state;
	return {
		anchorX: currentX,
		mode: deltaX > 0 ? "running-right" : "running-left",
	};
}

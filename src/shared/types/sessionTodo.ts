/** pi-deck-todo 单条待办项（会话文件 pi-deck-todo custom 快照重建用）。 */
export type SessionTodoItem = {
	/** 扩展分配的稳定数字 id（#15 等），仅展示用。 */
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed";
};

/** 会话级 todo 快照（跨进程契约：main 从会话文件重建、renderer 展示）。 */
export type SessionTodoSnapshot = {
	planId: number;
	todos: SessionTodoItem[];
};

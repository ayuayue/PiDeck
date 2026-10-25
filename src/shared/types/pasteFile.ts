/**
 * 粘贴大文本 → 落盘文件 的契约类型。
 * 渲染层只持有元数据（chip 展示用），文件内容只存在于主进程受管目录：
 * 新写入一律 `userData/paste-files/`（与日志同属应用数据，发送时折叠为原样文本内联）；
 * 历史项目内 `<project>/.pideck-paste/` 仍可被删除/设置页清理（白名单）。
 */
export type PasteFileWriteInput = {
	/** 会话所属项目根路径；空串 = 匿名会话。非空时仍须是已登记项目（路径校验），但新写入不再落项目目录。 */
	projectPath: string;
	content: string;
};

export type PasteFileWriteResult = {
	/** 落盘绝对路径 */
	path: string;
	fileName: string;
	bytes: number;
	/** 是否位于 pi 工作区（项目内）：true 时发送走 @"path" 引用，false 时折叠原样文本。新写入一律 false；遗留项目内 chip 仍可为 true。 */
	inProject: boolean;
};

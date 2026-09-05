import { t } from "../i18n";
import { isComposingKeyboardEvent } from "../composerBehavior";
import type { RenameModalProps } from "../hooks/useRename";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui-shadcn/dialog";
import { Button } from "./ui-shadcn/button";
import { Input } from "./ui-shadcn/input";

/**
 * 重命名对话框（#115 U5）：统一为 shadcn Dialog + Input + Button。
 * 调用方按条件渲染（{x && <RenameModals/>}），组件挂载即打开；
 * ESC/遮罩关闭走 onClose（保存中禁用关闭，防中途丢状态）。
 * agent/session/project 三种目标共用同一弹窗，仅标题/占位/提示文案不同。
 */

type FileRenameProps = {
  path: string;
  name: string;
  inputValue: string;
  onInputChange: (value: string) => void;
  onClose: () => void;
  onConfirm: (path: string, newName: string) => void;
};

type Props = {
  fileRename?: FileRenameProps;
  rename?: RenameModalProps;
};

export function RenameModals({ fileRename, rename }: Props) {
  // 文件重命名的确认语义：非空且与原名不同才提交，否则视为取消
  const submitFileRename = () => {
    if (!fileRename) return;
    const next = fileRename.inputValue.trim();
    if (next && next !== fileRename.name) fileRename.onConfirm(fileRename.path, next);
    else fileRename.onClose();
  };

  const isProjectRename = rename?.kind === "project";
  const title = isProjectRename ? t("app.renameProjectTitle") : t("app.renameSessionTitle");
  const placeholder = isProjectRename
    ? t("app.renameProjectPlaceholder")
    : t("app.renameSessionPlaceholder");

  return <>
    {rename && (
      <Dialog open onOpenChange={(open) => { if (!open && !rename.saving) rename.onClose(); }}>
        <DialogContent
          className="sm:max-w-sm"
          onOpenAutoFocus={(event) => {
            // 默认 autofocus 第一个可聚焦元素是关闭按钮；改为聚焦输入框
            event.preventDefault();
            const root = event.currentTarget as HTMLElement | null;
            root?.querySelector("input")?.focus();
          }}
          onKeyDown={(e) => {
            // Enter 提交（与旧 form 语义一致）；IME 合成中（中文选词）与 saving 中不响应
            if (e.key === "Enter" && !isComposingKeyboardEvent(e) && !rename.saving) {
              e.preventDefault();
              rename.onSubmit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{placeholder}</DialogDescription>
          </DialogHeader>
          <Input
            value={rename.value}
            onChange={(e) => rename.onValueChange(e.target.value)}
            placeholder={placeholder}
            disabled={rename.saving}
          />
          {/* 项目重命名只改显示 label，不碰磁盘目录：给出一条可见说明，避免用户误以为
              重命名会移动/改目录名（改目录会连带破坏会话路径、git、运行中 Agent）。 */}
          {isProjectRename && (
            <p className="text-caption text-muted-foreground">{t("app.renameProjectHint")}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={rename.saving} onClick={rename.onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={rename.saving} onClick={rename.onSubmit}>
              {rename.saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    {fileRename && (
      <Dialog open onOpenChange={(open) => { if (!open) fileRename.onClose(); }}>
        <DialogContent
          className="sm:max-w-sm"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const root = event.currentTarget as HTMLElement | null;
            root?.querySelector("input")?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isComposingKeyboardEvent(e)) {
              e.preventDefault();
              submitFileRename();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("drawer.renameTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{fileRename.name}</DialogDescription>
          </DialogHeader>
          <Input
            value={fileRename.inputValue}
            onChange={(e) => fileRename.onInputChange(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={fileRename.onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => submitFileRename()}>{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
  </>;
}

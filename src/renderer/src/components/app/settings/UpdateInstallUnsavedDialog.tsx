import { t, type TranslationKey } from "../../../i18n";
import { buttonVariants } from "../../ui-shadcn/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui-shadcn/alert-dialog";

type UnsavedItem = {
  tabKey: TranslationKey;
  itemKey: TranslationKey;
};

type UpdateInstallUnsavedDialogProps = {
  open: boolean;
  items: UnsavedItem[];
  count: number;
  onCancel: () => void;
  onDiscardAndInstall: () => void;
  onSaveAndInstall: () => Promise<void>;
};

/**
 * Guards update-triggered process exit when the settings workspace still owns
 * unsaved drafts. Normal dialog-close confirmation has different semantics,
 * so this remains a dedicated leaf with explicit install actions.
 */
export function UpdateInstallUnsavedDialog(props: UpdateInstallUnsavedDialogProps) {
  if (!props.open) return null;

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) props.onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("settings.updateInstallUnsavedTitle")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid max-h-56 gap-1.5 overflow-auto text-left">
              <p>{t("settings.updateInstallUnsavedMessage")}</p>
              <p>{t("settings.unsavedListIntro", { count: props.count })}</p>
              <ul className="grid gap-0.5 pl-4 list-disc">
                {props.items.map((item) => (
                  <li key={`${item.tabKey}\u0000${item.itemKey}`}>
                    {t(item.tabKey)} · {t(item.itemKey)}
                  </li>
                ))}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={props.onDiscardAndInstall}
          >
            {t("settings.discardAndInstall")}
          </AlertDialogAction>
          <AlertDialogAction onClick={() => void props.onSaveAndInstall()}>
            {t("settings.saveAndInstall")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

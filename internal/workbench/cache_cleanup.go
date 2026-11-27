//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"os"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) clearCache(kind string) error {
	if a.st == nil {
		return os.ErrNotExist
	}
	switch kind {
	case "all":
		var errs []error
		for _, category := range []string{"metadata", "transcripts", "announcements"} {
			errs = append(errs, a.clearCache(category))
		}
		return errors.Join(errs...)
	case "transcripts":
		sessionHistory.Lock()
		sessionHistory.items, sessionHistory.order, sessionHistory.bytes = map[string]historyEntry{}, nil, 0
		sessionHistory.Unlock()
		// The phone's search keeps the same transcripts, lowercased.
		if a.remote != nil {
			a.remote.search.clear()
		}
		return nil
	case "metadata":
		a.st.metaWriteMu.Lock()
		defer a.st.metaWriteMu.Unlock()
		a.st.mu.Lock()
		a.st.metas, a.st.metaDirty = map[string]metaCacheEntry{}, false
		a.st.mu.Unlock()
	case "announcements", "logs":
	default:
		return errors.New("unknown cache category")
	}
	names := map[string]string{"metadata": "session-meta-cache.json", "announcements": "announcements-cache.json", "logs": "logs/pideck.log.1"}
	root, err := os.OpenRoot(a.st.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	err = root.Remove(names[kind])
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (a *app) cacheCleanupSettings() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		busy := core.NewSignal(cx, false)
		return setGroup("空间清理",
			setRow("临时缓存", "清理可重新生成的缓存，不删除会话、设置或导出文件。",
				ui.Button{TextFunc: func() string {
					if busy.Get() {
						return apptext.T("正在清理…")
					}
					return apptext.T("清理缓存")
				}, Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "cache-clear-all", Disabled: busy.Get, OnPress: func() {
					busy.Set(true)
					go func() {
						err := a.clearCache("all")
						a.cx.Post(func() {
							busy.Set(false)
							if err != nil {
								a.toast(ui.ToastError, "清理缓存失败", err.Error())
								return
							}
							a.toast(ui.ToastSuccess, "缓存已清理", "")
						})
					}()
				}}),
			setDivider(),
			setRow("诊断日志", "查看、导出或清理排查问题时生成的日志。",
				ui.Button{Text: apptext.T("管理日志"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "data-manage-logs",
					OnPress: func() { a.openSettingsSection("diagnostics") }}),
		)
	})
}

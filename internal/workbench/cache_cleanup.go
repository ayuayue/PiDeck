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
	case "transcripts":
		sessionHistory.Lock()
		sessionHistory.items, sessionHistory.order, sessionHistory.bytes = map[string]historyEntry{}, nil, 0
		sessionHistory.Unlock()
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
		var rows []core.Node
		for _, c := range []struct{ kind, label, help string }{
			{"metadata", "会话索引缓存", "重新扫描时自动重建，不删除会话。"},
			{"transcripts", "对话内存缓存", "释放历史解析缓存，当前对话保留。"},
			{"announcements", "公告缓存", "下次检查公告时重新下载。"},
			{"logs", "旧诊断日志", "只清理已轮转的旧日志，保留当前日志和崩溃记录。"},
		} {
			rows = append(rows, setRow(c.label, c.help, ui.Button{Text: apptext.T("清理"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "cache-clear-" + c.kind, Disabled: busy.Get, OnPress: func() {
					busy.Set(true)
					go func() {
						err := a.clearCache(c.kind)
						a.cx.Post(func() {
							busy.Set(false)
							if err != nil {
								a.toast(ui.ToastError, "清理缓存失败", err.Error())
								return
							}
							a.toast(ui.ToastSuccess, "缓存已清理", "")
						})
					}()
				}}))
		}
		return setGroup("清理缓存", rows...)
	})
}

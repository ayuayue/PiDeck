//go:build !js && !android && !ios

package workbench

import (
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"go.yaml.in/yaml/v3"
)

const notificationHistoryLimit = 100

var notificationHistoryWrites sync.WaitGroup

type notificationRecord struct {
	Session string    `yaml:"session"`
	Title   string    `yaml:"title"`
	At      time.Time `yaml:"at"`
}

type notificationHistory struct {
	open    *core.Signal[bool]
	entries *core.Signal[[]notificationRecord]
	file    string
	seq     uint64 // UI thread
	write   sync.Mutex
	written uint64 // protected by write
}

func newNotificationHistory(cx *core.Scope) *notificationHistory {
	return &notificationHistory{open: core.NewSignal(cx, false), entries: core.NewSignalFunc(cx, []notificationRecord(nil), nil)}
}

func (h *notificationHistory) load(dir string) {
	h.file = filepath.Join(dir, "notifications.yaml")
	f, err := os.Open(h.file)
	if err != nil {
		return
	}
	defer f.Close()
	var entries []notificationRecord
	if yaml.NewDecoder(io.LimitReader(f, 128<<10)).Decode(&entries) == nil && len(entries) <= notificationHistoryLimit {
		h.entries.Set(entries)
	}
}

func (h *notificationHistory) add(s *session, at time.Time) {
	if h == nil || h.file == "" {
		return
	}
	record := notificationRecord{Session: s.ID, Title: viewkit.FirstLine(s.title.GetUntracked(), 120), At: at}
	entries := h.entries.GetUntracked()
	entries = append([]notificationRecord{record}, entries[:min(len(entries), notificationHistoryLimit-1)]...)
	h.save(entries, nil)
}

func (h *notificationHistory) save(entries []notificationRecord, onError func(error)) {
	h.entries.Set(entries)
	if h.file == "" {
		return
	}
	h.seq++
	seq := h.seq
	entries = slices.Clone(entries)
	notificationHistoryWrites.Add(1)
	go func() {
		defer notificationHistoryWrites.Done()
		h.write.Lock()
		if seq < h.written {
			h.write.Unlock()
			return
		}
		h.written = seq
		raw, err := yaml.Marshal(entries)
		if err == nil {
			err = writeFileAtomic(h.file, raw, 0o600)
		}
		h.write.Unlock()
		if err != nil && onError != nil {
			onError(err)
		}
	}()
}

func (a *app) notificationHistoryPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		entries := a.notifications.entries.Get()
		items := make([]core.Node, 0, len(entries))
		for _, entry := range entries {
			id := entry.Session
			items = append(items, setRow(entry.Title, entry.At.Local().Format("2006-01-02 15:04"),
				ui.Button{Text: apptext.T("打开会话"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					TestID:   "notification-open-" + id,
					Disabled: func() bool { return a.byID[id] == nil }, OnPress: func() { a.openSessionByID(id) }}))
		}
		if len(items) == 0 {
			items = append(items, ui.Text(apptext.T("还没有会话通知。"), 12, ui.Regular, colors.Muted))
		}
		return core.View{Style: ui.FillRest.Merge(core.Style{Padding: core.All(16), Gap: 12}), Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Icon(lucide.Bell, 16, colors.Muted),
				core.Text{Content: apptext.T("通知历史"), Style: core.Style{FlexGrow: 1, FontSize: 16, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
				ui.Button{Text: apptext.T("清空"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "notification-history-clear",
					Disabled: func() bool { return len(entries) == 0 }, OnPress: func() {
						a.notifications.save(nil, func(err error) {
							a.cx.Post(func() { a.toast(ui.ToastError, "清空通知历史失败", err.Error()) })
						})
					}},
			}},
			a.scrollStashFor("notificationHistoryPane:1").Bind(cx, core.Scroll{Style: ui.FillRest, Children: []core.Node{core.View{Style: core.Style{Gap: 2, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: items}}}),
		}}
	})
}

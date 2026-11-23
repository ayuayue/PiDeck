//go:build !js && !android && !ios

package workbench

import (
	"net/url"
	"os"
	"runtime"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func sessionLinkScheme() string {
	if strings.HasSuffix(core.App().ID, ".dev") {
		return "pideck-v2-dev"
	}
	return "pideck-v2"
}

func sessionLinkID(raw, scheme string) string {
	if len(raw) > 512 {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != scheme || u.Host != "session" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return ""
	}
	id := strings.TrimPrefix(u.Path, "/")
	if len(id) < 1 || len(id) > 96 || strings.ContainsFunc(id, func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_'
	}) {
		return ""
	}
	return id
}

func (a *app) setupSessionLinks() {
	open := func(links []string) {
		for _, raw := range links {
			id := sessionLinkID(raw, sessionLinkScheme())
			if id == "" {
				continue
			}
			if s := a.byID[id]; s != nil && !s.deleting {
				a.openSessionByID(id)
			} else {
				a.showMainWindow()
				a.toast(ui.ToastInfo, "没有找到链接指向的会话", "请在保存了该会话的工作台中打开。")
			}
			return
		}
	}
	a.cx.OnOpenLinks(open)
	if runtime.GOOS == "windows" {
		// NSGo forwards the second Windows process's arguments to the first
		// instance through OnOpenFiles. A cold launch gets them from argv.
		a.cx.OnOpenFiles(open)
	}
	if runtime.GOOS != "darwin" {
		a.cx.Post(func() { open(os.Args[1:]) })
	}
}

func (a *app) copySessionLink() {
	if s := a.active(); s != nil {
		raw := sessionLinkScheme() + "://session/" + url.PathEscape(s.ID)
		if sessionLinkID(raw, sessionLinkScheme()) != "" {
			a.copyText(raw, apptext.T("会话链接"))
		}
	}
}

func (a *app) sessionLinkSetting() core.Node {
	if runtime.GOOS != "windows" {
		return nil
	}
	return setRow("会话链接", "让 Windows 用当前安装打开会话链接。", ui.Button{
		Text: apptext.T("注册链接"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "register-session-links", OnPress: func() {
			go func() {
				err := registerSessionLinks(sessionLinkScheme())
				a.cx.Post(func() {
					if err != nil {
						a.toast(ui.ToastError, "注册链接失败", err.Error())
						return
					}
					a.toast(ui.ToastSuccess, "会话链接已注册", "")
				})
			}()
		},
	})
}

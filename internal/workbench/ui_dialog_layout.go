//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
)

// Match ui.Dialog's edge reservation, including the app's custom title bar.
func dialogInset(cx *core.Scope) core.Points {
	return max(20, desktop.TitleBar(cx).Top)
}

func (a *app) dialogWidth(width ...core.Points) core.Length {
	preferred := viewkit.DialogStandardWidth
	if len(width) != 0 {
		preferred = width[0]
	}
	return core.Pt(min(preferred, max(0, a.cx.Env().Window().Width-2*dialogInset(a.cx))))
}

func dialogHeight(cx *core.Scope, preferred core.Points) core.Length {
	return core.Pt(min(preferred, max(0, cx.Env().Window().Height-2*dialogInset(cx))))
}

func dialogBodyHeight(cx *core.Scope, preferred core.Points) core.Length {
	// Leave room for padding, title, footer and a wrapped helper or error line.
	const chrome core.Points = 144
	return core.Pt(min(preferred, max(0, cx.Env().Window().Height-2*dialogInset(cx)-chrome)))
}

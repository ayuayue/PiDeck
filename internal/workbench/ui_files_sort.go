//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) fileSortControl() core.Node {
	options := []ui.Option[fileSort]{
		{Value: fileSortName, Label: apptext.T("名称") + " A → Z"},
		{Value: fileSortNameDesc, Label: apptext.T("名称") + " Z → A"},
		{Value: fileSortModified, Label: apptext.T("修改时间") + " ↓"},
		{Value: fileSortOldest, Label: apptext.T("修改时间") + " ↑"},
		{Value: fileSortType, Label: apptext.T("格式") + " A → Z"},
		{Value: fileSortTypeDesc, Label: apptext.T("格式") + " Z → A"},
		{Value: fileSortSize, Label: apptext.T("大小") + " ↓"},
		{Value: fileSortSmallest, Label: apptext.T("大小") + " ↑"},
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
		ui.Text(apptext.T("排序"), viewkit.PanelCaptionSize, ui.Regular, ui.ColorsOf(a.cx).Muted),
		ui.Select[fileSort]{Label: apptext.T("排序"), TestID: "files-sort", Options: options,
			Value: a.files.order.Get, OnChange: a.files.setOrder,
			Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Width: core.Pt(0), Height: core.Pt(viewkit.PanelControlSize), FontSize: viewkit.PanelTextSize}},
	}}
}

//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"path/filepath"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) backgroundGroup(colors ui.Colors) core.Node {
	path := a.cfg.wallpaper()
	name := apptext.T("未设置壁纸")
	var preview core.Node = ui.Icon(lucide.Image, 20, colors.Muted)
	if path != "" {
		name = filepath.Base(path)
		if wallpaperVideo(path) {
			preview = ui.Icon(lucide.Film, 20, colors.Muted)
		} else {
			preview = core.Image{Source: core.ImageSource{URI: path}, ResizeMode: core.Cover,
				Style: core.Style{Width: core.Pt(80), Height: core.Pt(46), CornerRadius: 6}}
		}
	}
	current := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyEnd,
		Gap: 8, Width: core.Pt(230), MaxWidth: core.Pct(100)}, Children: []core.Node{
		preview,
		core.Show{When: func() bool { return a.bgImage.Get() != "" }, Then: func(*core.Scope) core.Node {
			return ui.Button{Text: apptext.T("清除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "bg-image-clear", OnPress: func() { a.setBackgroundImage("") }}
		}},
	}}
	choose := core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, JustifyContent: core.JustifyEnd,
		Gap: 8, Width: core.Pt(230), MaxWidth: core.Pct(100)}, Children: []core.Node{
		ui.Button{Text: apptext.T("选择图片"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "bg-image-choose",
			OnPress: func() {
				a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp", ".gif"}, Limit: 1}, func(files []core.File, err error) {
					if err != nil {
						a.toast(ui.ToastError, apptext.T("选择图片失败"), err.Error())
						return
					}
					if len(files) == 1 {
						a.setBackgroundImage(files[0].Path)
					}
				})
			}},
		ui.Button{Text: apptext.T("选择视频壁纸"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			TestID: "video-wallpaper-choose", OnPress: a.pickVideoWallpaper},
	}}
	return setGroup("背景壁纸",
		setRow("当前壁纸", name, current),
		setDivider(),
		setRow("选择壁纸", "图片与视频二选一；仅保存本机路径，原文件需保留在原位置。", choose),
		setDivider(),
		setRow("壁纸可见度", "0% 隐藏壁纸，100% 最明显；选择壁纸后可调整。", settingsSlider(ui.Slider{
			Min: 0, Max: 100, Step: 1, Value: func() float64 { return a.bgOpacity.Get() * 100 },
			Disabled: func() bool { return a.bgImage.Get() == "" }, Label: apptext.T("壁纸可见度"), TestID: "bg-opacity",
			ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) }, OnChange: func(v float64) { a.setBackgroundOpacity(v / 100) }},
			func() string { return fmt.Sprintf("%.0f%%", a.bgOpacity.Get()*100) }, "0%", "100%")),
		setDivider(),
		setRow("视频壁纸", "支持本机视频，或 Wallpaper Engine 视频项目的 project.json；不支持场景或网页项目。", nil),
	)
}

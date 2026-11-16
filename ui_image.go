//go:build !js

package main

// The image generator's dialog: pick a provider and model, write a
// prompt, then attach the result to the composer or save it.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// openImageDialog shows the generator with the last choices.
func (a *app) openImageDialog() {
	providers := readProviderConfigs()
	id := a.cfg.ImageProvider
	if id == "" && len(providers) > 0 {
		id = providers[0].ID
	}
	a.imageProvider.Set(id)
	a.imageModel.Set(a.cfg.ImageModel)
	a.imageSize.Set(firstNonEmpty(a.cfg.ImageSize, "1024x1024"))
	a.imagePrompt.Set("")
	a.imageErr.Set("")
	a.imageResults.Set(nil)
	a.imageSelected.Set(0)
	a.imageType.Set("")
	a.imageBusy.Set(false)
	count := a.cfg.ImageCount
	if count < 1 {
		count = 1
	}
	a.imageCount.Set(count)
	a.imageRef.Set("")
	a.imageOpen.Set(true)
}

// imageProviderConfig finds the chosen provider.
func (a *app) imageProviderConfig() *providerConfig {
	id := a.imageProvider.GetUntracked()
	for _, cfg := range readProviderConfigs() {
		if cfg.ID == id {
			cp := cfg
			return &cp
		}
	}
	return nil
}

// generateImageNow asks the provider to draw the prompt.
func (a *app) generateImageNow() {
	if a.imageBusy.GetUntracked() {
		return
	}
	cfg := a.imageProviderConfig()
	if cfg == nil {
		a.imageErr.Set("先选一个供应商；在设置 → 模型与认证里配置。")
		return
	}
	prompt := strings.TrimSpace(a.imagePrompt.GetUntracked())
	model := strings.TrimSpace(a.imageModel.GetUntracked())
	size := a.imageSize.GetUntracked()
	count := a.imageCount.GetUntracked()
	if prompt == "" || model == "" {
		a.imageErr.Set("画面描述和模型名都要填。")
		return
	}
	ref := strings.TrimSpace(a.imageRef.GetUntracked())
	var refRaw []byte
	if ref != "" {
		raw, err := os.ReadFile(ref)
		if err != nil {
			a.imageErr.Set("读不了参考图：" + err.Error())
			return
		}
		if len(raw) > 20<<20 {
			a.imageErr.Set("参考图太大，换一张 20 MB 以内的。")
			return
		}
		refRaw = raw
	}
	a.imageBusy.Set(true)
	a.imageErr.Set("")
	go func() {
		var images []generatedImage
		var err error
		if len(refRaw) > 0 {
			images, err = editImage(*cfg, model, prompt, size, refRaw, imageMimeOf(refRaw))
		} else {
			images, err = generateImage(*cfg, model, prompt, size, count)
		}
		a.cx.Post(func() {
			a.imageBusy.Set(false)
			if err != nil {
				a.imageErr.Set(err.Error())
				return
			}
			if len(images) > 0 {
				a.imageType.Set(images[0].Mime)
			}
			n := 0
			a.imageResults.Update(func(list [][]byte) [][]byte {
				n = len(list)
				for _, img := range images {
					list = append(list, img.Data)
				}
				return list
			})
			a.imageSelected.Set(n + len(images) - 1)
			a.cfg.ImageProvider, a.cfg.ImageModel, a.cfg.ImageSize = cfg.ID, model, size
			a.cfg.ImageCount = count
			if a.st != nil {
				a.st.edit(func(c *config) {
					c.ImageProvider, c.ImageModel, c.ImageSize = cfg.ID, model, size
					c.ImageCount = count
				})
			}
			a.emit(eventImageGenerated, appEvent{Data: map[string]string{
				"provider": cfg.ID, "model": model, "size": size, "count": fmt.Sprint(len(images)),
			}})
		})
	}()
}

// selectedImage is the result the user picked.
func (a *app) selectedImage() []byte {
	results := a.imageResults.GetUntracked()
	idx := a.imageSelected.GetUntracked()
	if idx < 0 || idx >= len(results) {
		return nil
	}
	return results[idx]
}

// insertGeneratedImage puts the result in the active session's composer.
func (a *app) insertGeneratedImage() {
	s := a.active()
	raw := a.selectedImage()
	if len(raw) == 0 {
		return
	}
	if s == nil {
		a.toast(ui.ToastInfo, "先开一个会话", "图片会插到输入框里。")
		return
	}
	a.addImage(s, promptImage{Data: raw, MimeType: a.imageType.GetUntracked(), Name: "generated.png"})
	a.imageOpen.Set(false)
	a.toast(ui.ToastSuccess, "已插入输入框", "可以随下一条消息发给 pi。")
}

// saveGeneratedImage writes the result into the active project.
func (a *app) saveGeneratedImage() {
	s := a.active()
	raw := a.selectedImage()
	if len(raw) == 0 {
		return
	}
	if s == nil || s.WS == "" {
		a.toast(ui.ToastInfo, "先打开一个项目", "图片会保存到项目目录。")
		return
	}
	path := filepath.Join(s.WS, "generated-"+time.Now().Format("20060102-150405")+imageExt(a.imageType.GetUntracked()))
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		a.toast(ui.ToastError, "保存图片失败", err.Error())
		return
	}
	a.imageOpen.Set(false)
	a.toastAction(ui.ToastSuccess, "已保存图片", path, "打开", func() { a.cx.OpenURL(fileURL(path), nil) })
}

// imageCountChips picks how many images one request draws.
func (a *app) imageCountChips(colors ui.Colors) core.Node {
	var chips []core.Node
	for _, n := range []int{1, 2, 4} {
		n := n
		chips = append(chips, core.View{
			OnPress: func(core.PressEvent) { a.imageCount.Set(n) },
			Role:    core.RoleRadio, Label: T("%d 张", n), TestID: fmt.Sprintf("image-count-%d", n),
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), Padding: core.Symmetric(0, 9),
					CornerRadius: 13, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
				if a.imageCount.Get() == n {
					st.Background = colors.Pressed()
					st.BorderColor = colors.Text()
				}
				return st
			},
			Children: []core.Node{ui.Text(T("%d 张", n), 11.5, ui.Regular, colors.Text)},
		})
	}
	return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Symmetric(4, 2)}, Children: chips}
}

// imageDialog generates an image and offers to attach or save it.
func (a *app) imageDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		providers := readProviderConfigs()
		var providerChoices []choice[string]
		for _, cfg := range providers {
			providerChoices = append(providerChoices, choice[string]{Value: cfg.ID, Label: cfg.ID})
		}
		var sizeChoices []choice[string]
		for _, s := range []string{"1024x1024", "1024x1536", "1536x1024"} {
			sizeChoices = append(sizeChoices, choice[string]{Value: s, Label: s})
		}
		busy := a.imageBusy.Get()
		results := a.imageResults.Get()
		sel := a.imageSelected.Get()
		if sel >= len(results) {
			sel = len(results) - 1
		}
		var body []core.Node
		if len(providerChoices) > 0 {
			body = append(body, core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text("供应商", 10.5, ui.Medium, colors.Muted),
				choiceChips(providerChoices, func() string { return a.imageProvider.Get() }, func(v string) { a.imageProvider.Set(v) }),
			}})
		} else {
			body = append(body, core.Text{Content: "还没有供应商。先在 设置 → 模型与认证 里配置一个支持 /images/generations 的供应商。",
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Warn)})
		}
		body = append(body,
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text("画面描述", 10.5, ui.Medium, colors.Muted),
				core.Input{Value: a.imagePrompt.Get, OnChange: a.imagePrompt.Set, Multiline: true, AutoFocus: true,
					Placeholder: T("例如：雨夜的霓虹街道，电影感，广角"), Label: T("画面描述"), TestID: "image-prompt",
					Style: core.Style{MinHeight: core.Pt(72), MaxHeight: core.Pt(140), Padding: core.Symmetric(8, 10), FontSize: 12.5, Color: colors.Text()},
					StyleFunc: func() core.Style {
						return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 8,
							PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
					}},
			}},
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text("参考图（可选）", 10.5, ui.Medium, colors.Muted),
				core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.imageRef.Get, OnChange: a.imageRef.Set, Placeholder: T("填了就走 /images/edits，按描述修改这张图"),
							Label: T("参考图"), TestID: "image-ref",
							Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 11.5, FontFamily: ui.Mono, Color: colors.Text(),
								Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
					}},
					ui.Button{Text: T("选择…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "image-ref-pick",
						OnPress: func() { a.pickNative("image-ref") }},
				}},
			}},
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text("图片模型", 10.5, ui.Medium, colors.Muted),
				core.Input{Value: a.imageModel.Get, OnChange: a.imageModel.Set, Placeholder: "gpt-image-1 / Kwai-Kolors/Kolors",
					Label: T("图片模型"), TestID: "image-model",
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 12, FontFamily: ui.Mono, Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
			}},
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text("尺寸", 10.5, ui.Medium, colors.Muted),
				choiceChips(sizeChoices, func() string { return a.imageSize.Get() }, func(v string) { a.imageSize.Set(v) }),
			}},
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(T("数量"), 10.5, ui.Medium, colors.Muted),
				a.imageCountChips(colors),
			}},
		)
		switch {
		case busy:
			body = append(body, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(6, 0)}, Children: []core.Node{
				ui.Spinner{Size: 14}, ui.Text("正在生成，可能需要一会儿…", 11.5, ui.Regular, colors.Muted)}})
		case a.imageErr.Get() != "":
			body = append(body, core.Text{Content: a.imageErr.Get(), MaxLines: 4, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)})
		case len(results) > 0:
			thumbs := make([]core.Node, 0, len(results))
			for i := range results {
				idx := i
				selected := i == sel
				thumbs = append(thumbs, core.View{
					OnPress: func(core.PressEvent) { a.imageSelected.Set(idx) },
					Role:    core.RoleButton, Label: T("查看图片"), TestID: fmt.Sprintf("image-thumb-%d", i),
					StyleFunc: func() core.Style {
						border := colors.Border()
						if selected {
							border = colors.Accent()
						}
						return core.Style{Width: core.Pt(58), Height: core.Pt(58), CornerRadius: 8, Overflow: core.Hidden,
							BorderWidth: 2, BorderColor: border}
					},
					Children: []core.Node{core.Image{Source: core.ImageSource{Data: results[i]}, ResizeMode: core.Cover,
						Style: core.Style{Width: core.Pt(58), Height: core.Pt(58)}}},
				})
			}
			body = append(body, core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				core.Image{Source: core.ImageSource{Data: results[sel]}, ResizeMode: core.Contain, Label: T("生成的图片"),
					Style: core.Style{Width: core.Pt(280), Height: core.Pt(280), CornerRadius: 10, BorderWidth: 1, BorderColor: colors.Border()}},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, JustifyContent: core.JustifyCenter}, Children: thumbs},
			}})
		}
		footer := []core.Node{
			ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.imageOpen.Set(false) }},
		}
		if len(results) > 0 && !busy {
			footer = append(footer,
				ui.Button{Text: T("再生成"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "image-regenerate", OnPress: a.generateImageNow},
				ui.Button{Text: T("保存到项目"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "image-save", OnPress: a.saveGeneratedImage},
				ui.Button{Text: T("插入输入框"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "image-insert", OnPress: a.insertGeneratedImage})
		} else {
			footer = append(footer, ui.Button{Text: T("生成"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "image-generate",
				Disabled: func() bool { return a.imageBusy.Get() || len(providerChoices) == 0 }, OnPress: a.generateImageNow})
		}
		return ui.Dialog{
			Open:         a.imageOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.imageOpen.Set(open) },
			Title:        T("生成图片"),
			TestID:       "image-dialog",
			Style:        core.Style{Width: core.Pt(560), MaxHeight: core.Pt(680)},
			Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(540)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 12}, Children: body}}}},
			Footer: footer,
		}
	})
}

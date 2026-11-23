//go:build !js && !android && !ios

package workbench

import (
	"archive/zip"
	"context"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type settingsSyncForm struct {
	kind, path, id, token, password, status *core.Signal[string]
	busy                                    *core.Signal[bool]
	archive                                 *zip.Reader
	fileCount                               *core.Signal[int]
	cancel                                  context.CancelFunc
}

func (a *app) openSettingsSync() {
	if a.st == nil || a.settingsSync.GetUntracked() != nil {
		return
	}
	a.settingsSync.Set(&settingsSyncForm{kind: core.NewSignal(a.cx, "folder"), path: core.NewSignal(a.cx, ""), id: core.NewSignal(a.cx, ""),
		token: core.NewSignal(a.cx, ""), password: core.NewSignal(a.cx, ""), status: core.NewSignal(a.cx, ""), busy: core.NewSignal(a.cx, false),
		fileCount: core.NewSignal(a.cx, 0)})
}

func (a *app) closeSettingsSync() {
	if form := a.settingsSync.GetUntracked(); form != nil && form.cancel != nil {
		form.cancel()
	}
	a.settingsSync.Set(nil)
}

func (a *app) runSettingsSync(form *settingsSyncForm, upload bool) {
	if form.busy.GetUntracked() {
		return
	}
	target := settingsSyncTarget{kind: form.kind.GetUntracked(), path: form.path.GetUntracked(),
		id: strings.TrimSpace(form.id.GetUntracked()), token: strings.TrimSpace(form.token.GetUntracked())}
	if err := target.validate(upload); err != nil {
		form.status.Set(err.Error())
		return
	}
	password := form.password.GetUntracked()
	if (upload && !validSyncPassword(password)) || (!upload && (password == "" || len(password) > 512)) {
		form.status.Set(apptext.T("请输入至少 12 个字符的加密密码。"))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	form.busy.Set(true)
	form.status.Set("")
	form.fileCount.Set(0)
	form.archive, form.cancel = nil, cancel
	go func() {
		defer cancel()
		var result string
		var archive *zip.Reader
		var names []string
		var err error
		if upload {
			var raw, encrypted []byte
			raw, err = a.settingsZip()
			if err == nil {
				encrypted, err = encryptSettings(raw, password)
			}
			if err == nil {
				err = ctx.Err()
				if err == nil {
					result, err = target.upload(ctx, encrypted)
				}
			}
		} else {
			var data []byte
			data, err = target.download(ctx)
			if err == nil {
				archive, err = decryptSettings(data, password)
			}
			if err == nil {
				names, err = settingsArchiveNames(archive)
			}
		}
		a.cx.Post(func() {
			if a.settingsSync.GetUntracked() != form {
				return
			}
			form.busy.Set(false)
			form.cancel = nil
			if err != nil {
				form.status.Set(err.Error())
				return
			}
			if upload {
				if result != "" {
					form.id.Set(result)
				}
				form.status.Set(apptext.T("已保存加密设置包。"))
			} else {
				form.archive = archive
				form.fileCount.Set(len(names))
				form.status.Set(apptext.T("将恢复 %d 个文件并覆盖同名设置。", len(names)))
			}
		})
	}()
}

func (a *app) restoreSyncedSettings(form *settingsSyncForm) {
	archive := form.archive
	if archive == nil || form.busy.GetUntracked() {
		return
	}
	form.busy.Set(true)
	go func() {
		a.st.writeMu.Lock()
		err := a.applySettingsArchive(archive)
		if err == nil {
			if containsRestoredConfig(archive) {
				err = a.st.reload()
			}
		}
		a.st.writeMu.Unlock()
		a.cx.Post(func() {
			form.busy.Set(false)
			if err != nil {
				form.status.Set(err.Error())
				return
			}
			form.archive = nil
			a.closeSettingsSync()
			a.reloadSettingsAfterImport()
		})
	}()
}

func (a *app) settingsSyncDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		form := a.settingsSync.Get()
		if form == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		field := func(s *core.Signal[string], label, id string, masked bool) core.Node {
			return core.Input{Label: apptext.T(label), TestID: id, Value: s.Get, OnChange: s.Set, Masked: masked,
				Disabled: form.busy.Get, Style: panelFieldStyle(colors)}
		}
		return ui.Dialog{Title: apptext.T("加密同步"), TestID: "settings-sync-dialog", Style: core.Style{Width: a.dialogWidth()},
			Open: func() bool { return a.settingsSync.Get() != nil }, OnOpenChange: func(open bool, _ base.Reason) {
				if !open && !form.busy.GetUntracked() {
					a.closeSettingsSync()
				}
			}, Children: []core.Node{
				ui.Select[string]{Value: form.kind.Get, Label: apptext.T("同步位置"), TestID: "sync-target", Options: []ui.Option[string]{
					{Value: "folder", Label: apptext.T("本地目录")}, {Value: "gist", Label: "GitHub Gist"}, {Value: "drive", Label: "Google Drive"},
				}, OnChange: func(kind string) {
					if !form.busy.GetUntracked() {
						form.kind.Set(kind)
						form.id.Set("")
						form.token.Set("")
						form.status.Set("")
						form.archive = nil
						form.fileCount.Set(0)
					}
				}},
				core.Show{When: func() bool { return form.kind.Get() == "folder" }, Then: func(*core.Scope) core.Node {
					return core.Dynamic(func(*core.Scope) core.Node {
						return setRow("同步目录", form.path.Get(), ui.Button{Text: apptext.T("选择目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
							TestID: "sync-folder", Disabled: form.busy.Get,
							OnPress: func() {
								cx.PickDirectories(core.PickDirectoriesOptions{}, func(dirs []core.Directory, err error) {
									if err == nil && len(dirs) > 0 {
										form.path.Set(dirs[0].Path)
									}
								})
							}})
					})
				}, Else: func(*core.Scope) core.Node {
					return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
						setRow("远端文件 ID", "上传时留空可创建文件。", field(form.id, "远端文件 ID", "sync-file-id", false)),
						setRow("访问令牌", "Gist 令牌需允许写入 Gist，Drive 令牌需允许读写目标文件。", field(form.token, "访问令牌", "sync-token", true)),
					}}
				}},
				setRow("加密密码", "在另一台设备恢复时使用同一个密码。", field(form.password, "加密密码", "sync-password", true)),
				core.Text{ContentFunc: form.status.Get, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
			}, Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, TestID: "sync-close", Disabled: form.busy.Get, OnPress: a.closeSettingsSync},
				ui.Button{Text: apptext.T("保存到同步位置"), Variant: ui.ButtonSecondary, TestID: "sync-upload", Disabled: form.busy.Get, OnPress: func() { a.runSettingsSync(form, true) }},
				ui.Button{Text: apptext.T("读取并解密"), Variant: ui.ButtonSecondary, TestID: "sync-download", Disabled: form.busy.Get, OnPress: func() { a.runSettingsSync(form, false) }},
				core.Show{When: func() bool { return form.fileCount.Get() > 0 }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("恢复设置"), TestID: "sync-restore", Disabled: form.busy.Get, OnPress: func() { a.restoreSyncedSettings(form) }}
				}},
			}}
	})
}

//go:build !js && !android && !ios

package workbench

import "strings"

func (a *app) setPiExecutable(path string) {
	path = strings.TrimSpace(path)
	a.cfg.PiExecutable = path
	if a.st != nil {
		a.st.change(func(c *config) { c.PiExecutable = path })
		a.saveConfigAsync()
	}
	info := a.env.GetUntracked()
	info.PiPath, info.PiVersion, info.PiError = "", "", ""
	a.env.Set(info)
	a.bumpSettings()
	a.reprobePiRuntime()
}

// reprobePiRuntime refreshes only the local executable, without reloading
// plugins, remote hosts or open sessions while a settings control is edited.
func (a *app) reprobePiRuntime() {
	executable := a.cfg.PiExecutable
	info := a.env.GetUntracked()
	info.Probing = true
	a.env.Set(info)
	go func() {
		path, version, err := probePiWithExecutable("", "", executable)
		a.cx.Post(func() {
			if executable != a.cfg.PiExecutable {
				return
			}
			next := a.env.GetUntracked()
			next.PiPath, next.PiVersion, next.PiError = path, version, ""
			if err != nil {
				next.PiError = err.Error()
			}
			next.Probed, next.Probing = true, false
			a.env.Set(next)
		})
	}()
}

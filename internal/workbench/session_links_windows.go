//go:build !js && !android && !ios

package workbench

import (
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

func registerSessionLinks(scheme string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	path := `Software\Classes\` + scheme
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if err := key.SetStringValue("", "URL:PiDeck Lite"); err != nil {
		return err
	}
	if err := key.SetStringValue("URL Protocol", ""); err != nil {
		return err
	}
	cmd, _, err := registry.CreateKey(registry.CURRENT_USER, path+`\shell\open\command`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer cmd.Close()
	// REG_SZ prevents environment expansion in the installation path.
	return cmd.SetStringValue("", `"`+strings.ReplaceAll(exe, `"`, "")+`" "%1"`)
}

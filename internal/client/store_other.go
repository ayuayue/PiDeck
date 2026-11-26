//go:build !js

package client

// The last connection lives beside the app's data on a device with a disk.

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/nsgo-dev/nsgo/core"
)

func mobileStorePath(cx *core.Scope) string {
	dir := os.Getenv("PIDECK_V2_HOME")
	if dir == "" {
		dir = cx.DataDir()
	}
	return filepath.Join(dir, "remote.json")
}

func readMobileStore(cx *core.Scope) ([]byte, error) {
	return os.ReadFile(mobileStorePath(cx))
}

func writeMobileStore(cx *core.Scope, raw []byte) (retErr error) {
	path := mobileStorePath(cx)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".remote-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() {
		if err := os.Remove(tmpPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			retErr = errors.Join(retErr, err)
		}
	}()

	_, writeErr := tmp.Write(raw)
	syncErr := tmp.Sync()
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// webStart has nothing to say to a native build: no page served it.
func webStart() webEntry { return webEntry{} }

// setPageTitle has no tab to label on a device: its app is installed.
func setPageTitle(string) {}

// webReload has nothing to reload on a device: its app is installed.
func webReload() {}

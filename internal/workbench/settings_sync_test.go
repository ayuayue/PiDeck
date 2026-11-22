//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestEncryptedSettingsRoundTrip(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.Theme = "dark" })
	a := &app{st: st}
	raw, err := a.settingsZip()
	if err != nil {
		t.Fatal(err)
	}
	const password = "a sample passphrase"
	blob, err := encryptSettings(raw, password)
	if err != nil {
		t.Fatal(err)
	}
	target := settingsSyncTarget{kind: "folder", path: t.TempDir()}
	if _, err := target.upload(t.Context(), blob); err != nil {
		t.Fatal(err)
	}
	got, err := target.download(t.Context())
	if err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("encrypted package round trip: %v", err)
	}
	if _, err := decryptSettings(got, "the wrong passphrase"); err == nil {
		t.Fatal("wrong password decrypted the package")
	}
	modified := bytes.Clone(got)
	modified[len(modified)-1] ^= 1
	if _, err := decryptSettings(modified, password); err == nil {
		t.Fatal("modified package was accepted")
	}
	archive, err := decryptSettings(got, password)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.Theme = "light" })
	if err := a.applySettingsArchive(archive); err != nil {
		t.Fatal(err)
	}
	if err := st.reload(); err != nil || st.config().Theme != "dark" {
		t.Fatalf("restored theme = %q (%v)", st.config().Theme, err)
	}
}

func TestSettingsBackupSkipsExternalSymlink(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(*config) {})
	outside := filepath.Join(t.TempDir(), "external.json")
	if err := os.WriteFile(outside, []byte("external"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(st.dir, "plugins")
	if err := os.Mkdir(p, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(p, "external.json")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	a := &app{st: st}
	zipPath := filepath.Join(st.dir, "backup.zip")
	if err := a.writeSettingsZip(zipPath); err != nil {
		t.Fatal(err)
	}
	names, err := a.settingsZipNames(zipPath)
	if err != nil || len(names) != 1 || names[0] != "config.json" {
		t.Fatalf("included files = %v, %v", names, err)
	}
}

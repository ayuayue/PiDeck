package main

import (
	"testing"

	"example.com/pideck/internal/appinfo"
)

func TestReadManifestMissingUsesAppVersion(t *testing.T) {
	name, id, version := readManifest(t.TempDir())
	if name != "PiDeck" || id != fallbackID || version != appinfo.Version {
		t.Fatalf("manifest fallback = (%q, %q, %q), want (%q, %q, %q)", name, id, version,
			"PiDeck", fallbackID, appinfo.Version)
	}
}

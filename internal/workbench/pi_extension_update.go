//go:build !js && !android && !ios

package workbench

// Hot update for the pi extensions this build ships. The remote manifest is
// PiDeck's extensions-manifest.json; only files this build already knows are
// accepted, and every byte is checked against the manifest before a file is
// replaced. A failed check leaves the current copy alone.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

const (
	piExtensionManifestPath = "resources/extensions/extensions-manifest.json"
	piExtensionManifestMax  = 256 << 10
	piExtensionFileMax      = 1 << 20
)

var (
	piExtensionNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+\.ts$`)
	piExtensionSHA256      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// piExtensionManifestFile is one file's expected size and hash.
type piExtensionManifestFile struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type piExtensionManifest struct {
	Version string                    `json:"version"`
	Files   []piExtensionManifestFile `json:"files"`
}

// parsePiExtensionManifest validates the remote document; unknown shapes are
// rejected as a whole rather than partially trusted.
func parsePiExtensionManifest(raw []byte) (piExtensionManifest, error) {
	var doc struct {
		SchemaVersion int    `json:"schemaVersion"`
		Version       string `json:"version"`
		Files         []piExtensionManifestFile
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return piExtensionManifest{}, errors.New("内置扩展清单不是有效的 JSON")
	}
	if doc.SchemaVersion != 1 {
		return piExtensionManifest{}, fmt.Errorf("不支持的内置扩展清单版本 %d", doc.SchemaVersion)
	}
	if doc.Version == "" || len(doc.Version) > 64 {
		return piExtensionManifest{}, errors.New("内置扩展清单缺少版本号")
	}
	if len(doc.Files) == 0 || len(doc.Files) > 64 {
		return piExtensionManifest{}, errors.New("内置扩展清单的文件数不合法")
	}
	seen := map[string]bool{}
	for _, file := range doc.Files {
		name := file.Name
		if !piExtensionNamePattern.MatchString(name) || seen[name] {
			return piExtensionManifest{}, fmt.Errorf("内置扩展清单包含非法文件名 %q", name)
		}
		if !piExtensionSHA256.MatchString(file.SHA256) || file.Bytes <= 0 || file.Bytes > piExtensionFileMax {
			return piExtensionManifest{}, fmt.Errorf("内置扩展清单中 %s 的大小或摘要不合法", name)
		}
		seen[name] = true
	}
	return piExtensionManifest{Version: doc.Version, Files: doc.Files}, nil
}

// piExtensionUpdateSources lists the places a repository file can come from,
// AtomGit first because it is reachable without GitHub.
func piExtensionUpdateSources(relPath string) []string {
	atomgit := "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/" + relPath + "?ref=main"
	github := "https://raw.githubusercontent.com/ayuayue/PiDeck/main/" + relPath
	return []string{atomgit, github}
}

// fetchPiExtensionRepoFile downloads one repository file through the first
// source that answers, decoding AtomGit's base64 contents response.
func fetchPiExtensionRepoFile(ctx context.Context, relPath string, limit int64) ([]byte, error) {
	var lastErr error
	for _, source := range piExtensionUpdateSources(relPath) {
		raw, err := downloadCatalogData(ctx, source, limit*2+8192)
		if err != nil {
			lastErr = err
			continue
		}
		if data, ok := decodeAtomGitFile(raw); ok {
			if int64(len(data)) > limit {
				lastErr = errors.New("文件超过大小上限")
				continue
			}
			return data, nil
		}
		if int64(len(raw)) > limit {
			lastErr = errors.New("文件超过大小上限")
			continue
		}
		return raw, nil
	}
	if lastErr == nil {
		lastErr = errors.New("没有可用的下载源")
	}
	return nil, lastErr
}

// decodeAtomGitFile unwraps AtomGit's contents JSON. Raw bytes that are not
// that shape come back unchanged.
func decodeAtomGitFile(raw []byte) ([]byte, bool) {
	var doc struct{ Type, Encoding, Content string }
	if json.Unmarshal(raw, &doc) != nil || doc.Type != "file" || doc.Content == "" {
		return nil, false
	}
	if doc.Encoding == "base64" {
		data, err := base64.StdEncoding.DecodeString(doc.Content)
		if err != nil {
			return nil, false
		}
		return data, true
	}
	return []byte(doc.Content), true
}

// fetchPiExtensionManifest reads and validates the remote manifest.
func fetchPiExtensionManifest(ctx context.Context) (piExtensionManifest, error) {
	raw, err := fetchPiExtensionRepoFile(ctx, piExtensionManifestPath, piExtensionManifestMax)
	if err != nil {
		return piExtensionManifest{}, err
	}
	return parsePiExtensionManifest(raw)
}

// bundledExtensionNames is the set hot update may replace: the files this
// build ships, including modules loaded beside an extension.
func bundledExtensionNames() map[string]bool {
	names := map[string]bool{askExtensionName: true}
	for _, ext := range bundledExtensions() {
		names[ext.Name] = true
		for _, mod := range ext.Modules {
			names[mod.Name] = true
		}
	}
	return names
}

// sha256Text is a file's digest in the manifest's lowercase hex form.
func sha256Text(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// piExtensionContentMatches reports whether data is exactly what the
// manifest lists.
func piExtensionContentMatches(data []byte, file piExtensionManifestFile) bool {
	return int64(len(data)) == file.Bytes && sha256Text(data) == file.SHA256
}

// updateBundledPiExtensions checks the remote manifest and replaces only
// files whose digest differs. Every file is verified before any write.
func (a *app) updateBundledPiExtensions() {
	if a.piExtUpdateBusy.GetUntracked() {
		return
	}
	a.piExtUpdateBusy.Set(true)
	dir := a.dataDir
	go func() {
		base := a.lifetime
		if base == nil {
			base = context.Background()
		}
		ctx, cancel := context.WithTimeout(base, 90*time.Second)
		defer cancel()
		manifest, err := fetchPiExtensionManifest(ctx)
		if err != nil {
			a.cx.Post(func() {
				a.piExtUpdateBusy.Set(false)
				a.toast(ui.ToastError, apptext.T("更新内置扩展失败"), err.Error())
			})
			return
		}
		known := bundledExtensionNames()
		type pending struct {
			name    string
			content []byte
		}
		var changes []pending
		for _, file := range manifest.Files {
			if !known[file.Name] || piLoadsExtension(file.Name) {
				continue
			}
			path := filepath.Join(dir, "extensions", file.Name)
			if current, err := os.ReadFile(path); err == nil {
				if piExtensionContentMatches(current, file) {
					continue
				}
			}
			data, err := fetchPiExtensionRepoFile(ctx, "resources/extensions/"+file.Name, piExtensionFileMax)
			if err != nil {
				a.cx.Post(func() {
					a.piExtUpdateBusy.Set(false)
					a.toast(ui.ToastError, apptext.T("更新内置扩展失败"), err.Error())
				})
				return
			}
			if !piExtensionContentMatches(data, file) {
				a.cx.Post(func() {
					a.piExtUpdateBusy.Set(false)
					a.toast(ui.ToastError, apptext.T("更新内置扩展失败"), apptext.T("%s 的摘要与清单不符", file.Name))
				})
				return
			}
			changes = append(changes, pending{name: file.Name, content: data})
		}
		for _, change := range changes {
			if writeBundledExtension(dir, change.name, change.content) == "" {
				a.cx.Post(func() {
					a.piExtUpdateBusy.Set(false)
					a.toast(ui.ToastError, apptext.T("更新内置扩展失败"), apptext.T("无法写入 %s", change.name))
				})
				return
			}
		}
		a.cx.Post(func() {
			a.piExtUpdateBusy.Set(false)
			if len(changes) == 0 {
				a.toast(ui.ToastSuccess, apptext.T("内置扩展已是最新"), apptext.T("版本 %s", manifest.Version))
				return
			}
			a.toast(ui.ToastSuccess, apptext.T("内置扩展已更新"),
				apptext.T("已更新 %d 个文件（版本 %s）", len(changes), manifest.Version))
		})
	}()
}

//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"example.com/pideck-v2/assets"
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

const communityPromptsURL = "https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv"
const chinesePromptsBase = "https://github.com/ayuayue/PiDeck/releases/latest/download"

// The public prompts.chat CSV is data, never an executable plugin.
func parseCommunityPrompts(raw []byte) (promptPack, error) {
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return promptPack{}, err
	}
	title, body := -1, -1
	for i, key := range header {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "act", "title":
			title = i
		case "prompt", "body":
			body = i
		}
	}
	if title < 0 || body < 0 {
		return promptPack{}, errors.New("not a prompts.chat CSV")
	}
	pack := promptPack{Name: "prompts.chat"}
	for len(pack.Prompts) < 10000 {
		row, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return promptPack{}, err
		}
		if title >= len(row) || body >= len(row) || strings.TrimSpace(row[title]) == "" || strings.TrimSpace(row[body]) == "" || len(row[body]) > 64<<10 {
			continue
		}
		pack.Prompts = append(pack.Prompts, promptPackEntry{Title: row[title], Body: row[body], Category: pack.Name})
	}
	if len(pack.Prompts) == 0 {
		return promptPack{}, errors.New("empty prompts.chat CSV")
	}
	return pack, nil
}

// Verify before replacing the cache; a failed refresh leaves the last
// usable database in place. Immutable read-only SQLite cannot write files.
func fetchChinesePrompts(ctx context.Context, base, cache string) (promptPack, error) {
	shaText, err := downloadCatalogData(ctx, base+"/xueprompts.db.sha256", 4096)
	if err != nil {
		return promptPack{}, err
	}
	parts := strings.Fields(string(shaText))
	if len(parts) == 0 {
		return promptPack{}, errors.New("missing prompt database checksum")
	}
	expected, err := hex.DecodeString(parts[0])
	if err != nil || len(expected) != sha256.Size {
		return promptPack{}, errors.New("invalid prompt database checksum")
	}
	if raw, err := os.ReadFile(cache); err == nil {
		sum := sha256.Sum256(raw)
		if bytes.Equal(sum[:], expected) {
			return readChinesePrompts(ctx, cache)
		}
	}
	raw, err := downloadCatalogData(ctx, base+"/xueprompts.db", 16<<20)
	if err != nil {
		return promptPack{}, err
	}
	sum := sha256.Sum256(raw)
	if !bytes.Equal(sum[:], expected) {
		return promptPack{}, errors.New("prompt database checksum mismatch")
	}
	if err := os.MkdirAll(filepath.Dir(cache), 0o700); err != nil {
		return promptPack{}, err
	}
	f, err := os.CreateTemp(filepath.Dir(cache), "xueprompts-*.db")
	if err != nil {
		return promptPack{}, err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_, err = f.Write(raw)
	closeErr := f.Close()
	if err != nil {
		return promptPack{}, err
	}
	if closeErr != nil {
		return promptPack{}, closeErr
	}
	pack, err := readChinesePrompts(ctx, tmp)
	if err != nil {
		return promptPack{}, err
	}
	if err := os.Rename(tmp, cache); err != nil {
		return promptPack{}, err
	}
	return pack, nil
}

func readChinesePrompts(ctx context.Context, file string) (promptPack, error) {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(file), RawQuery: "mode=ro&immutable=1"}
	if !strings.HasPrefix(u.Path, "/") {
		u.Path = "/" + u.Path
	}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return promptPack{}, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	rows, err := db.QueryContext(ctx, `SELECT title, content, COALESCE(category, '') FROM xueprompts LIMIT 10001`)
	if err != nil {
		return promptPack{}, err
	}
	defer rows.Close()
	pack := promptPack{Name: "中文提示词库"}
	for rows.Next() {
		var p promptPackEntry
		var content []byte
		if err := rows.Scan(&p.Title, &content, &p.Category); err != nil {
			return promptPack{}, err
		}
		p.Body = chinesePromptContent(content)
		if len(pack.Prompts) >= 10000 {
			return promptPack{}, errors.New("prompt database has too many records")
		}
		if strings.TrimSpace(p.Title) == "" || strings.TrimSpace(p.Body) == "" || len(p.Body) > 64<<10 {
			continue
		}
		pack.Prompts = append(pack.Prompts, p)
	}
	if err := rows.Err(); err != nil {
		return promptPack{}, err
	}
	if len(pack.Prompts) == 0 {
		return promptPack{}, errors.New("empty prompt database")
	}
	return pack, nil
}

// Recent xueprompts releases store content as gzip BLOBs; old databases
// store UTF-8 text. Bound decompression before accepting either variant.
func chinesePromptContent(raw []byte) string {
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		r, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return ""
		}
		defer r.Close()
		raw, err = io.ReadAll(io.LimitReader(r, (64<<10)+1))
		if err != nil {
			return ""
		}
	}
	if len(raw) > 64<<10 || !utf8.Valid(raw) {
		return ""
	}
	return string(raw)
}

func (a *app) importChinesePrompts() {
	if a.promptStoreBusy.GetUntracked() || a.st == nil {
		return
	}
	a.promptStoreBusy.Set(true)
	a.promptStoreErr.Set("")
	ctx, cancel := context.WithTimeout(a.lifetime, 6*time.Minute)
	cache := filepath.Join(a.st.dir, "cache", "xueprompts.db")
	go func() {
		defer cancel()
		pack, err := fetchChinesePrompts(ctx, chinesePromptsBase, cache)
		// A network outage must not turn an already cached library empty.
		if err != nil && a.lifetime.Err() == nil {
			cached, stop := context.WithTimeout(a.lifetime, 10*time.Second)
			if saved, cacheErr := readChinesePrompts(cached, cache); cacheErr == nil {
				pack, err = saved, nil
			}
			stop()
		}
		added := 0
		if err == nil {
			added, _, err = a.importPromptPack(pack)
		}
		var list []promptItem
		if err == nil {
			list = a.loadPrompts()
		}
		a.cx.Post(func() {
			a.promptStoreBusy.Set(false)
			if err != nil {
				a.promptStoreErr.Set(err.Error())
				return
			}
			a.prompts.Set(list)
			a.toast(ui.ToastSuccess, apptext.T("已导入 %d 条", added), "")
		})
	}()
}

// officialPromptPack is PiDeck's bundled template pack, shown in the store
// rather than written into the user's library at startup.
func officialPromptPack() (promptPack, error) {
	var pack promptPack
	if err := json.Unmarshal(assets.OfficialPrompts, &pack); err != nil {
		return promptPack{}, err
	}
	if len(pack.Prompts) == 0 {
		return promptPack{}, errors.New("内置提示词包为空")
	}
	return pack, nil
}

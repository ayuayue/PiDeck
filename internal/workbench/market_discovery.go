//go:build !js && !android && !ios

package workbench

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

var officialPluginSources = []string{
	"https://pideck-plugins.caoayu.top/registry-v2.json",
	"https://raw.githubusercontent.com/ayuayue/pideck-plugins/main/registry.json",
	"https://api.atomgit.com/api/v5/repos/ayuayue/pideck-plugins/raw/registry.json?ref=main",
}

const communityPluginSource = "https://api.github.com/search/repositories?q=topic:pideck-plugin&sort=stars&order=desc&per_page=30"

func validCatalogSegment(s string) bool {
	return s != "." && s != ".." && len(s) <= 100 && marketID.MatchString(s)
}

func parseOfficialPlugins(raw []byte) ([]marketEntry, error) {
	var doc struct {
		SchemaVersion int `json:"schemaVersion"`
		Plugins       []struct{ ID, Name, Description, Version, Author, Repo, Host, Ref, Subpath, Runtime, URL string }
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if doc.SchemaVersion != 1 && doc.SchemaVersion != 2 {
		return nil, errors.New("unsupported plugin registry version")
	}
	var out []marketEntry
	seen := map[string]bool{}
	for _, p := range doc.Plugins {
		if doc.SchemaVersion == 2 && p.Runtime == "" {
			continue // v2 mixed registries must declare the runtime
		}
		parts := strings.Split(p.Repo, "/")
		if len(parts) != 2 || !validCatalogSegment(parts[0]) || !validCatalogSegment(parts[1]) || p.Name == "" {
			continue
		}
		host := "github.com"
		if p.Host == "atomgit" || p.Host == "atomgit.com" {
			host = "atomgit.com"
		}
		address := "https://" + host + "/" + p.Repo
		if p.Subpath != "" && !strings.Contains(p.Subpath, "..") && !strings.ContainsAny(p.Subpath, "\\?#") {
			address += "/tree/" + url.PathEscape(firstNonEmpty(p.Ref, "main")) + "/" + strings.Trim(p.Subpath, "/")
		}
		sum := sha256.Sum256([]byte(host + "/" + p.Repo + "/" + p.ID + "/" + p.Subpath))
		entry := marketEntry{ID: "repo-" + hex.EncodeToString(sum[:8]), Name: p.Name, Description: p.Description,
			Version: p.Version, Author: p.Author, URL: address, Runtime: firstNonEmpty(p.Runtime, "pideck-electron"), External: true}
		// A Lite entry must explicitly name both its runtime and manifest.
		// host remains the code forge; it never grants runtime compatibility.
		if p.Runtime == litePluginRuntime && validCatalogSegment(p.ID) && isHTTPURL(p.URL) {
			entry.ID, entry.URL, entry.External = p.ID, p.URL, false
		}
		if seen[entry.ID] {
			continue
		}
		seen[entry.ID] = true
		out = append(out, entry)
		if len(out) >= 100 {
			break
		}
	}
	if len(out) == 0 {
		return nil, errors.New("plugin registry contains no repositories")
	}
	return out, nil
}

func parseCommunityPlugins(raw []byte) ([]marketEntry, error) {
	var doc struct {
		Items []struct {
			FullName          string `json:"full_name"`
			Name, Description string
		}
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	var out []marketEntry
	for _, p := range doc.Items {
		parts := strings.Split(p.FullName, "/")
		if len(parts) != 2 || !validCatalogSegment(parts[0]) || !validCatalogSegment(parts[1]) {
			continue
		}
		out = append(out, marketEntry{ID: "repo-" + strings.ReplaceAll(p.FullName, "/", "-"), Name: firstNonEmpty(p.Name, p.FullName), Description: p.Description, Author: parts[0], URL: "https://github.com/" + p.FullName, External: true})
		if len(out) >= 30 {
			break
		}
	}
	return out, nil
}

func fetchOfficialPlugins(ctx context.Context, sources []string) ([]marketEntry, error) {
	last := errors.New("plugin registry has no sources")
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// Leave time for the compatibility feeds if the Pages origin stalls.
		attempt, cancel := context.WithTimeout(ctx, 8*time.Second)
		raw, err := downloadCatalogData(attempt, source, 1<<20)
		cancel()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err == nil {
			var list []marketEntry
			if list, err = parseOfficialPlugins(raw); err == nil {
				return list, nil
			}
		}
		last = err
	}
	return nil, last
}

func (a *app) discoverPlugins(community bool) {
	if !a.marketOpen.GetUntracked() {
		return
	}
	ctx, gen := a.startPluginMarketRequest()
	go func() {
		var list []marketEntry
		var err error
		if community {
			var raw []byte
			raw, err = downloadCatalogData(ctx, communityPluginSource, 1<<20)
			if err == nil {
				list, err = parseCommunityPlugins(raw)
			}
		} else {
			list, err = fetchOfficialPlugins(ctx, officialPluginSources)
		}
		a.cx.Post(func() {
			a.finishPluginMarketRequest(gen, list, err)
		})
	}()
}

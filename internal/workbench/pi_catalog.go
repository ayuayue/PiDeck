//go:build !js && !android && !ios

package workbench

// The read-only half of the extension store: pi.dev's package directory.
// The page is server-rendered HTML, so this parses the cards' data
// attributes and the result count. Nothing here installs anything.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const piCatalogURL = "https://pi.dev/packages"

// piCatalogItem is one package card.
type piCatalogItem struct {
	Name          string
	Description   string
	Author        string
	Types         []string
	InstallSource string // npm:<name> or git:github.com/<owner>/<repo>
	PageURL       string
}

// piCatalogPage is one page of results.
type piCatalogPage struct {
	Items []piCatalogItem
	Page  int
	Last  int
	Total int
}

var (
	piCatalogCardRe   = regexp.MustCompile(`(?s)<article[^>]*data-package-card="true"[^>]*>`)
	piCatalogDescRe   = regexp.MustCompile(`(?s)<p class="packages-desc">(.*?)</p>`)
	piCatalogAuthorRe = regexp.MustCompile(`(?s)<div class="packages-meta">\s*<span>(.*?)</span>`)
	piCatalogNPMRe    = regexp.MustCompile(`href="(https://www\.npmjs\.com/package/[^"]+)"`)
	piCatalogGitRe    = regexp.MustCompile(`href="(https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"`)
	piCatalogPageRe   = regexp.MustCompile(`class="packages-name"><a href="([^"]+)"`)
	piCatalogCountRe  = regexp.MustCompile(`class="packages-count">\s*(\d+)\s*-\s*(\d+)\s*/\s*(\d+)`)
	piCatalogTagRe    = regexp.MustCompile(`(?s)<[^>]*>`)
	piCatalogEntityRe = regexp.MustCompile(`&#x([0-9a-fA-F]+);|&#(\d+);`)
)

// piCatalogPageURL builds one directory page's address.
func piCatalogPageURL(query string, page int) string {
	values := url.Values{}
	if query = strings.TrimSpace(query); query != "" {
		values.Set("name", query)
	}
	if page > 1 {
		values.Set("page", strconv.Itoa(page))
	}
	if encoded := values.Encode(); encoded != "" {
		return piCatalogURL + "?" + encoded
	}
	return piCatalogURL
}

// fetchPiCatalog reads one directory page.
func fetchPiCatalog(ctx context.Context, query string, page int) (piCatalogPage, error) {
	if page < 1 {
		page = 1
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, piCatalogPageURL(query, page), nil)
	if err != nil {
		return piCatalogPage{}, err
	}
	req.Header.Set("Accept", "text/html")
	resp, err := appHTTPClient.Do(req)
	if err != nil {
		return piCatalogPage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return piCatalogPage{}, fmt.Errorf("pi.dev returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return piCatalogPage{}, err
	}
	items, total, pageSize := parsePiCatalogHTML(string(raw))
	last := 1
	if total > 0 && pageSize > 0 {
		last = max(1, (total+pageSize-1)/pageSize)
	}
	if last < page {
		last = page
	}
	return piCatalogPage{Items: items, Page: page, Last: last, Total: total}, nil
}

// parsePiCatalogHTML reads the cards and the "1-50 / 5300" total. A broken
// card is skipped, not fatal.
func parsePiCatalogHTML(raw string) ([]piCatalogItem, int, int) {
	var items []piCatalogItem
	tags := piCatalogCardRe.FindAllStringIndex(raw, -1)
	for i, bounds := range tags {
		tag := raw[bounds[0]:bounds[1]]
		name := packageAttr(tag, "data-package-name")
		if name == "" {
			continue
		}
		end := len(raw)
		if i+1 < len(tags) {
			end = tags[i+1][0]
		}
		body := raw[bounds[1]:end]
		item := piCatalogItem{
			Name:    decodeCatalogText(name),
			Author:  decodeCatalogText(stripCatalogTags(submatch(piCatalogAuthorRe, body))),
			Types:   strings.Fields(packageAttr(tag, "data-package-types")),
			PageURL: resolveCatalogURL(submatch(piCatalogPageRe, body)),
		}
		item.Description = decodeCatalogText(stripCatalogTags(submatch(piCatalogDescRe, body)))
		if strings.TrimSpace(submatch(piCatalogNPMRe, body)) != "" {
			item.InstallSource = "npm:" + item.Name
		} else if repo := submatch(piCatalogGitRe, body); repo != "" {
			item.InstallSource = "git:" + strings.TrimPrefix(repo, "https://")
		}
		if item.PageURL == "" {
			item.PageURL = piCatalogURL + "/" + item.Name
		}
		items = append(items, item)
	}
	total, pageSize := len(items), len(items)
	if match := piCatalogCountRe.FindStringSubmatch(raw); match != nil {
		start, startErr := strconv.Atoi(match[1])
		end, endErr := strconv.Atoi(match[2])
		parsed, parseErr := strconv.Atoi(match[3])
		if startErr == nil && endErr == nil && start >= 1 && end >= start {
			pageSize = end - start + 1
		}
		if parseErr == nil && parsed >= total {
			total = parsed
		}
	}
	return items, total, pageSize
}

// packageAttr reads one data-* attribute from an element tag.
func packageAttr(tag, name string) string {
	key := name + `="`
	start := strings.Index(tag, key)
	if start < 0 {
		return ""
	}
	rest := tag[start+len(key):]
	end := strings.IndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	return rest[:end]
}

func submatch(re *regexp.Regexp, body string) string {
	match := re.FindStringSubmatch(body)
	if match == nil {
		return ""
	}
	return match[1]
}

func stripCatalogTags(text string) string {
	return piCatalogTagRe.ReplaceAllString(text, "")
}

// decodeCatalogText handles the entities the directory puts in card text.
func decodeCatalogText(text string) string {
	text = piCatalogEntityRe.ReplaceAllStringFunc(text, func(entity string) string {
		value, base := entity[2:len(entity)-1], 10
		if strings.HasPrefix(entity, "&#x") {
			value, base = entity[3:len(entity)-1], 16
		}
		parsed, err := strconv.ParseInt(value, base, 32)
		if err != nil {
			return entity
		}
		return string(rune(parsed))
	})
	return strings.NewReplacer(
		"&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&apos;", "'",
		"&nbsp;", " ", "&amp;", "&",
	).Replace(text)
}

func resolveCatalogURL(href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	base, err := url.Parse("https://pi.dev")
	if err != nil {
		return ""
	}
	ref, err := url.Parse(href)
	if err != nil {
		return ""
	}
	return base.ResolveReference(ref).String()
}

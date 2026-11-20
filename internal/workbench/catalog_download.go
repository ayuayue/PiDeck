//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func downloadCatalogData(ctx context.Context, address string, limit int64) ([]byte, error) {
	// GitHub's API and raw host have different network reachability. Use
	// the bounded contents/blob API for public raw catalog links so these
	// sources also work where raw.githubusercontent.com cannot resolve.
	u, err := url.Parse(address)
	if err == nil && u.Scheme == "https" && u.Host == "raw.githubusercontent.com" {
		parts := strings.SplitN(strings.TrimPrefix(u.Path, "/"), "/", 4)
		if len(parts) != 4 || !validCatalogSegment(parts[0]) || !validCatalogSegment(parts[1]) || !validCatalogSegment(parts[2]) {
			return nil, errors.New("invalid public GitHub catalog URL")
		}
		repo := parts[0] + "/" + parts[1]
		api := "https://api.github.com/repos/" + repo + "/contents/" + parts[3] + "?ref=" + url.QueryEscape(parts[2])
		raw, err := downloadCatalogHTTP(ctx, api, limit*2+8192)
		if err != nil {
			return nil, err
		}
		data, sha, err := decodeGitHubCatalog(raw, limit)
		if err != nil || sha == "" {
			return data, err
		}
		raw, err = downloadCatalogHTTP(ctx, "https://api.github.com/repos/"+repo+"/git/blobs/"+sha, limit*2+8192)
		if err != nil {
			return nil, err
		}
		data, _, err = decodeGitHubCatalog(raw, limit)
		if data == nil && err == nil {
			err = errors.New("GitHub catalog has no content")
		}
		return data, err
	}
	return downloadCatalogHTTP(ctx, address, limit)
}

func decodeGitHubCatalog(raw []byte, limit int64) ([]byte, string, error) {
	var doc struct {
		Content, Encoding, SHA string
		Size                   int64
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, "", err
	}
	if doc.Size < 0 || doc.Size > limit {
		return nil, "", errors.New("GitHub catalog exceeds size limit")
	}
	if doc.Encoding == "none" && len(doc.SHA) == 40 && strings.Trim(doc.SHA, "0123456789abcdef") == "" {
		return nil, doc.SHA, nil
	}
	if doc.Encoding != "base64" {
		return nil, "", errors.New("invalid GitHub catalog encoding")
	}
	data, err := base64.StdEncoding.DecodeString(doc.Content)
	if err == nil && int64(len(data)) > limit {
		err = errors.New("GitHub catalog exceeds size limit")
	}
	return data, "", err
}

func downloadCatalogHTTP(ctx context.Context, address string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	// Release databases and CSV libraries are multi-megabyte assets. A
	// slow but progressing download can exceed the model-call timeout;
	// the caller still controls cancellation and any shorter deadline.
	client := *appHTTPLongClient
	client.Timeout = 6 * time.Minute
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("catalog source exceeds size limit")
	}
	return data, err
}

//go:build !js && !android && !ios

package workbench

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var usageProbeVolcengineRegion = regexp.MustCompile(`(?i)^(cn|ap)-[a-z-]+$`)

func usageProbeResolveVolcengineRegion(base string) string {
	base = strings.TrimSpace(base)
	if i := strings.Index(base, "://"); i >= 0 {
		base = base[i+3:]
	}
	host := strings.SplitN(base, "/", 2)[0]
	for _, part := range strings.Split(host, ".") {
		if usageProbeVolcengineRegion.MatchString(part) {
			return strings.ToLower(part)
		}
	}
	return "cn-beijing"
}

func usageProbeVolcengineQuery(action, region string) string {
	query := url.Values{"Action": {action}, "Region": {region}, "Version": {"2024-01-01"}}
	return strings.ReplaceAll(query.Encode(), "+", "%20")
}

func usageProbeVolcengineHeaders(accessKeyID, secret, action, region, host string, now time.Time) map[string]string {
	hash := func(value string) string {
		sum := sha256.Sum256([]byte(value))
		return hex.EncodeToString(sum[:])
	}
	hmacBytes := func(key []byte, value string) []byte {
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(value))
		return mac.Sum(nil)
	}
	xDate := now.UTC().Format("20060102T150405Z")
	shortDate := xDate[:8]
	payloadHash := hash("{}")
	const contentType = "application/json; charset=utf-8"
	const signed = "host;x-date;x-content-sha256;content-type"
	// Volcengine fixes this header order and omits both AWS4 prefixes.
	canonicalHeaders := fmt.Sprintf("host:%s\nx-date:%s\nx-content-sha256:%s\ncontent-type:%s\n", host, xDate, payloadHash, contentType)
	canonical := strings.Join([]string{"POST", "/", usageProbeVolcengineQuery(action, region), canonicalHeaders, signed, payloadHash}, "\n")
	scope := shortDate + "/" + region + "/ark/request"
	toSign := strings.Join([]string{"HMAC-SHA256", xDate, scope, hash(canonical)}, "\n")
	key := []byte(secret)
	for _, part := range []string{shortDate, region, "ark", "request"} {
		key = hmacBytes(key, part)
	}
	signature := hex.EncodeToString(hmacBytes(key, toSign))
	return map[string]string{
		"Authorization": fmt.Sprintf("HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKeyID, scope, signed, signature),
		"Content-Type":  contentType, "X-Date": xDate, "X-Content-Sha256": payloadHash,
	}
}

func usageProbeVolcengineCandidates(base string, config usageProbeConfig) []usageProbeCandidate {
	region := usageProbeResolveVolcengineRegion(base)
	var candidates []usageProbeCandidate
	for _, action := range []string{"GetAFPUsage", "GetCodingPlanUsage"} {
		for _, host := range []string{"ark." + region + ".volcengineapi.com", "open.volcengineapi.com"} {
			query := usageProbeVolcengineQuery(action, region)
			candidates = append(candidates, usageProbeCandidate{
				path: "/?" + query, absoluteURL: "https://" + host + "/?" + query,
				method: "POST", body: map[string]any{}, noBearer: true,
				headers: usageProbeVolcengineHeaders(config.AccessKeyID, config.SecretAccessKey, action, region, host, time.Now()),
				parse:   usageProbeParse{kind: "custom", resolver: "volcengine-plan"},
			})
		}
	}
	return candidates
}

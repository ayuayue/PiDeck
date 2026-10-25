package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestIndexTableMatchesGolden 对照 scripts/genSessionStoreIndexGolden.mjs 生成的基准，
// 证明 Go 侧的条目表解析没有漂移。
//
// 基准是 Go 自己的输出（脚本用真实二进制生成）：它同时被
// tests/sessionStoreIndexParity.test.mjs（证明与 TS 的 parseIndexLine 语义等价）使用，
// 所以改动解析语义必须重跑脚本并同步 TS 侧，否则两侧测试都会红。
//
// path/mtimeMs 与机器相关（脚本生成时已归零），比较前再归一化一次。
func TestIndexTableMatchesGolden(t *testing.T) {
	fixture := filepath.Join("..", "..", "tests", "fixtures", "sessionStoreIndexParity.jsonl")
	goldenPath := filepath.Join("..", "..", "tests", "fixtures", "sessionStoreIndexParity.golden.json")
	info, err := os.Stat(fixture)
	if err != nil {
		t.Skipf("fixture 不可用：%v", err)
	}
	goldenRaw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Skipf("golden 不可用（先跑 node scripts/genSessionStoreIndexGolden.mjs）：%v", err)
	}
	var want table
	if err := json.Unmarshal(goldenRaw, &want); err != nil {
		t.Fatalf("golden 解析失败：%v", err)
	}
	got, err := scanTable(fixture, info.Size(), 0)
	if err != nil {
		t.Fatalf("scanTable 失败：%v", err)
	}
	got.Path, got.MtimeMs = "", 0
	want.Path, want.MtimeMs = "", 0
	if reflect.DeepEqual(got, want) {
		return
	}
	gotRaw, _ := json.MarshalIndent(got, "", "  ")
	wantRaw, _ := json.MarshalIndent(want, "", "  ")
	t.Fatalf("条目表与基准不一致（改了解析语义就要重跑 scripts/genSessionStoreIndexGolden.mjs 并同步 TS 侧）\n--- got ---\n%s\n--- want ---\n%s", gotRaw, wantRaw)
}

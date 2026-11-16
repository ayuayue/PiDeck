//go:build !js && !android && !ios

package main

// Two tools keep their history in SQLite rather than files: ZCode and
// OpenCode. The database is opened read-only, and its write-ahead log is
// read too, so a session being written right now is still complete.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// importDBSizeLimit refuses a database too big to open in a bounded time: a
// session import is a few seconds' work, not a minute's.
const importDBSizeLimit = 512 << 20

// openImportDB opens a SQLite file read-only, log included.
func openImportDB(path string) (*sql.DB, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > importDBSizeLimit {
		return nil, fmt.Errorf("数据库太大（%s），先清理再导入", shortSize(info.Size()))
	}
	dsn := "file:" + filepath.ToSlash(path) + "?mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(3000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		// A log being written may refuse a read-only handle; letting the
		// driver recover it is still read-only work.
		db, err = sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=query_only(1)&_pragma=busy_timeout(3000)")
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1)
		if err := db.Ping(); err != nil {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}

// importDBTables lists a database's tables and columns.
func importDBTables(db *sql.DB) (map[string]map[string]bool, error) {
	rows, err := db.Query(`select name from sqlite_master where type='table'`)
	if err != nil {
		return nil, err
	}
	var names []string
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			names = append(names, name)
		}
	}
	rows.Close()
	tables := map[string]map[string]bool{}
	for _, name := range names {
		cols := map[string]bool{}
		info, err := db.Query(`pragma table_info("` + strings.ReplaceAll(name, `"`, `""`) + `")`)
		if err != nil {
			continue
		}
		for info.Next() {
			var cid int
			var col, kind string
			var notNull, pk int
			var def any
			if info.Scan(&cid, &col, &kind, &notNull, &def, &pk) == nil {
				cols[col] = true
			}
		}
		info.Close()
		tables[name] = cols
	}
	return tables, nil
}

// importDBTime reads a SQLite time column: milliseconds, seconds or text.
func importDBTime(v any) time.Time {
	switch v := v.(type) {
	case int64:
		return importEpochTime(float64(v)).time
	case float64:
		return importEpochTime(v).time
	case string:
		return importTime(v).time
	case []byte:
		return importTime(string(v)).time
	}
	return time.Time{}
}

// importDBText reads a SQLite text column.
func importDBText(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	}
	return ""
}

// importDBJSON reads a JSON column into a map.
func importDBJSON(v any) map[string]any {
	text := importDBText(v)
	if strings.TrimSpace(text) == "" {
		return nil
	}
	var out map[string]any
	if json.Unmarshal([]byte(text), &out) != nil {
		return nil
	}
	return out
}

// shortSize names a size the way a person reads it.
func shortSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.0f MB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
}

// dbSessionPath names one session in a database: the file, then its id.
func dbSessionPath(db, id string) string { return db + "#" + id }

// splitDBSession reads what dbSessionPath wrote.
func splitDBSession(path string) (string, string) {
	i := strings.LastIndex(path, "#")
	if i < 0 {
		return path, ""
	}
	return path[:i], path[i+1:]
}

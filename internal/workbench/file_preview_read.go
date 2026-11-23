//go:build !js && !android && !ios

package workbench

// Reading a file for its preview: everything here runs off the UI thread and
// returns what the dialog shows, with a reason when it cannot.

import (
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/officedoc"
)

// What a preview reads, and refuses past it: a table keeps a thousand rows
// and forty-eight columns, prose a couple of megabytes, and a document
// archive more, since its parts are read from it.
const (
	csvPreviewRows   = 1000
	csvPreviewCols   = 48
	textPreviewBytes = 2 << 20
	docPreviewBytes  = 16 << 20
	// docPreviewChars bounds the words a document preview lays out.
	docPreviewChars = 200_000
)

// readFilePreview reads what the kind shows about a file.
func readFilePreview(path, kind string) (filePreview, error) {
	p := filePreview{path: path, kind: kind}
	info, err := os.Stat(path)
	if err != nil {
		return p, err
	}
	if !info.Mode().IsRegular() {
		return p, errors.New(apptext.T("找不到这个文件"))
	}
	p.size, p.modified = info.Size(), info.ModTime()
	switch kind {
	case previewTable:
		p.rows, p.columns, p.limited, err = readTablePreview(path)
	case previewXLSX:
		p.rows, p.columns, p.limited, err = readXLSXPreview(path)
	case previewDocx:
		p.text, p.limited, err = readDocxPreview(path)
	case previewMarkdown, previewHTML:
		p.text, err = readTextPreview(path)
	}
	return p, err
}

// readTablePreview reads a delimited text file into cells.
func readTablePreview(path string) ([][]string, int, bool, error) {
	data, err := readPreviewBytes(path, textPreviewBytes)
	if err != nil {
		return nil, 0, false, previewReadError(err, apptext.T("表格预览最多读取 2 MB。"))
	}
	if !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
		return nil, 0, false, errors.New(apptext.T("请选择 UTF-8 编码的表格。"))
	}
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
	if strings.EqualFold(fileExt(path), ".tsv") {
		r.Comma = '\t'
	}
	r.FieldsPerRecord = -1
	var rows [][]string
	columns, limited := 0, false
	for {
		row, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, 0, false, err
		}
		if len(rows) >= csvPreviewRows {
			limited = true
			break
		}
		if len(row) > csvPreviewCols {
			limited = true
			row = row[:csvPreviewCols]
		}
		columns = max(columns, len(row))
		rows = append(rows, row)
	}
	return rows, columns, limited, nil
}

// readXLSXPreview reads the first worksheet of a workbook into cells.
func readXLSXPreview(path string) ([][]string, int, bool, error) {
	data, err := readPreviewBytes(path, docPreviewBytes)
	if err != nil {
		return nil, 0, false, previewReadError(err, apptext.T("文档预览最多读取 16 MB。"))
	}
	sheet, err := officedoc.XlsxSheet(data, csvPreviewRows, csvPreviewCols)
	if err != nil {
		return nil, 0, false, errors.New(apptext.T("这个表格打不开：可能不是 .xlsx，或者文件已损坏。"))
	}
	return sheet.Rows, sheet.Columns, sheet.Limited, nil
}

// readDocxPreview reads a Word document's words, and says whether it had to
// stop at the preview's share of them.
func readDocxPreview(path string) (string, bool, error) {
	data, err := readPreviewBytes(path, docPreviewBytes)
	if err != nil {
		return "", false, previewReadError(err, apptext.T("文档预览最多读取 16 MB。"))
	}
	text, err := officedoc.DocxText(data)
	if err != nil {
		return "", false, errors.New(apptext.T("这个文档打不开：可能不是 .docx，或者文件已损坏。"))
	}
	if len(text) > docPreviewChars {
		return clipText(text, docPreviewChars), true, nil
	}
	return text, false, nil
}

// clipText shortens s to limit bytes, backing up to a character boundary.
func clipText(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit]
}

// readTextPreview reads prose as UTF-8.
func readTextPreview(path string) (string, error) {
	data, err := readPreviewBytes(path, textPreviewBytes)
	if err != nil {
		return "", previewReadError(err, apptext.T("文本预览最多读取 2 MB。"))
	}
	if !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
		return "", errors.New(apptext.T("这个文件不是 UTF-8 文本，暂时无法预览。"))
	}
	return string(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))), nil
}

// readPreviewBytes reads a file's first bytes, refusing one past limit.
func readPreviewBytes(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errFileTooLarge
	}
	return data, nil
}

// previewReadError says why a preview could not read its file, with what the
// preview itself limits rather than the editor's words.
func previewReadError(err error, tooLarge string) error {
	if errors.Is(err, errFileTooLarge) {
		return errors.New(tooLarge)
	}
	return err
}

// fileExt is a path's extension in lower case.
func fileExt(path string) string {
	if at := strings.LastIndexByte(path, '.'); at >= 0 {
		return strings.ToLower(path[at:])
	}
	return ""
}

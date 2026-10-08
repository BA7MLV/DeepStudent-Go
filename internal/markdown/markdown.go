// Package markdown contains the small, streaming Markdown boundary used by
// the native MyGo shell.  It deliberately has no HTML or JavaScript output:
// callers receive typed blocks and render them with native controls.
package markdown

import (
	"bufio"
	"bytes"
	"strings"
)

// Kind identifies a block emitted by Parser.
type Kind string

const (
	Paragraph Kind = "paragraph"
	Heading   Kind = "heading"
	Code      Kind = "code"
	Table     Kind = "table"
	List      Kind = "list"
	Quote     Kind = "quote"
	Rule      Kind = "rule"
)

// Node is a complete Markdown block. Text is used by prose/list/quote blocks;
// Code and Table carry their own structured fields. A node is emitted only
// once its block is complete, making it safe to render while an LLM is still
// streaming a response.
type Node struct {
	Kind      Kind
	Level     int
	Text      string
	Language  string
	Code      string
	Lines     []string
	Headers   []string
	Rows      [][]string
	Alignment []Alignment
	Tokens    []Token
}

// Alignment is the optional Markdown table column alignment.
type Alignment uint8

const (
	AlignNone Alignment = iota
	AlignLeft
	AlignCenter
	AlignRight
)

// Token is a syntax-highlighted fragment. Kind is intentionally generic so a
// native renderer can map it to its own palette without HTML/CSS assumptions.
type Token struct {
	Text string
	Kind string
}

// Parser incrementally parses UTF-8 Markdown chunks. Feed may be called with
// arbitrary boundaries (including in the middle of a UTF-8 byte sequence); the
// parser keeps the incomplete final line until the next call. Flush emits the
// final unterminated block.
type Parser struct {
	line []byte
	block []string
	fence string
	language string
	code []string
}

// NewParser creates a parser with no pending blocks.
func NewParser() *Parser { return &Parser{} }

// Snapshot returns the blocks that would be emitted if the current stream
// ended now, without mutating the parser. It is useful for rendering a
// still-open paragraph or code fence while waiting for the next SSE delta.
func (p *Parser) Snapshot() []Node {
	clone := *p
	clone.line = append([]byte(nil), p.line...)
	clone.block = append([]string(nil), p.block...)
	clone.code = append([]string(nil), p.code...)
	return clone.Flush()
}

// Feed consumes a chunk and returns blocks that became complete during this
// call. Newline handling accepts LF and CRLF documents.
func (p *Parser) Feed(chunk []byte) []Node {
	p.line = append(p.line, chunk...)
	var out []Node
	for {
		i := bytes.IndexByte(p.line, '\n')
		if i < 0 { break }
		line := strings.TrimSuffix(string(p.line[:i]), "\r")
		p.line = p.line[i+1:]
		out = append(out, p.lineComplete(line)...)
	}
	return out
}

// Flush completes a final line without a newline and emits any pending block.
func (p *Parser) Flush() []Node {
	var out []Node
	if len(p.line) > 0 {
		out = append(out, p.lineComplete(string(p.line))...)
		p.line = nil
	}
	if p.fence != "" {
		out = append(out, p.finishCode())
	} else {
		out = append(out, p.finishBlock()...)
	}
	return out
}

func (p *Parser) lineComplete(line string) []Node {
	if p.fence != "" {
		if strings.HasPrefix(strings.TrimSpace(line), p.fence) {
			return []Node{p.finishCode()}
		}
		p.code = append(p.code, line)
		return nil
	}
	trim := strings.TrimSpace(line)
	if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
		out := p.finishBlock()
		p.fence = trim[:3]
		p.language = strings.TrimSpace(strings.TrimPrefix(trim[3:], "{"))
		p.language = strings.TrimSuffix(p.language, "}")
		p.code = nil
		return out
	}
	if trim == "" {
		return p.finishBlock()
	}
	// Once a table header and separator have been seen, a non-pipe line starts
	// the next block. Flush the table before recursively processing that line;
	// otherwise the line would be silently ignored as a malformed table row.
	if len(p.block) >= 2 && isPipeLine(p.block[0]) && isTableSeparator(p.block[1]) && !isPipeLine(line) {
		out := p.finishBlock()
		return append(out, p.lineComplete(line)...)
	}
	// Headings and thematic rules delimit prose immediately, so the native
	// surface can show them before the provider finishes the next paragraph.
	if level, text, ok := heading(line); ok {
		out := p.finishBlock()
		return append(out, Node{Kind: Heading, Level: level, Text: text, Tokens: HighlightInline(text)} )
	}
	if isRule(trim) {
		out := p.finishBlock()
		return append(out, Node{Kind: Rule})
	}
	p.block = append(p.block, line)
	// A list or quote ends when a new ordinary line starts. Keep same-family
	// lines together, but flush before the next paragraph.
	if len(p.block) > 1 && isListLine(p.block[0]) && !isListLine(line) {
		last := p.block[len(p.block)-1]
		p.block = p.block[:len(p.block)-1]
		out := p.finishBlock()
		p.block = append(p.block, last)
		return out
	}
	if len(p.block) > 1 && isQuoteLine(p.block[0]) && !isQuoteLine(line) {
		last := p.block[len(p.block)-1]
		p.block = p.block[:len(p.block)-1]
		out := p.finishBlock()
		p.block = append(p.block, last)
		return out
	}
	return nil
}

func (p *Parser) finishCode() Node {
	n := Node{Kind: Code, Language: strings.TrimSpace(p.language), Code: strings.Join(p.code, "\n")}
	n.Lines = append([]string(nil), p.code...)
	n.Tokens = Highlight(n.Code, n.Language)
	p.fence, p.language, p.code = "", "", nil
	return n
}

func (p *Parser) finishBlock() []Node {
	if len(p.block) == 0 { return nil }
	lines := append([]string(nil), p.block...)
	p.block = nil
	if len(lines) >= 2 && isTableSeparator(lines[1]) && isPipeLine(lines[0]) {
		headers := splitTableRow(lines[0])
		align := tableAlignment(lines[1])
		rows := make([][]string, 0, len(lines)-2)
		for _, line := range lines[2:] {
			if isPipeLine(line) { rows = append(rows, splitTableRow(line)) }
		}
		return []Node{{Kind: Table, Headers: headers, Rows: rows, Alignment: align}}
	}
	if isListLine(lines[0]) {
		parts := make([]string, 0, len(lines))
		for _, line := range lines { parts = append(parts, strings.TrimSpace(stripListMarker(line))) }
		return []Node{{Kind: List, Lines: parts}}
	}
	if isQuoteLine(lines[0]) {
		parts := make([]string, 0, len(lines))
		for _, line := range lines { parts = append(parts, strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), ">"))) }
		return []Node{{Kind: Quote, Text: strings.Join(parts, "\n"), Tokens: HighlightInline(strings.Join(parts, "\n"))}}
	}
	return []Node{{Kind: Paragraph, Text: strings.Join(lines, "\n"), Tokens: HighlightInline(strings.Join(lines, "\n"))}}
}

func heading(line string) (int, string, bool) {
	trim := strings.TrimSpace(line)
	i := 0
	for i < len(trim) && trim[i] == '#' { i++ }
	if i == 0 || i > 6 || i >= len(trim) || trim[i] != ' ' { return 0, "", false }
	return i, strings.TrimSpace(trim[i+1:]), true
}
func isRule(s string) bool {
	if len(s) < 3 { return false }
	first := s[0]
	if first != '-' && first != '*' && first != '_' { return false }
	for _, c := range s { if c != rune(first) && c != ' ' { return false } }
	return true
}
func isListLine(s string) bool {
	t := strings.TrimSpace(s)
	if len(t) < 2 { return false }
	if t[0] == '-' || t[0] == '*' || t[0] == '+' { return t[1] == ' ' }
	for i := 0; i < len(t) && t[i] >= '0' && t[i] <= '9'; i++ { if i+1 < len(t) && t[i+1] == '.' { return strings.HasPrefix(t[i+2:], " ") } }
	return false
}
func isQuoteLine(s string) bool { return strings.HasPrefix(strings.TrimSpace(s), ">") }
func stripListMarker(s string) string {
	t := strings.TrimSpace(s)
	if len(t) >= 2 && (t[0] == '-' || t[0] == '*' || t[0] == '+') && t[1] == ' ' { return t[2:] }
	for i := 0; i < len(t) && t[i] >= '0' && t[i] <= '9'; i++ { if i+1 < len(t) && t[i+1] == '.' { return strings.TrimSpace(t[i+2:]) } }
	return t
}
func isPipeLine(s string) bool { return strings.Contains(s, "|") }
func isTableSeparator(s string) bool {
	cells := splitTableRow(s)
	if len(cells) == 0 { return false }
	for _, cell := range cells {
		cell = strings.TrimSpace(cell)
		if len(cell) < 3 { return false }
		if strings.HasPrefix(cell, ":") { cell = cell[1:] }
		if strings.HasSuffix(cell, ":") { cell = cell[:len(cell)-1] }
		if strings.Trim(cell, "-") != "" { return false }
	}
	return true
}
func splitTableRow(s string) []string {
	t := strings.TrimSpace(s)
	if strings.HasPrefix(t, "|") { t = t[1:] }
	if strings.HasSuffix(t, "|") { t = t[:len(t)-1] }
	cells := strings.Split(t, "|")
	for i := range cells { cells[i] = strings.TrimSpace(cells[i]) }
	return cells
}
func tableAlignment(s string) []Alignment {
	align := make([]Alignment, len(splitTableRow(s)))
	for i, cell := range splitTableRow(s) {
		cell = strings.TrimSpace(cell)
		left, right := strings.HasPrefix(cell, ":"), strings.HasSuffix(cell, ":")
		if left && right { align[i] = AlignCenter } else if right { align[i] = AlignRight } else if left { align[i] = AlignLeft }
	}
	return align
}

// Parse parses a complete document by using the same incremental path as the
// streaming adapter.
func Parse(input string) []Node {
	p := NewParser()
	out := p.Feed([]byte(input))
	return append(out, p.Flush()...)
}

// Scanner is a convenience bridge for io.Reader streams (for example a
// provider response that has already been decoded from SSE).
func Scanner(r *bufio.Scanner) []Node {
	p := NewParser()
	var out []Node
	for r.Scan() { out = append(out, p.Feed(append(r.Bytes(), '\n'))...) }
	return append(out, p.Flush()...)
}

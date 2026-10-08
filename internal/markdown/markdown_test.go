package markdown

import "testing"

func TestParseBlocks(t *testing.T) {
	nodes := Parse("# Title\n\nA `word`.\n\n```go\nfunc main() {}\n```\n\n| A | B |\n| :- | -: |\n| 1 | 2 |\n")
	if len(nodes) != 4 { t.Fatalf("nodes = %d, want 4: %#v", len(nodes), nodes) }
	if nodes[0].Kind != Heading || nodes[0].Level != 1 || nodes[0].Text != "Title" { t.Fatalf("heading = %#v", nodes[0]) }
	if nodes[1].Kind != Paragraph || len(nodes[1].Tokens) != 3 { t.Fatalf("paragraph = %#v", nodes[1]) }
	if nodes[2].Kind != Code || nodes[2].Language != "go" || len(nodes[2].Lines) != 1 { t.Fatalf("code = %#v", nodes[2]) }
	if nodes[3].Kind != Table || len(nodes[3].Headers) != 2 || len(nodes[3].Rows) != 1 || nodes[3].Alignment[1] != AlignRight { t.Fatalf("table = %#v", nodes[3]) }
}

func TestStreamingBoundaries(t *testing.T) {
	p := NewParser()
	var nodes []Node
	nodes = append(nodes, p.Feed([]byte("hello\n\n```py\nprint('"))...)
	if len(nodes) != 1 || nodes[0].Kind != Paragraph { t.Fatalf("first feed = %#v", nodes) }
	nodes = append(nodes, p.Feed([]byte("x')\n```\n"))...)
	nodes = append(nodes, p.Flush()...)
	if len(nodes) != 2 || nodes[1].Kind != Code || nodes[1].Language != "py" { t.Fatalf("stream = %#v", nodes) }
}

func TestHighlight(t *testing.T) {
	tokens := Highlight("func main() { return 42 // ok\n}", "go")
	var haveKeyword, haveNumber, haveComment bool
	for _, token := range tokens { if token.Kind == "keyword" { haveKeyword = true }; if token.Kind == "number" { haveNumber = true }; if token.Kind == "comment" { haveComment = true } }
	if !haveKeyword || !haveNumber || !haveComment { t.Fatalf("tokens = %#v", tokens) }
}

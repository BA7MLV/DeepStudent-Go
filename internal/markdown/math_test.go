package markdown

import "testing"

func TestParseMathCommonConstructs(t *testing.T) {
	formula := ParseMath(`\frac{a_1+b^2}{\sqrt{x}}`, true)
	if !formula.Valid || formula.Expr == nil || formula.Expr.Kind != MathFraction {
		t.Fatalf("fraction = %#v", formula)
	}
	if formula.Expr.Children[0].Kind != MathSequence || formula.Expr.Children[1].Kind != MathSqrt {
		t.Fatalf("fraction children = %#v", formula.Expr.Children)
	}
	greek := ParseMath("α + β", false)
	if !greek.Valid || greek.Expr.Kind != MathSequence || greek.Expr.Children[0].Text != "α" {
		t.Fatalf("unicode math = %#v", greek.Expr)
	}
	matrix := ParseMath(`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, true)
	if !matrix.Valid || matrix.Expr.Kind != MathMatrix || len(matrix.Expr.Rows) != 2 || len(matrix.Expr.Rows[0]) != 2 {
		t.Fatalf("matrix = %#v", matrix)
	}
}

func TestParseMathInlineAndEscapes(t *testing.T) {
	inlines := ParseInlines("speed $v^2$ and `code $x$`, cost \\$5")
	if len(inlines) != 3 || inlines[1].Math == nil || inlines[0].Text != "speed " || inlines[2].Math != nil {
		t.Fatalf("inlines = %#v", inlines)
	}
	if got := ParseInlines("cost $5 and $10"); len(got) != 1 || got[0].Math != nil {
		t.Fatalf("currency was parsed as math: %#v", got)
	}
}

func TestMathStreamingBlocks(t *testing.T) {
	p := NewParser()
	if got := p.Feed([]byte("before\n\n$$\n\\frac{1}")); len(got) != 1 || got[0].Kind != Paragraph {
		t.Fatalf("open block = %#v", got)
	}
	pending := p.Snapshot()
	if len(pending) != 1 || pending[0].Kind != MathBlock || pending[0].Math == nil {
		t.Fatalf("pending block = %#v", pending)
	}
	got := p.Feed([]byte("{2}\n$$\n"))
	if len(got) != 1 || got[0].Kind != MathBlock || got[0].Text != `\frac{1}{2}` {
		t.Fatalf("closed block = %#v", got)
	}
}

func TestMathInlineBlockNode(t *testing.T) {
	nodes := Parse("Inline $x_1$\n\n$$y=mx+b$$\n")
	if len(nodes) != 2 || len(nodes[0].Inlines) != 2 || nodes[0].Inlines[1].Math == nil {
		t.Fatalf("inline node = %#v", nodes)
	}
	if nodes[1].Kind != MathBlock || nodes[1].Math == nil || nodes[1].Math.Raw != "y=mx+b" {
		t.Fatalf("block node = %#v", nodes)
	}
}

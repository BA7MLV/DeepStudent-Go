package markdown

import (
	"bytes"
	"testing"
)

func TestRenderMathSVGUsesNativePaths(t *testing.T) {
	svg, err := RenderMathSVG(ParseMath(`\frac{a^2+b^2}{\sqrt{c}}`, true), 24)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(svg, []byte("<path")) || bytes.Contains(svg, []byte("<text")) {
		t.Fatalf("SVG is not path-based: %s", svg[:min(len(svg), 200)])
	}
}

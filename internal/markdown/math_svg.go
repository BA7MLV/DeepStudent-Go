package markdown

import (
	"errors"
	"strings"
	"sync"

	texmath "github.com/go-tex/math"
)

var nativeMathRenderer struct {
	once sync.Once
	r    *texmath.Renderer
	err  error
}

func getMathRenderer() (*texmath.Renderer, error) {
	nativeMathRenderer.once.Do(func() {
		nativeMathRenderer.r, nativeMathRenderer.err = texmath.New(texmath.DefaultFont())
	})
	return nativeMathRenderer.r, nativeMathRenderer.err
}

// RenderMathSVG converts a parsed formula into a self-contained SVG consisting
// of glyph paths and rule rectangles. MyGo's native SVG parser intentionally
// omits <text>; go-tex/math's STIX Two Math output therefore keeps formulas
// browser-free while preserving proper fraction, script, root, operator and
// matrix layout. The renderer is cached and safe for concurrent SSE updates.
func RenderMathSVG(formula *MathFormula, sizePx int) ([]byte, error) {
	if formula == nil || strings.TrimSpace(formula.Raw) == "" {
		return nil, errors.New("empty math formula")
	}
	r, err := getMathRenderer()
	if err != nil {
		return nil, err
	}
	if sizePx <= 0 {
		sizePx = 20
	}
	var svg string
	if formula.Display {
		svg, err = r.RenderDisplaySVG(formula.Raw, sizePx)
	} else {
		svg, err = r.RenderSVG(formula.Raw, sizePx)
	}
	if err != nil {
		return nil, err
	}
	return []byte(svg), nil
}

package markdown

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// MathKind identifies a node in the small, dependency-free TeX expression AST.
// The parser intentionally accepts a useful subset of TeX rather than
// executing or evaluating input. Unknown commands are preserved as text.
type MathKind string

const (
	MathText     MathKind = "text"
	MathSequence MathKind = "sequence"
	MathFraction MathKind = "fraction"
	MathSqrt     MathKind = "sqrt"
	MathScript   MathKind = "script"
	MathOperator MathKind = "operator"
	MathMatrix   MathKind = "matrix"
)

// MathExpr is a safe AST for a mathematical expression. Children hold a
// sequence or a fraction/square-root payload; Sup and Sub are used by scripts.
type MathExpr struct {
	Kind     MathKind
	Text     string
	Children []*MathExpr
	Sup      *MathExpr
	Sub      *MathExpr
	Rows     [][]*MathExpr
	Left     string
	Right    string
}

// MathFormula is attached to Markdown nodes and inline spans. Raw always
// retains the source so unsupported or incomplete input has a readable native
// fallback while Expr carries the parsed subset.
type MathFormula struct {
	Raw     string
	Display bool
	Expr    *MathExpr
	Valid   bool
}

// InlineNode is either ordinary Markdown text or one inline $...$ formula.
type InlineNode struct {
	Text string
	Math *MathFormula
}

// ParseMath parses a TeX-like expression without evaluating it. It supports
// grouped expressions, fractions, roots, scripts, common operators, and the
// matrix environments matrix/pmatrix/bmatrix. Parsing is deliberately
// forgiving: malformed groups are retained as MathText and Valid is false.
func ParseMath(raw string, display bool) *MathFormula {
	p := mathParser{src: strings.TrimSpace(raw)}
	expr := p.parseSequence(0)
	p.skipSpace()
	valid := !p.err && p.pos >= len(p.src)
	if expr == nil {
		expr = &MathExpr{Kind: MathText, Text: strings.TrimSpace(raw)}
	}
	return &MathFormula{Raw: raw, Display: display, Expr: expr, Valid: valid}
}

// ParseInlines splits ordinary prose from inline $...$ formulas. Escaped
// dollars and code spans remain ordinary text. A missing closing delimiter is
// left as text, so snapshots during SSE streaming never lose user content.
func ParseInlines(text string) []InlineNode {
	var out []InlineNode
	flush := func(value string) {
		if value != "" {
			out = append(out, InlineNode{Text: value})
		}
	}
	start := 0
	for i := 0; i < len(text); {
		if text[i] == '`' {
			j := i + 1
			for j < len(text) {
				if text[j] == '`' && text[j-1] != '\\' {
					j++
					break
				}
				j++
			}
			if j > len(text) {
				j = len(text)
			}
			i = j
			continue
		}
		if text[i] != '$' || escapedAt(text, i) || (i+1 < len(text) && text[i+1] == '$') {
			i++
			continue
		}
		j := i + 1
		for j < len(text) {
			if text[j] == '$' && !escapedAt(text, j) && (j+1 >= len(text) || text[j+1] != '$') {
				// Like CommonMark math extensions, reject a delimiter preceded
				// by whitespace. This keeps currency such as "$5 and $10"
				// ordinary text while accepting punctuation after a formula.
				if j > i+1 && !unicode.IsSpace(rune(text[j-1])) {
					break
				}
			}
			j++
		}
		if j >= len(text) || strings.TrimSpace(text[i+1:j]) == "" {
			i++
			continue
		}
		// A dollar immediately followed by whitespace is normally currency,
		// not a TeX delimiter. Closing delimiters may be followed by punctuation.
		if i+1 < len(text) && unicode.IsSpace(rune(text[i+1])) {
			i++
			continue
		}
		flush(text[start:i])
		out = append(out, InlineNode{Math: ParseMath(text[i+1:j], false)})
		i = j + 1
		start = i
	}
	flush(text[start:])
	return out
}

func escapedAt(s string, index int) bool {
	n := 0
	for index > 0 && s[index-1] == '\\' {
		n++
		index--
	}
	return n%2 == 1
}

type mathParser struct {
	src string
	pos int
	err bool
}

func (p *mathParser) skipSpace() {
	for p.pos < len(p.src) && unicode.IsSpace(rune(p.src[p.pos])) {
		p.pos++
	}
}

func (p *mathParser) parseSequence(stop byte) *MathExpr {
	items := make([]*MathExpr, 0, 4)
	for p.pos < len(p.src) {
		p.skipSpace()
		if p.pos >= len(p.src) {
			break
		}
		if stop != 0 && p.src[p.pos] == stop {
			p.pos++
			break
		}
		if p.src[p.pos] == '}' && stop != '}' {
			p.err = true
			p.pos++
			break
		}
		if p.src[p.pos] == '&' || (p.src[p.pos] == '\\' && p.pos+1 < len(p.src) && p.src[p.pos+1] == '\\') {
			break
		}
		atom := p.parseAtom()
		if atom == nil {
			break
		}
		for p.pos < len(p.src) {
			p.skipSpace()
			if p.pos >= len(p.src) || (p.src[p.pos] != '^' && p.src[p.pos] != '_') {
				break
			}
			marker := p.src[p.pos]
			p.pos++
			p.skipSpace()
			var script *MathExpr
			if p.pos < len(p.src) && p.src[p.pos] == '{' {
				p.pos++
				script = p.parseSequence('}')
			} else {
				script = p.parseAtom()
			}
			if script == nil {
				p.err = true
				script = &MathExpr{Kind: MathText, Text: "?"}
			}
			if atom.Kind == MathScript {
				if marker == '^' {
					atom.Sup = script
				} else {
					atom.Sub = script
				}
			} else {
				wrapped := &MathExpr{Kind: MathScript, Children: []*MathExpr{atom}}
				if marker == '^' {
					wrapped.Sup = script
				} else {
					wrapped.Sub = script
				}
				atom = wrapped
			}
		}
		items = append(items, atom)
	}
	if len(items) == 0 {
		return &MathExpr{Kind: MathText, Text: ""}
	}
	if len(items) == 1 {
		return items[0]
	}
	return &MathExpr{Kind: MathSequence, Children: items}
}

func (p *mathParser) parseAtom() *MathExpr {
	p.skipSpace()
	if p.pos >= len(p.src) {
		return nil
	}
	if p.src[p.pos] == '{' {
		p.pos++
		return p.parseSequence('}')
	}
	if p.src[p.pos] == '}' {
		p.err = true
		p.pos++
		return &MathExpr{Kind: MathText, Text: "}"}
	}
	if p.src[p.pos] == '\\' {
		p.pos++
		start := p.pos
		for p.pos < len(p.src) && unicode.IsLetter(rune(p.src[p.pos])) {
			p.pos++
		}
		if start == p.pos && p.pos < len(p.src) {
			value := string(p.src[p.pos])
			p.pos++
			return &MathExpr{Kind: MathText, Text: value}
		}
		command := p.src[start:p.pos]
		return p.parseCommand(command)
	}
	// Read one UTF-8 rune or a short run of ordinary letters/digits. Keeping
	// punctuation as individual atoms makes script layout predictable.
	r, size := rune(p.src[p.pos]), 1
	if r >= utf8RuneSelf {
		r, size = decodeRuneInMath(p.src[p.pos:])
	}
	p.pos += size
	if unicode.IsLetter(r) || unicode.IsDigit(r) {
		start := p.pos - size
		for p.pos < len(p.src) {
			next, n := decodeRuneInMath(p.src[p.pos:])
			if !unicode.IsLetter(next) && !unicode.IsDigit(next) {
				break
			}
			p.pos += n
		}
		return &MathExpr{Kind: MathText, Text: p.src[start:p.pos]}
	}
	return &MathExpr{Kind: MathText, Text: string(r)}
}

const utf8RuneSelf = 0x80

func decodeRuneInMath(s string) (rune, int) {
	r, n := utf8.DecodeRuneInString(s)
	if r == utf8.RuneError && n == 0 {
		return rune(s[0]), 1
	}
	return r, n
}

func (p *mathParser) parseCommand(command string) *MathExpr {
	switch command {
	case "frac", "dfrac", "tfrac":
		num := p.parseRequiredGroup()
		den := p.parseRequiredGroup()
		if num == nil || den == nil {
			p.err = true
			return &MathExpr{Kind: MathText, Text: "\\" + command}
		}
		return &MathExpr{Kind: MathFraction, Children: []*MathExpr{num, den}}
	case "sqrt":
		p.skipSpace()
		// Optional root index, e.g. \sqrt[3]{x}; retain it as a script.
		var index *MathExpr
		if p.pos < len(p.src) && p.src[p.pos] == '[' {
			p.pos++
			start := p.pos
			for p.pos < len(p.src) && p.src[p.pos] != ']' {
				p.pos++
			}
			index = ParseMath(p.src[start:p.pos], false).Expr
			if p.pos < len(p.src) {
				p.pos++
			} else {
				p.err = true
			}
		}
		rad := p.parseRequiredGroup()
		if rad == nil {
			p.err = true
			return &MathExpr{Kind: MathOperator, Text: "√"}
		}
		root := &MathExpr{Kind: MathSqrt, Children: []*MathExpr{rad}}
		if index != nil {
			root.Sup = index
		}
		return root
	case "left", "right":
		p.skipSpace()
		if p.pos < len(p.src) {
			p.pos++
		}
		return p.parseAtom()
	case "begin":
		env := p.parseRequiredRawGroup()
		if env == "matrix" || env == "pmatrix" || env == "bmatrix" || env == "cases" {
			return p.parseMatrix(env)
		}
		p.err = true
		return &MathExpr{Kind: MathText, Text: "\\begin{" + env + "}"}
	case "end":
		p.err = true
		return &MathExpr{Kind: MathText, Text: "\\end"}
	}
	if symbol, ok := mathSymbols[command]; ok {
		return &MathExpr{Kind: MathOperator, Text: symbol}
	}
	// Text-like commands are common in educational answers. Preserve their
	// content while stripping the command itself for a native, readable result.
	if command == "text" || command == "mathrm" || command == "mathbf" || command == "mathit" {
		if value := p.parseRequiredRawGroup(); value != "" {
			return &MathExpr{Kind: MathText, Text: value}
		}
	}
	return &MathExpr{Kind: MathText, Text: "\\" + command}
}

var mathSymbols = map[string]string{
	"alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ϵ", "varepsilon": "ε",
	"zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "varpi": "ϖ", "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "ϕ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
	"Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
	"pm": "±", "mp": "∓", "times": "×", "cdot": "·", "div": "÷", "ast": "∗", "star": "⋆", "circ": "∘", "bullet": "∙",
	"le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "neq": "≠", "ne": "≠", "approx": "≈", "sim": "∼", "equiv": "≡", "cong": "≅", "to": "→", "rightarrow": "→", "leftarrow": "←", "leftrightarrow": "↔", "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔",
	"in": "∈", "notin": "∉", "subset": "⊂", "subseteq": "⊆", "supset": "⊃", "supseteq": "⊇", "cup": "∪", "cap": "∩", "setminus": "\\", "emptyset": "∅",
	"infty": "∞", "partial": "∂", "nabla": "∇", "forall": "∀", "exists": "∃", "neg": "¬", "land": "∧", "lor": "∨", "sum": "∑", "prod": "∏", "int": "∫", "oint": "∮", "lim": "lim", "log": "log", "ln": "ln", "sin": "sin", "cos": "cos", "tan": "tan", "max": "max", "min": "min",
	"langle": "⟨", "rangle": "⟩", "lceil": "⌈", "rceil": "⌉", "lfloor": "⌊", "rfloor": "⌋", "dots": "…", "ldots": "…", "cdots": "⋯",
}

func (p *mathParser) parseRequiredGroup() *MathExpr {
	p.skipSpace()
	if p.pos >= len(p.src) {
		return nil
	}
	if p.src[p.pos] == '{' {
		p.pos++
		return p.parseSequence('}')
	}
	return p.parseAtom()
}

func (p *mathParser) parseRequiredRawGroup() string {
	p.skipSpace()
	if p.pos >= len(p.src) || p.src[p.pos] != '{' {
		return ""
	}
	p.pos++
	start := p.pos
	depth := 1
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				value := p.src[start:p.pos]
				p.pos++
				return value
			}
		}
		p.pos++
	}
	p.err = true
	return p.src[start:]
}

func (p *mathParser) parseMatrix(env string) *MathExpr {
	var rows [][]*MathExpr
	var row []*MathExpr
	for p.pos < len(p.src) {
		p.skipSpace()
		if strings.HasPrefix(p.src[p.pos:], "\\end") {
			p.pos += len("\\end")
			_ = p.parseRequiredRawGroup()
			break
		}
		cellStart := p.pos
		depth := 0
		for p.pos < len(p.src) {
			if p.src[p.pos] == '{' {
				depth++
			} else if p.src[p.pos] == '}' && depth > 0 {
				depth--
			} else if depth == 0 && p.src[p.pos] == '&' {
				break
			} else if depth == 0 && strings.HasPrefix(p.src[p.pos:], "\\\\") {
				break
			} else if depth == 0 && strings.HasPrefix(p.src[p.pos:], "\\end") {
				break
			}
			p.pos++
		}
		cellRaw := strings.TrimSpace(p.src[cellStart:p.pos])
		row = append(row, ParseMath(cellRaw, false).Expr)
		if p.pos >= len(p.src) {
			break
		}
		if p.src[p.pos] == '&' {
			p.pos++
			continue
		}
		if strings.HasPrefix(p.src[p.pos:], "\\\\") {
			p.pos += 2
			rows = append(rows, row)
			row = nil
			continue
		}
		if strings.HasPrefix(p.src[p.pos:], "\\end") {
			p.pos += len("\\end")
			_ = p.parseRequiredRawGroup()
			break
		}
	}
	if len(row) > 0 {
		rows = append(rows, row)
	}
	left, right := "", ""
	switch env {
	case "pmatrix":
		left, right = "(", ")"
	case "bmatrix":
		left, right = "[", "]"
	case "cases":
		left, right = "{", ""
	}
	return &MathExpr{Kind: MathMatrix, Rows: rows, Left: left, Right: right}
}

package markdown

import (
	"strings"
	"unicode"
)

var keywords = map[string]map[string]struct{}{
	"go": set("break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var", "true", "false", "nil"),
	"rust": set("as", "async", "await", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "dyn"),
	"python": set("and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "match", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"),
	"javascript": set("as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "else", "export", "extends", "false", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "let", "new", "null", "of", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield"),
	"typescript": set("as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "else", "export", "extends", "false", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "interface", "keyof", "let", "namespace", "new", "null", "number", "of", "private", "protected", "public", "readonly", "return", "static", "string", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "with", "yield"),
	"sql": set("select", "from", "where", "and", "or", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "drop", "join", "left", "right", "inner", "outer", "on", "as", "group", "by", "order", "limit", "null", "not", "primary", "key", "true", "false"),
}

func set(values ...string) map[string]struct{} { out := make(map[string]struct{}, len(values)); for _, value := range values { out[value] = struct{}{} }; return out }

// Highlight tokenizes source with a conservative, dependency-free lexer. It
// is presentation data only; it does not execute or parse code. The native
// renderer can map token kinds keyword/string/number/comment/operator/name to
// its built-in text colors.
func Highlight(source, language string) []Token {
	lang := strings.ToLower(strings.TrimSpace(language))
	if lang == "golang" { lang = "go" }
	if lang == "py" { lang = "python" }
	if lang == "js" { lang = "javascript" }
	if lang == "ts" { lang = "typescript" }
	words := keywords[lang]
	var out []Token
	for i := 0; i < len(source); {
		start := i
		c := source[i]
		if c == '\n' { out = append(out, Token{Text: "\n", Kind: "newline"}); i++; continue }
		if c == ' ' || c == '\t' || c == '\r' { for i < len(source) && (source[i] == ' ' || source[i] == '\t' || source[i] == '\r') { i++ }; out = append(out, Token{Text: source[start:i], Kind: "whitespace"}); continue }
		if c == '/' && i+1 < len(source) && source[i+1] == '/' { i += 2; for i < len(source) && source[i] != '\n' { i++ }; out = append(out, Token{Text: source[start:i], Kind: "comment"}); continue }
		if c == '#' && (lang == "python" || lang == "shell" || lang == "bash") { for i < len(source) && source[i] != '\n' { i++ }; out = append(out, Token{Text: source[start:i], Kind: "comment"}); continue }
		if c == '-' && i+1 < len(source) && source[i+1] == '-' && lang == "sql" { i += 2; for i < len(source) && source[i] != '\n' { i++ }; out = append(out, Token{Text: source[start:i], Kind: "comment"}); continue }
		if c == '/' && i+1 < len(source) && source[i+1] == '*' { i += 2; for i+1 < len(source) && !(source[i] == '*' && source[i+1] == '/') { i++ }; if i+1 < len(source) { i += 2 }; out = append(out, Token{Text: source[start:i], Kind: "comment"}); continue }
		if c == '"' || c == '\'' || c == '`' { quote := c; i++; for i < len(source) { if source[i] == '\\' { i += 2; continue }; if source[i] == quote { i++; break }; i++ }; out = append(out, Token{Text: source[start:i], Kind: "string"}); continue }
		if unicode.IsDigit(rune(c)) { i++; for i < len(source) && (unicode.IsDigit(rune(source[i])) || source[i] == '.' || source[i] == '_') { i++ }; out = append(out, Token{Text: source[start:i], Kind: "number"}); continue }
		if unicode.IsLetter(rune(c)) || c == '_' { i++; for i < len(source) && (unicode.IsLetter(rune(source[i])) || unicode.IsDigit(rune(source[i])) || source[i] == '_') { i++ }; word := source[start:i]; kind := "name"; if _, ok := words[word]; ok { kind = "keyword" }; out = append(out, Token{Text: word, Kind: kind}); continue }
		i++
		kind := "operator"
		if strings.ContainsRune("()[]{}.,:;", rune(c)) { kind = "punctuation" }
		out = append(out, Token{Text: source[start:i], Kind: kind})
	}
	return out
}

// HighlightInline retains prose as a single token except for inline code and
// strong/emphasis markers. It intentionally avoids HTML and leaves escaping to
// MyGo native controls.
func HighlightInline(text string) []Token {
	var out []Token
	for len(text) > 0 {
		i := strings.IndexByte(text, '`')
		if i < 0 { if text != "" { out = append(out, Token{Text: text, Kind: "text"}) }; break }
		if i > 0 { out = append(out, Token{Text: text[:i], Kind: "text"}) }
		text = text[i+1:]
		j := strings.IndexByte(text, '`')
		if j < 0 { out = append(out, Token{Text: "`" + text, Kind: "text"}); break }
		out = append(out, Token{Text: text[:j], Kind: "inline-code"})
		text = text[j+1:]
	}
	return out
}

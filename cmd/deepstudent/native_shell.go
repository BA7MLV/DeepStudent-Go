package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/markdown"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// nativeShell owns the small, native-first desktop shell. The HTTP/SSE chat
// runtime is intentionally kept outside this type: chat and resource pages
// can move behind this boundary one at a time without changing serverapp.
//
// In v0.2.11 the native shell is the window's content. It now owns a small
// native chat composer and streamed message list while richer editing,
// attachments, and resource previews remain on the WebView migration seam.
type nativeShell struct {
	selected       string
	settingsTab    string
	sidebarWidth   float32
	dark           bool
	lastRefresh    time.Time
	runtimeHealthy bool
	openChat       func()
	window         *mygo.Window
	apiBaseURL     string
	sessionID      string
	invalidate     func()
	draft          string
	sending        bool
	activeRunID    string
	activeCancel   context.CancelFunc
	pendingInput   string
	attachmentBusy bool
	attachmentNote string
	onboardingOpen bool
	onboardingStep int
	onboarding      [4]string
	messages       []nativeMessage
	messagesList   ui.ListState
	mu             sync.Mutex
}

type nativeMessage struct {
	role    string
	content string
	id      string
	nodes   []markdown.Node
	pending []markdown.Node
	parser  *markdown.Parser
}

type nativeRunStart struct {
	RunID     string `json:"run_id"`
	EventsURL string `json:"events_url"`
}

type nativeRunEvent struct {
	Type         string `json:"type"`
	Delta        string `json:"delta"`
	Text         string `json:"text"`
	ErrorMessage string `json:"error_message"`
	Done         bool   `json:"done"`
}

type nativeSession struct {
	ID string `json:"id"`
}

type nativeMessageRecord struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	Content string `json:"content"`
}

func newNativeShell(apiBaseURL string) *nativeShell {
	welcome := newNativeMessage("assistant", "你好，我是 DeepStudent。你可以直接在这里开始一个学习对话。")
	return &nativeShell{
		selected:       "chat",
		settingsTab:    "general",
		sidebarWidth:   232,
		lastRefresh:    time.Now(),
		runtimeHealthy: true,
		apiBaseURL:     strings.TrimRight(apiBaseURL, "/"),
		sessionID:      "native-session",
		messagesList:   ui.ListState{FollowEnd: true},
		messages: []nativeMessage{welcome},
	}
}

func newNativeMessage(role, content string) nativeMessage {
	parser := markdown.NewParser()
	completed := parser.Feed([]byte(content))
	return nativeMessage{role: role, content: content, nodes: completed, pending: parser.Snapshot(), parser: parser}
}

// hydrateSession reuses the server's durable session/message contract. A
// failed hydration is deliberately non-fatal: the native shell remains useful
// with its local welcome message while the runtime reconnects.
func (s *nativeShell) hydrateSession() {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	base := strings.TrimRight(s.apiBaseURL, "/")
	var list struct {
		Sessions []nativeSession `json:"sessions"`
	}
	if err := nativeJSONRequest(ctx, http.MethodGet, base+"/api/v1/sessions?limit=1", nil, &list); err != nil {
		return
	}
	if len(list.Sessions) > 0 && strings.TrimSpace(list.Sessions[0].ID) != "" {
		s.mu.Lock()
		s.sessionID = list.Sessions[0].ID
		s.mu.Unlock()
	} else {
		payload, _ := json.Marshal(map[string]string{"id": s.sessionID, "title": "DeepStudent 原生会话"})
		var created struct{ Session nativeSession `json:"session"` }
		if err := nativeJSONRequest(ctx, http.MethodPost, base+"/api/v1/sessions", payload, &created); err == nil && created.Session.ID != "" {
			s.mu.Lock()
			s.sessionID = created.Session.ID
			s.mu.Unlock()
		}
	}
	s.mu.Lock()
	sessionID := s.sessionID
	s.mu.Unlock()
	var messages struct {
		Messages []nativeMessageRecord `json:"messages"`
	}
	messageURL := base + "/api/v1/sessions/" + url.PathEscape(sessionID) + "/messages?limit=200"
	if err := nativeJSONRequest(ctx, http.MethodGet, messageURL, nil, &messages); err != nil || len(messages.Messages) == 0 {
		return
	}
	loaded := make([]nativeMessage, 0, len(messages.Messages))
	for _, message := range messages.Messages {
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		loadedMessage := newNativeMessage(message.Role, message.Content)
		loadedMessage.id = message.ID
		loaded = append(loaded, loadedMessage)
	}
	if len(loaded) == 0 {
		return
	}
	s.mu.Lock()
	s.messages = loaded
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
}

func nativeJSONRequest(ctx context.Context, method, endpoint string, body []byte, result any) error {
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("runtime returned HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(response.Body).Decode(result)
}

func (s *nativeShell) messageSnapshot() []nativeMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	copyMessages := make([]nativeMessage, len(s.messages))
	copy(copyMessages, s.messages)
	return copyMessages
}

func (s *nativeShell) sendingState() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sending
}

func (s *nativeShell) attachmentState() (busy bool, note string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attachmentBusy, s.attachmentNote
}

func (s *nativeShell) setAssistant(index int, text string) {
	s.mu.Lock()
	if index >= 0 && index < len(s.messages) {
		message := &s.messages[index]
		message.content = text
		message.parser = markdown.NewParser()
		message.nodes = message.parser.Feed([]byte(text))
		message.pending = message.parser.Snapshot()
	}
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
}

func (s *nativeShell) appendAssistantDelta(index int, delta string) {
	if delta == "" {
		return
	}
	s.mu.Lock()
	if index >= 0 && index < len(s.messages) {
		message := &s.messages[index]
		if message.parser == nil {
			message.parser = markdown.NewParser()
		}
		message.content += delta
		message.nodes = append(message.nodes, message.parser.Feed([]byte(delta))...)
		message.pending = message.parser.Snapshot()
	}
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
}

func (s *nativeShell) finishSend(index int, text string, err error) {
	if err != nil {
		if err == context.Canceled {
			text = "已取消"
		} else {
			text = "请求失败：" + err.Error()
		}
	}
	s.mu.Lock()
	if index >= 0 && index < len(s.messages) {
		message := &s.messages[index]
		message.content = text
		if message.parser != nil {
			message.nodes = append(message.nodes, message.parser.Flush()...)
			message.pending = nil
		} else {
			message.nodes = markdown.Parse(text)
		}
	}
	s.sending = false
	s.activeRunID, s.activeCancel = "", nil
	if err != nil {
		s.runtimeHealthy = false
	}
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
}

func (s *nativeShell) submitDraft() {
	prompt := strings.TrimSpace(s.draft)
	s.mu.Lock()
	if s.sending {
		s.mu.Unlock()
		return
	}
	attachmentRef := strings.TrimSpace(s.pendingInput)
	if prompt == "" && attachmentRef == "" {
		s.mu.Unlock()
		return
	}
	if prompt == "" {
		prompt = "请查看这个附件。"
	}
	s.draft = ""
	s.pendingInput = ""
	s.attachmentNote = ""
	messageID := fmt.Sprintf("native-msg-%d", time.Now().UnixNano())
	userMessage := newNativeMessage("user", prompt)
	userMessage.id = messageID
	s.messages = append(s.messages, userMessage)
	assistantIndex := len(s.messages)
	s.messages = append(s.messages, newNativeMessage("assistant", "正在连接 Go runtime…"))
	s.sending = true
	s.runtimeHealthy = true
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.activeCancel = cancel
	s.mu.Unlock()
	go func() {
		text, err := s.runPrompt(ctx, prompt, attachmentRef, messageID, assistantIndex)
		s.finishSend(assistantIndex, text, err)
	}()
}

func (s *nativeShell) cancelRun() {
	s.mu.Lock()
	runID, cancel := s.activeRunID, s.activeCancel
	s.activeRunID, s.activeCancel = "", nil
	s.mu.Unlock()
	if runID != "" {
		go func() {
			request, err := http.NewRequest(http.MethodPost, s.apiBaseURL+"/api/v1/runs/"+url.PathEscape(runID)+"/cancel", nil)
			if err == nil {
				_, _ = http.DefaultClient.Do(request)
			}
		}()
	}
	if cancel != nil {
		cancel()
	}
}

// pickAttachment uses MyGo's native file dialog; the same upload path is used
// by the window's file-drop callback below. The Go API stores immutable blobs
// and returns a workspace reference that is sent with the next run.
func (s *nativeShell) pickAttachment() {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: s.window, Title: "添加附件", Multiple: false, Filters: []mygo.FileFilter{{Name: "学习资料", Extensions: []string{"md", "markdown", "txt", "pdf", "png", "jpg", "jpeg", "webp", "mp3", "wav", "m4a"}}}})
	if err != nil || len(paths) == 0 {
		return
	}
	go s.attachFile(paths[0])
}

func (s *nativeShell) attachFile(path string) {
	s.mu.Lock()
	if s.attachmentBusy {
		s.mu.Unlock()
		return
	}
	s.attachmentBusy = true
	s.attachmentNote = "正在上传附件…"
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
	ref, err := s.uploadAttachment(path)
	s.mu.Lock()
	s.attachmentBusy = false
	if err != nil {
		s.attachmentNote = "附件上传失败：" + err.Error()
	} else {
		s.pendingInput = ref
		s.attachmentNote = "附件已就绪：" + filepath.Base(path)
	}
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
}

func (s *nativeShell) uploadAttachment(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	requestReader, writer := io.Pipe()
	multipartWriter := multipart.NewWriter(writer)
	go func() {
		defer writer.Close()
		defer multipartWriter.Close()
		part, partErr := multipartWriter.CreateFormFile("file", filepath.Base(path))
		if partErr != nil {
			_ = writer.CloseWithError(partErr)
			return
		}
		if _, copyErr := io.Copy(part, file); copyErr != nil {
			_ = writer.CloseWithError(copyErr)
		}
	}()
	request, err := http.NewRequest(http.MethodPost, s.apiBaseURL+"/api/v1/attachments", requestReader)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("runtime returned HTTP %d", response.StatusCode)
	}
	var payload struct {
		Attachment struct {
			WorkspaceRef string `json:"workspace_ref"`
		} `json:"attachment"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.Attachment.WorkspaceRef) == "" {
		return "", fmt.Errorf("runtime returned no workspace reference")
	}
	return payload.Attachment.WorkspaceRef, nil
}

// runPrompt uses the same POST /runs + SSE /runs/{id}/events contract as the
// React adapter. This keeps the native composer a thin client of serverapp;
// provider selection and persistence remain owned by the Go runtime.
func (s *nativeShell) runPrompt(ctx context.Context, prompt, attachmentRef, messageID string, assistantIndex int) (string, error) {
	s.mu.Lock()
	sessionID := s.sessionID
	s.mu.Unlock()
	input := []string(nil)
	if attachmentRef != "" {
		input = []string{attachmentRef}
	}
	body, err := json.Marshal(map[string]any{"prompt": prompt, "session_id": sessionID, "message_id": messageID, "input": input, "streaming_mode": "events"})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.apiBaseURL+"/api/v1/runs", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("runtime returned HTTP %d", response.StatusCode)
	}
	var start nativeRunStart
	if err := json.NewDecoder(response.Body).Decode(&start); err != nil {
		return "", err
	}
	if start.RunID == "" {
		return "", fmt.Errorf("runtime response did not include a run id")
	}
	s.mu.Lock()
	s.activeRunID = start.RunID
	s.mu.Unlock()
	eventsURL := start.EventsURL
	if strings.HasPrefix(eventsURL, "/") {
		eventsURL = s.apiBaseURL + eventsURL
	}
	if eventsURL == "" {
		eventsURL = s.apiBaseURL + "/api/v1/runs/" + start.RunID + "/events"
	}
	var text string
	lastEventID := ""
	completed := false
	for attempt := 0; attempt < 4 && !completed; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return text, ctx.Err()
			case <-time.After(time.Duration(attempt) * 250 * time.Millisecond):
			}
		}
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, eventsURL, nil)
		if requestErr != nil {
			return text, requestErr
		}
		request.Header.Set("Accept", "text/event-stream")
		if lastEventID != "" {
			request.Header.Set("Last-Event-ID", lastEventID)
		}
		events, requestErr := http.DefaultClient.Do(request)
		if requestErr != nil {
			if ctx.Err() != nil { return text, ctx.Err() }
			continue
		}
		if events.StatusCode < http.StatusOK || events.StatusCode >= http.StatusMultipleChoices {
			events.Body.Close()
			if attempt == 3 { return text, fmt.Errorf("SSE stream returned HTTP %d", events.StatusCode) }
			continue
		}
		scanner := bufio.NewScanner(events.Body)
		scanner.Buffer(make([]byte, 4<<10), 1<<20)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "id:") {
				lastEventID = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
				continue
			}
			if !strings.HasPrefix(line, "data:") { continue }
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "" { continue }
			var event nativeRunEvent
			if json.Unmarshal([]byte(data), &event) != nil { continue }
			if event.ErrorMessage != "" {
				events.Body.Close()
				return text, fmt.Errorf("%s", event.ErrorMessage)
			}
			next := event.Delta
			if next == "" { next = event.Text }
			if next != "" {
				if event.Delta != "" {
					text += next
					s.appendAssistantDelta(assistantIndex, next)
				} else if strings.HasPrefix(next, text) {
					text = next
					s.setAssistant(assistantIndex, text)
				} else {
					text += next
					s.appendAssistantDelta(assistantIndex, next)
				}
			}
			if event.Done || event.Type == "run.completed" || event.Type == "run.error" || event.Type == "run.canceled" { completed = true; break }
		}
		scanErr := scanner.Err()
		events.Body.Close()
		if scanErr != nil && ctx.Err() != nil { return text, ctx.Err() }
	}
	s.mu.Lock()
	s.activeRunID, s.activeCancel = "", nil
	s.mu.Unlock()
	if !completed { return text, fmt.Errorf("SSE stream ended before completion") }
	if text == "" {
		text = "Go runtime 已完成，但没有返回文本。"
	}
	return text, nil
}

func (s *nativeShell) view(c *ui.Context) {
	if s.dark {
		c.SetTheme(ui.DarkTheme())
	}
	t := c.Theme()
	bar := c.TitleBar()
	barHeight := bar.Height
	if barHeight < 44 {
		barHeight = 44
	}

	ui.Column(c).Fill().Background(t.Background).Children(func() {
		// The titlebar is native UI too. Keep the middle region draggable while
		// leaving Toolbar controls available to the pointer and keyboard.
		ui.Row(c).
			Height(barHeight).
			Padding(0, bar.Right, 0, bar.Left).
			Background(t.Surface).
			BorderWidth(0, 0, 1, 0).
			BorderColor(t.Border).
			AlignItems(ui.Center).
			Children(func() {
				ui.Text(c, "DeepStudent").FontSize(16).Bold().SingleLine()
				ui.Text(c, "  Go runtime").FontSize(12).TextColor(t.TextMuted).SingleLine()
				ui.Spacer(c).DragWindow()
				ui.Toolbar(c, func() {
					if ui.Button(c, "新会话").Clicked() {
						s.selected = "chat"
					}
					if ui.Button(c, "设置").Clicked() {
						s.selected = "settings"
					}
					if ui.Button(c, "切换主题").Clicked() {
						s.dark = !s.dark
					}
				})
			})

		ui.Split(c, &s.sidebarWidth, func() {
			s.sidebar(c)
		}, func() {
			s.page(c)
		}).Grow(1)

		s.statusBar(c)
	})
}

func (s *nativeShell) sidebar(c *ui.Context) {
	t := c.Theme()
	ui.Sidebar(c, &s.selected, func() {
		ui.SidebarSection(c, "工作区", nil, func() {
			ui.SidebarItem(c, "chat", nil, "聊天")
			ui.SidebarItem(c, "resources", nil, "学习资源")
			ui.SidebarItem(c, "tasks", nil, "任务")
			ui.SidebarItem(c, "skills", nil, "技能管理")
			ui.SidebarItem(c, "flashcards", nil, "闪卡")
		})
		ui.SidebarSection(c, "管理", nil, func() {
			ui.SidebarItem(c, "settings", nil, "设置")
		})
	}).Fill().Background(t.Surface)
}

func (s *nativeShell) page(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Fill().Background(t.Background).Children(func() {
		header := ui.Row(c).Padding(t.Space(5), t.Space(6), t.Space(3), t.Space(6)).AlignItems(ui.Center)
		header.Children(func() {
			ui.Column(c).Grow(1).Children(func() {
				ui.Text(c, s.pageTitle()).FontSize(22).Bold().SingleLine()
				ui.Text(c, s.pageSubtitle()).FontSize(12).TextColor(t.TextMuted).SingleLine()
			})
			if ui.Button(c, "刷新状态").Clicked() {
				s.lastRefresh = time.Now()
				s.runtimeHealthy = true
			}
		})
		ui.Divider(c)
		// Chat owns a fixed composer below its growing timeline. A vertical
		// Scroll measures its children with an unbounded height, which moves a
		// composer nested inside it below the viewport on the native shell.
		// Keep chat in a finite-height body so the message list grows into the
		// available space and the input row stays visible and focusable. The
		// other pages remain scrollable as before.
		if s.selected == "chat" {
			ui.Column(c).Grow(1).Padding(t.Space(6)).Children(func() {
				s.chatPage(c)
			})
		} else {
			ui.Scroll(c).Grow(1).Padding(t.Space(6)).Children(func() {
				s.pageBody(c)
			})
		}
	})
}

func (s *nativeShell) pageTitle() string {
	switch s.selected {
	case "resources":
		return "学习资源"
	case "tasks":
		return "任务"
	case "skills":
		return "技能管理"
	case "flashcards":
		return "闪卡"
	case "settings":
		return "设置"
	default:
		return "聊天工作区"
	}
}

func (s *nativeShell) pageSubtitle() string {
	switch s.selected {
	case "settings":
		return "原生导航已就绪，服务配置继续由 Go runtime 管理。"
	case "chat":
		return "原生聊天骨架已连接 serverapp HTTP/SSE 契约。"
	default:
		return "原生页面边界继续复用现有 HTTP/SSE runtime。"
	}
}

func (s *nativeShell) pageBody(c *ui.Context) {
	switch s.selected {
	case "settings":
		s.settingsPage(c)
	case "resources":
		s.placeholderPage(c, "学习资源", "资源导入和预览仍沿用 WebView，原生编辑器将在后续迁移。")
	case "tasks":
		s.placeholderPage(c, "任务", "任务数据继续由 serverapp 提供，这里是未来原生列表视图的迁移接缝。")
	case "skills":
		s.placeholderPage(c, "技能管理", "技能数据仍由 Go runtime 管理，原生列表视图将在后续迁移。")
	case "flashcards":
		s.placeholderPage(c, "闪卡", "闪卡组和复习计划将在资源 API 稳定后迁移到原生页面。")
	default:
		s.chatPage(c)
	}
}

func (s *nativeShell) chatPage(c *ui.Context) {
	t := c.Theme()
	messages := s.messageSnapshot()
	sending := s.sendingState()
	attachmentBusy, attachmentNote := s.attachmentState()
	ui.Column(c).Fill().Gap(t.Space(3)).Children(func() {
		ui.Row(c).Gap(t.Space(2)).AlignItems(ui.Center).Children(func() {
			statusDot(c, t.Success)
			ui.Text(c, "Go runtime 已连接 · HTTP/SSE").FontSize(12).TextColor(t.TextMuted)
			ui.Spacer(c)
			if ui.PrimaryButton(c, "切换到 WebView Chat").Clicked() && s.openChat != nil {
				s.openChat()
			}
		})
		ui.List(c, &s.messagesList, len(messages), func(i int) {
			message := messages[i]
			row := ui.Box(c).MaxWidth(820).Padding(t.Space(3), t.Space(4)).Gap(t.Space(1)).Border(1, t.Border).Radius(t.Radius)
			if message.role == "user" {
				row.Background(t.SurfacePressed)
			}
			row.Children(func() {
				label := "DeepStudent"
				if message.role == "user" {
					label = "你"
				}
				ui.Text(c, label).FontSize(12).Bold().TextColor(t.TextMuted).SingleLine()
				s.renderMarkdown(c, message)
			})
		}).Grow(1).MinHeight(0).Gap(t.Space(3))
		composer := ui.Row(c).Gap(t.Space(2)).AlignItems(ui.End)
		composer.Children(func() {
			if ui.Button(c, "附件").Clicked() {
				go s.pickAttachment()
			}
			input := ui.TextInput(c, &s.draft).Grow(1).Placeholder("输入消息，按 Enter 发送")
			if attachmentBusy {
				ui.Text(c, "上传中…").FontSize(11).TextColor(t.TextMuted).SingleLine()
			}
			if attachmentNote != "" && !attachmentBusy {
				ui.Text(c, attachmentNote).FontSize(11).TextColor(t.TextMuted).SingleLine()
			}
			buttonLabel := "发送"
			if sending {
				buttonLabel = "取消"
			}
			button := ui.PrimaryButton(c, buttonLabel)
			if sending {
				if button.Clicked() {
					s.cancelRun()
				}
			} else if input.Submitted() || button.Clicked() {
				s.submitDraft()
			}
		})
		ui.Text(c, "原生聊天骨架复用 serverapp 的 /api/v1/runs + SSE；附件与富文本编辑器仍留在 WebView 边界。").FontSize(11).TextColor(t.TextMuted)
	})
}

// renderMarkdown maps the dependency-free Markdown AST to MyGo primitives.
// MyGo v0.2.11 RichText/Span is used for syntax-highlighted code. Blocks,
// tables, headings and lists remain fully native and update as SSE snapshots
// arrive.
func (s *nativeShell) renderMarkdown(c *ui.Context, message nativeMessage) {
	t := c.Theme()
	nodes := message.nodes
	if len(message.pending) > 0 {
		nodes = append(append([]markdown.Node(nil), nodes...), message.pending...)
	}
	if len(nodes) == 0 && message.content != "" {
		nodes = markdown.Parse(message.content)
	}
	for _, node := range nodes {
		switch node.Kind {
		case markdown.Heading:
			size := float32(22 - (node.Level-1)*2)
			if size < 14 { size = 14 }
			ui.Text(c, node.Text).FontSize(size).Bold().Selectable()
		case markdown.Code:
			ui.Box(c).Padding(t.Space(2), t.Space(3)).Background(t.SurfacePressed).Border(1, t.Border).Radius(t.Radius).Children(func() {
				if node.Language != "" {
					ui.Text(c, node.Language).FontSize(11).Bold().TextColor(t.TextMuted).SingleLine()
				}
				s.renderCode(c, node, t)
			})
		case markdown.Table:
			ui.Box(c).Border(1, t.Border).Radius(t.Radius).Children(func() {
				ui.Row(c).Background(t.SurfacePressed).Children(func() {
					for _, cell := range node.Headers {
						ui.Box(c).Grow(1).Padding(t.Space(2), t.Space(2)).Children(func() { ui.Text(c, cell).Bold().Selectable() })
					}
				})
				for _, row := range node.Rows {
					ui.Row(c).Children(func() {
						for _, cell := range row {
							ui.Box(c).Grow(1).Padding(t.Space(2), t.Space(2)).Children(func() { ui.Text(c, cell).Selectable() })
						}
					})
				}
			})
		case markdown.List:
			for _, line := range node.Lines {
				ui.Text(c, "• "+line).Selectable()
			}
		case markdown.Quote:
			ui.Box(c).Padding(t.Space(2), t.Space(3)).Background(t.Surface).Border(1, t.Border).Radius(t.Radius).Children(func() {
				ui.Text(c, node.Text).TextColor(t.TextMuted).Selectable()
			})
		case markdown.Rule:
			ui.Divider(c)
		default:
			ui.Text(c, node.Text).Selectable()
		}
	}
}

// renderCode maps each lexer token to a native MyGo Span. RichText handles
// wrapping and newline preservation as one selectable element, while each
// token keeps its own syntax color. There is no HTML/CSS or JavaScript here.
func (s *nativeShell) renderCode(c *ui.Context, node markdown.Node, t *ui.Theme) {
	spans := make([]ui.Span, 0, len(node.Tokens))
	for _, token := range node.Tokens {
		if token.Text == "" {
			continue
		}
		span := ui.Span{Text: token.Text, Color: codeTokenColor(t, token.Kind)}
		if token.Kind == "keyword" {
			span.Weight = 600
		}
		spans = append(spans, span)
	}
	if len(spans) == 0 {
		for _, line := range node.Lines {
			spans = append(spans, ui.Span{Text: line, Color: t.Text})
			spans = append(spans, ui.Span{Text: "\n", Color: t.Text})
		}
	}
	if len(spans) > 0 {
		ui.RichText(c, spans...).FontSize(12).Selectable()
	}
}

func codeTokenColor(t *ui.Theme, kind string) ui.Color {
	switch kind {
	case "keyword":
		return t.Warning
	case "string":
		return t.Success
	case "comment", "whitespace", "punctuation":
		return t.TextMuted
	default:
		return t.Text
	}
}

func (s *nativeShell) placeholderPage(c *ui.Context, title, description string) {
	t := c.Theme()
	ui.Column(c).MaxWidth(820).Gap(t.Space(4)).Children(func() {
		ui.Text(c, title).FontSize(18).Bold()
		ui.Text(c, description).TextColor(t.TextMuted)
		ui.Box(c).Padding(t.Space(4)).Background(t.Surface).Border(1, t.Border).Radius(t.Radius).Children(func() {
			ui.Text(c, "WebView 迁移边界").Bold()
			ui.Text(c, "原生壳先提供可用导航，再逐页迁移完整编辑体验。").FontSize(12).TextColor(t.TextMuted)
		})
	})
}

func (s *nativeShell) settingsPage(c *ui.Context) {
	t := c.Theme()
	if s.onboardingOpen {
		s.onboardingPage(c)
		return
	}
	ui.Row(c).AlignItems(ui.Start).Gap(t.Space(5)).Children(func() {
		ui.Column(c).Width(176).Padding(t.Space(2)).Background(t.Surface).Border(1, t.Border).Radius(t.Radius).Gap(t.Space(1)).Children(func() {
			for _, tab := range []struct {
				id, label string
			}{
				{id: "general", label: "常规"},
				{id: "appearance", label: "外观"},
				{id: "runtime", label: "运行时"},
			} {
				button := ui.Button(c, tab.label)
				button.FillWidth().TextAlign(ui.Start)
				if s.settingsTab == tab.id {
					button.Background(t.SurfacePressed).TextColor(t.Text)
				}
				if button.Clicked() {
					s.settingsTab = tab.id
				}
			}
		})
		ui.Column(c).Grow(1).Gap(t.Space(4)).Children(func() {
			s.settingsContent(c)
		})
	})
}

func (s *nativeShell) onboardingPage(c *ui.Context) {
	t := c.Theme()
	labels := []string{"学习目标", "学习方式", "模型", "运行时"}
	options := [][]string{
		{"备考与考试", "跟上课程", "长期掌握技能"},
		{"练习优先", "整理优先", "计划优先"},
		{"DeepStudent Local", "OpenAI", "兼容 OpenAI 的服务"},
		{"Go runtime", "浏览器运行时"},
	}
	ui.Column(c).MaxWidth(760).Gap(t.Space(4)).Children(func() {
		ui.Text(c, "首次设置").FontSize(12).TextColor(t.TextMuted).SingleLine()
		ui.Text(c, "设置你的学习方式").FontSize(24).Bold()
		ui.Text(c, fmt.Sprintf("第 %d / %d 步 · %s", s.onboardingStep+1, len(labels), labels[s.onboardingStep])).TextColor(t.TextMuted)
		ui.Column(c).Gap(t.Space(2)).Children(func() {
			for index, option := range options[s.onboardingStep] {
				button := ui.Button(c, option)
				button.FillWidth().TextAlign(ui.Start)
				if s.onboarding[s.onboardingStep] == option {
					button.Background(t.SurfacePressed).TextColor(t.Text)
				}
				if button.Clicked() {
					s.onboarding[s.onboardingStep] = option
				}
				_ = index
			}
		})
		ui.Row(c).Gap(t.Space(2)).Children(func() {
			if ui.Button(c, "退出向导").Clicked() {
				s.onboardingOpen = false
			}
			if s.onboardingStep > 0 && ui.Button(c, "上一步").Clicked() {
				s.onboardingStep--
			}
			ui.Spacer(c)
			label := "下一步"
			if s.onboardingStep == len(labels)-1 {
				label = "完成设置"
			}
			if ui.PrimaryButton(c, label).Clicked() {
				if s.onboardingStep == len(labels)-1 {
					s.onboardingOpen = false
					s.onboardingStep = 0
				} else {
					s.onboardingStep++
				}
			}
		})
	})
}

func (s *nativeShell) settingsContent(c *ui.Context) {
	t := c.Theme()
	switch s.settingsTab {
	case "appearance":
		ui.Text(c, "外观").FontSize(16).Bold()
		ui.Row(c).Gap(t.Space(3)).Children(func() {
			if ui.Button(c, "浅色主题").Clicked() {
				s.dark = false
			}
			if ui.Button(c, "深色主题").Clicked() {
				s.dark = true
			}
		})
		ui.Text(c, "主题选择使用原生控件，并应用到完整桌面壳。").FontSize(12).TextColor(t.TextMuted)
	case "runtime":
		ui.Text(c, "运行时").FontSize(16).Bold()
		ui.Text(c, "原生壳与 WebView 页面共享同一个 serverapp 进程。").TextColor(t.TextMuted)
		ui.Box(c).Padding(t.Space(4)).Background(t.Surface).Border(1, t.Border).Radius(t.Radius).Children(func() {
			ui.Text(c, "HTTP/SSE 状态").Bold()
			ui.Row(c).Gap(t.Space(2)).Children(func() {
				statusDot(c, t.Success)
				ui.Text(c, fmt.Sprintf("健康 · 检查于 %s", s.lastRefresh.Format("15:04:05"))).FontSize(12).TextColor(t.TextMuted)
			})
		})
	default:
		ui.Text(c, "常规").FontSize(16).Bold()
		ui.Text(c, "桌面壳偏好和导航已使用原生控件，账号与模型配置继续由 Go API 提供。").TextColor(t.TextMuted)
		if ui.PrimaryButton(c, "打开首次设置向导").Clicked() {
			s.onboardingOpen = true
		}
	}
}

func (s *nativeShell) statusBar(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Height(30).Padding(0, t.Space(4)).Gap(t.Space(2)).Background(t.Surface).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).AlignItems(ui.Center).Children(func() {
		color := t.Success
		label := "运行时健康"
		if !s.runtimeHealthy {
			color = t.Warning
			label = "运行时重连中"
		}
		statusDot(c, color)
		ui.Text(c, label).FontSize(11).TextColor(t.TextMuted).SingleLine()
		ui.Spacer(c)
		ui.Text(c, "原生壳 · WebView 聊天边界 · MyGo v0.2.11").FontSize(11).TextColor(t.TextMuted).SingleLine()
	})
}

func statusDot(c *ui.Context, color ui.Color) {
	ui.Box(c).Size(8, 8).Radius(4).Background(color).Shrink(0)
}

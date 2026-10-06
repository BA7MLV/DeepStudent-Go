package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo/ui"
)

// nativeShell owns the small, native-first desktop shell. The HTTP/SSE chat
// runtime is intentionally kept outside this type: chat and resource pages
// can move behind this boundary one at a time without changing serverapp.
//
// In v0.2.5 the native shell is the window's content. It now owns a small
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
	apiBaseURL     string
	invalidate     func()
	draft          string
	sending        bool
	messages       []nativeMessage
	messagesList   ui.ListState
	mu             sync.Mutex
}

type nativeMessage struct {
	role    string
	content string
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

func newNativeShell(apiBaseURL string) *nativeShell {
	return &nativeShell{
		selected:       "chat",
		settingsTab:    "general",
		sidebarWidth:   232,
		lastRefresh:    time.Now(),
		runtimeHealthy: true,
		apiBaseURL:     strings.TrimRight(apiBaseURL, "/"),
		messagesList:   ui.ListState{FollowEnd: true},
		messages: []nativeMessage{{
			role:    "assistant",
			content: "你好，我是 DeepStudent。你可以直接在这里开始一个学习对话。",
		}},
	}
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

func (s *nativeShell) setAssistant(index int, text string) {
	s.mu.Lock()
	if index >= 0 && index < len(s.messages) {
		s.messages[index].content = text
	}
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
}

func (s *nativeShell) finishSend(index int, text string, err error) {
	if err != nil {
		text = "请求失败：" + err.Error()
	}
	s.mu.Lock()
	if index >= 0 && index < len(s.messages) {
		s.messages[index].content = text
	}
	s.sending = false
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
	if prompt == "" {
		return
	}
	s.mu.Lock()
	if s.sending {
		s.mu.Unlock()
		return
	}
	s.draft = ""
	s.messages = append(s.messages, nativeMessage{role: "user", content: prompt})
	assistantIndex := len(s.messages)
	s.messages = append(s.messages, nativeMessage{role: "assistant", content: "正在连接 Go runtime…"})
	s.sending = true
	s.runtimeHealthy = true
	s.mu.Unlock()
	if s.invalidate != nil {
		s.invalidate()
	}
	go func() {
		text, err := s.runPrompt(prompt, assistantIndex)
		s.finishSend(assistantIndex, text, err)
	}()
}

// runPrompt uses the same POST /runs + SSE /runs/{id}/events contract as the
// React adapter. This keeps the native composer a thin client of serverapp;
// provider selection and persistence remain owned by the Go runtime.
func (s *nativeShell) runPrompt(prompt string, assistantIndex int) (string, error) {
	body, err := json.Marshal(map[string]any{"prompt": prompt, "streaming_mode": "events"})
	if err != nil {
		return "", err
	}
	response, err := http.Post(s.apiBaseURL+"/api/v1/runs", "application/json", bytes.NewReader(body))
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
	eventsURL := start.EventsURL
	if strings.HasPrefix(eventsURL, "/") {
		eventsURL = s.apiBaseURL + eventsURL
	}
	if eventsURL == "" {
		eventsURL = s.apiBaseURL + "/api/v1/runs/" + start.RunID + "/events"
	}
	events, err := http.Get(eventsURL)
	if err != nil {
		return "", err
	}
	defer events.Body.Close()
	if events.StatusCode < http.StatusOK || events.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("SSE stream returned HTTP %d", events.StatusCode)
	}
	var text string
	scanner := bufio.NewScanner(events.Body)
	scanner.Buffer(make([]byte, 4<<10), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		var event nativeRunEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		if event.ErrorMessage != "" {
			return text, fmt.Errorf("%s", event.ErrorMessage)
		}
		next := event.Delta
		if next == "" {
			next = event.Text
		}
		if next != "" {
			if event.Delta != "" {
				text += next
			} else if strings.HasPrefix(next, text) {
				text = next
			} else {
				text += next
			}
			s.setAssistant(assistantIndex, text)
		}
		if event.Done || event.Type == "run.completed" || event.Type == "run.error" || event.Type == "run.canceled" {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return text, err
	}
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
		ui.Scroll(c).Grow(1).Padding(t.Space(6)).Children(func() {
			s.pageBody(c)
		})
	})
}

func (s *nativeShell) pageTitle() string {
	switch s.selected {
	case "resources":
		return "学习资源"
	case "tasks":
		return "任务"
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
	default:
		s.chatPage(c)
	}
}

func (s *nativeShell) chatPage(c *ui.Context) {
	t := c.Theme()
	messages := s.messageSnapshot()
	sending := s.sendingState()
	ui.Column(c).Fill().Gap(t.Space(3)).Children(func() {
		ui.Row(c).Gap(t.Space(2)).AlignItems(ui.Center).Children(func() {
			statusDot(c, t.Success)
			ui.Text(c, "Go runtime 已连接 · HTTP/SSE").FontSize(12).TextColor(t.TextMuted)
			ui.Spacer(c)
			if ui.Button(c, "打开 Web Chat").Clicked() && s.openChat != nil {
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
				ui.Text(c, message.content).Selectable()
			})
		}).Grow(1).MinHeight(0).Gap(t.Space(3))
		composer := ui.Row(c).Gap(t.Space(2)).AlignItems(ui.End)
		composer.Children(func() {
			input := ui.TextInput(c, &s.draft).Grow(1).Placeholder("输入消息，按 Enter 发送")
			send := ui.PrimaryButton(c, "发送").Disabled(sending)
			if (input.Submitted() || send.Clicked()) && !sending {
				s.submitDraft()
			}
		})
		ui.Text(c, "原生聊天骨架复用 serverapp 的 /api/v1/runs + SSE；附件与富文本编辑器仍留在 WebView 边界。").FontSize(11).TextColor(t.TextMuted)
	})
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
		ui.Text(c, "原生壳 · WebView 聊天边界 · MyGo v0.2.5").FontSize(11).TextColor(t.TextMuted).SingleLine()
	})
}

func statusDot(c *ui.Context, color ui.Color) {
	ui.Box(c).Size(8, 8).Radius(4).Background(color).Shrink(0)
}

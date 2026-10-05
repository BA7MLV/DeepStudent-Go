package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
)

// nativeShell owns the small, native-first desktop shell. The HTTP/SSE chat
// runtime is intentionally kept outside this type: chat and resource pages
// can move behind this boundary one at a time without changing serverapp.
//
// In v0.2.5 the native shell is the window's content. The existing React
// surface remains the WebView migration boundary until an equivalent native
// chat/editor is ready; this shell renders the navigation and status around
// that seam without pretending to implement the chat timeline yet.
type nativeShell struct {
	selected       string
	settingsTab    string
	sidebarWidth   float32
	dark           bool
	lastRefresh    time.Time
	runtimeHealthy bool
	openChat       func()
}

func newNativeShell() *nativeShell {
	return &nativeShell{
		selected:       "chat",
		settingsTab:    "general",
		sidebarWidth:   232,
		lastRefresh:    time.Now(),
		runtimeHealthy: true,
	}
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
					if ui.Button(c, "New session").Clicked() {
						s.selected = "chat"
					}
					if ui.Button(c, "Settings").Clicked() {
						s.selected = "settings"
					}
					if ui.Button(c, "Toggle theme").Clicked() {
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
		ui.SidebarSection(c, "Workspace", nil, func() {
			ui.SidebarItem(c, "chat", nil, "Chat")
			ui.SidebarItem(c, "resources", nil, "Learning resources")
			ui.SidebarItem(c, "tasks", nil, "Tasks")
		})
		ui.SidebarSection(c, "Manage", nil, func() {
			ui.SidebarItem(c, "settings", nil, "Settings")
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
			if ui.Button(c, "Refresh status").Clicked() {
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
		return "Learning resources"
	case "tasks":
		return "Tasks"
	case "settings":
		return "Settings"
	default:
		return "Chat workspace"
	}
}

func (s *nativeShell) pageSubtitle() string {
	switch s.selected {
	case "settings":
		return "Native navigation is ready; service configuration stays in Go."
	case "chat":
		return "Native shell is active while the React WebView chat migrates incrementally."
	default:
		return "A native page boundary backed by the existing HTTP/SSE runtime."
	}
}

func (s *nativeShell) pageBody(c *ui.Context) {
	switch s.selected {
	case "settings":
		s.settingsPage(c)
	case "resources":
		s.placeholderPage(c, "Learning resources", "Resource import and preview continue to use the existing WebView page until their native editor is ready.")
	case "tasks":
		s.placeholderPage(c, "Tasks", "Task data remains served by serverapp; this native page is the migration seam for a future list view.")
	default:
		s.chatPage(c)
	}
}

func (s *nativeShell) chatPage(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).MaxWidth(820).Gap(t.Space(4)).Children(func() {
		ui.Text(c, "Native shell ready").FontSize(18).Bold()
		ui.Text(c, "The window chrome, sidebar, split layout, toolbar, status, and settings navigation are native MyGo UI. The chat timeline and composer remain in the React WebView boundary for this spike, so the HTTP/SSE contract stays unchanged.").TextColor(t.TextMuted)
		ui.Row(c).Gap(t.Space(3)).Children(func() {
			statusDot(c, t.Success)
			ui.Text(c, "serverapp HTTP/SSE runtime is running").TextColor(t.TextMuted)
		})
		if ui.PrimaryButton(c, "Open chat workspace").Clicked() && s.openChat != nil {
			s.openChat()
		}
		ui.Box(c).Padding(t.Space(4)).Background(t.Surface).Border(1, t.Border).Radius(t.Radius).Children(func() {
			ui.Text(c, "Native migration boundary").Bold()
			ui.Text(c, "The native shell owns navigation and desktop controls. Chat remains a full WebView window and keeps the same Go HTTP/SSE contract.").FontSize(12).TextColor(t.TextMuted)
		})
	})
}

func (s *nativeShell) placeholderPage(c *ui.Context, title, description string) {
	t := c.Theme()
	ui.Column(c).MaxWidth(820).Gap(t.Space(4)).Children(func() {
		ui.Text(c, title).FontSize(18).Bold()
		ui.Text(c, description).TextColor(t.TextMuted)
		ui.Box(c).Padding(t.Space(4)).Background(t.Surface).Border(1, t.Border).Radius(t.Radius).Children(func() {
			ui.Text(c, "WebView migration boundary").Bold()
			ui.Text(c, "The native shell is intentionally useful before the full page is migrated.").FontSize(12).TextColor(t.TextMuted)
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
				{id: "general", label: "General"},
				{id: "appearance", label: "Appearance"},
				{id: "runtime", label: "Runtime"},
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
		ui.Text(c, "Appearance").FontSize(16).Bold()
		ui.Row(c).Gap(t.Space(3)).Children(func() {
			if ui.Button(c, "Use light theme").Clicked() {
				s.dark = false
			}
			if ui.Button(c, "Use dark theme").Clicked() {
				s.dark = true
			}
		})
		ui.Text(c, "Theme selection is native and applies to the complete shell.").FontSize(12).TextColor(t.TextMuted)
	case "runtime":
		ui.Text(c, "Runtime").FontSize(16).Bold()
		ui.Text(c, "The native shell shares the same serverapp process as the existing WebView pages.").TextColor(t.TextMuted)
		ui.Box(c).Padding(t.Space(4)).Background(t.Surface).Border(1, t.Border).Radius(t.Radius).Children(func() {
			ui.Text(c, "HTTP/SSE status").Bold()
			ui.Row(c).Gap(t.Space(2)).Children(func() {
				statusDot(c, t.Success)
				ui.Text(c, fmt.Sprintf("healthy · checked %s", s.lastRefresh.Format("15:04:05"))).FontSize(12).TextColor(t.TextMuted)
			})
		})
	default:
		ui.Text(c, "General").FontSize(16).Bold()
		ui.Text(c, "Desktop shell preferences and navigation are now native. Account and model configuration remain served by the existing Go API.").TextColor(t.TextMuted)
	}
}

func (s *nativeShell) statusBar(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Height(30).Padding(0, t.Space(4)).Gap(t.Space(2)).Background(t.Surface).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).AlignItems(ui.Center).Children(func() {
		color := t.Success
		label := "Runtime healthy"
		if !s.runtimeHealthy {
			color = t.Warning
			label = "Runtime reconnecting"
		}
		statusDot(c, color)
		ui.Text(c, label).FontSize(11).TextColor(t.TextMuted).SingleLine()
		ui.Spacer(c)
		ui.Text(c, "Native shell · WebView chat boundary · MyGo v0.2.5").FontSize(11).TextColor(t.TextMuted).SingleLine()
	})
}

func statusDot(c *ui.Context, color ui.Color) {
	ui.Box(c).Size(8, 8).Radius(4).Background(color).Shrink(0)
}

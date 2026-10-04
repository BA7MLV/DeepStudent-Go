package main

import (
	"log"

	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/egoist/mygo"
)

func main() {
	mygo.Bind(runtime.NewHealthService())

	mygo.App.WhenReady(func() {
		// Keep the shell's Chat UI in React, while letting MyGo own the
		// platform menu and window chrome. Roles provide native edit, view,
		// window and app behavior on macOS, Linux and Windows.
		mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
			{Role: mygo.RoleAppMenu},
			{Role: mygo.RoleFileMenu},
			{Role: mygo.RoleEditMenu},
			{Role: mygo.RoleViewMenu},
			{Role: mygo.RoleWindowMenu},
		}))

		win := mygo.NewWindow(mygo.WindowOptions{
			Title:         "DeepStudent Go",
			URL:           "/",
			Width:         1280,
			Height:        800,
			MinWidth:      720,
			MinHeight:     480,
			StateKey:      "main",
			TitleBarStyle: mygo.TitleBarHidden,
			TitleBarHeight: 40,
		})
		// Keep the browser's normal drag/drop behavior in React while also
		// receiving drops outside its explicit drop zones (for example from
		// Finder onto the shell chrome) through MyGo's native file API.
		win.OnFileDrop(func(e *mygo.FileDropEvent) {
			log.Printf("native file drop at (%d,%d): %v", e.X, e.Y, e.Paths)
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

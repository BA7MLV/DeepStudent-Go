package main

import (
	"log"

	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/egoist/mygo"
)

func main() {
	mygo.Bind(runtime.NewHealthService())

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:         "DeepStudent Go",
			URL:           "/",
			TitleBarStyle: mygo.TitleBarHidden,
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

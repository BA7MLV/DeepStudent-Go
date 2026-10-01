# DeepStudent-Go

Go-primary runtime migration workspace for DeepStudent.

This repository starts with a desktop shell proof of concept using [MyGo](https://github.com/egoist/mygo) and a versioned runtime boundary. The existing DeepStudent implementation remains the source of truth until the vertical slice passes its compatibility and benchmark gates.

## First milestone

- MyGo desktop shell for macOS, Windows, and Linux
- Go runtime process with a versioned JSON-RPC boundary
- DeepSeek/OpenAI streaming adapter
- One allow-listed read-only tool
- Safe fallback to the existing runtime

## Scope guard

This is an incremental migration. It does not migrate the full product, delete the existing implementation, or change data schemas in the first milestone.

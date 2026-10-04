import SwiftUI

struct SessionDetailView: View {
    let session: StudySession
    @EnvironmentObject private var model: AppModel
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    private var messages: [ChatMessage] { model.messages(for: session) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("composer-anchor")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .onChange(of: messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("composer-anchor", anchor: .bottom)
                }
            }
            .safeAreaInset(edge: .bottom) {
                ComposerBar(text: $draft, isFocused: $composerFocused) {
                    let prompt = draft
                    draft = ""
                    composerFocused = false
                    Task { await model.send(prompt, in: session) }
                }
                .background(.bar)
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Mark as read", systemImage: "checkmark.circle") { }
                    Button("Pin session", systemImage: "pin") { }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var isUser: Bool { message.role == .user }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 46) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 5) {
                Text(message.content.isEmpty && message.delivery == .streaming ? "Thinking…" : message.content)
                    .font(.body)
                    .foregroundStyle(isUser ? .white : .primary)
                    .textSelection(.enabled)
                HStack(spacing: 5) {
                    Text(message.createdAt, format: .dateTime.hour().minute())
                    if message.delivery == .streaming {
                        ProgressView().controlSize(.mini)
                    } else if message.delivery == .failed {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                }
                .font(.caption2)
                .foregroundStyle(isUser ? .white.opacity(0.72) : .secondary)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(isUser ? Color.accentColor : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            if !isUser { Spacer(minLength: 46) }
        }
    }
}

struct ComposerBar: View {
    @Binding var text: String
    @FocusState.Binding var isFocused: Bool
    let send: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button(action: {}) {
                Image(systemName: "plus")
                    .font(.body.weight(.semibold))
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Add attachment")

            TextField("Ask about this topic", text: $text, axis: .vertical)
                .focused($isFocused)
                .lineLimit(1...4)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 17, style: .continuous))

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 27))
                    .foregroundStyle(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .secondary : .blue)
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

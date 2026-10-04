import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var sessions: [StudySession] = []
    @Published private(set) var messagesBySession: [String: [ChatMessage]] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var connectionState: RuntimeConnectionState = .unknown
    @Published var selectedSection: AppSection = .sessions
    @Published var runtimeURL = "http://127.0.0.1:8080"
    @Published var useFixtureRuntime = true
    @Published var reduceMotion = false

    private let repository: any SessionRepository
    private var runtime: any DeepStudentRuntimeClient

    init(
        repository: any SessionRepository = FixtureSessionRepository(),
        runtime: any DeepStudentRuntimeClient = FixtureRuntimeClient()
    ) {
        self.repository = repository
        self.runtime = runtime
    }

    func bootstrap() async {
        guard sessions.isEmpty else { return }
        await refresh()
        await checkRuntime()
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await repository.loadSessions()
            sessions = loaded.sorted { lhs, rhs in
                if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
                return lhs.lastActivity > rhs.lastActivity
            }
            for session in loaded {
                messagesBySession[session.id] = session.messages
            }
        } catch {
            // Fixtures are intentionally local and should not make the shell fatal.
        }
    }

    func messages(for session: StudySession) -> [ChatMessage] {
        messagesBySession[session.id] ?? session.messages
    }

    func checkRuntime() async {
        connectionState = .checking
        do {
            _ = try await runtime.health()
            _ = try await runtime.readiness()
            connectionState = .ready
        } catch {
            connectionState = .unavailable(error.localizedDescription)
        }
    }

    func applyRuntimePreference() {
        if useFixtureRuntime {
            runtime = FixtureRuntimeClient()
        } else if let url = URL(string: runtimeURL), let scheme = url.scheme, !scheme.isEmpty {
            runtime = GoRuntimeClient(baseURL: url)
        } else {
            connectionState = .unavailable("Enter a valid runtime URL.")
        }
    }

    func send(_ prompt: String, in session: StudySession) async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let userMessage = ChatMessage(role: .user, content: trimmed)
        messagesBySession[session.id, default: []].append(userMessage)
        let assistantID = UUID().uuidString
        messagesBySession[session.id, default: []].append(
            ChatMessage(id: assistantID, role: .assistant, content: "", delivery: .streaming)
        )

        do {
            let accepted = try await runtime.startRun(RunRequest(sessionID: session.id, prompt: trimmed))
            for try await event in runtime.events(for: accepted) {
                switch event.type {
                case "message.delta":
                    appendDelta(event.displayDelta, to: assistantID, in: session.id)
                case "run.completed":
                    if !event.displayDelta.isEmpty { setContent(event.displayDelta, for: assistantID, in: session.id) }
                    markMessage(assistantID, delivery: .sent, in: session.id)
                case "run.error":
                    setContent(event.errorMessage ?? "The runtime reported an error.", for: assistantID, in: session.id)
                    markMessage(assistantID, delivery: .failed, in: session.id)
                default:
                    break
                }
            }
        } catch {
            setContent(error.localizedDescription, for: assistantID, in: session.id)
            markMessage(assistantID, delivery: .failed, in: session.id)
        }
    }

    private func appendDelta(_ delta: String, to id: String, in sessionID: String) {
        guard let index = messagesBySession[sessionID]?.firstIndex(where: { $0.id == id }) else { return }
        messagesBySession[sessionID]?[index].content += delta
    }

    private func setContent(_ content: String, for id: String, in sessionID: String) {
        guard let index = messagesBySession[sessionID]?.firstIndex(where: { $0.id == id }) else { return }
        messagesBySession[sessionID]?[index].content = content
    }

    private func markMessage(_ id: String, delivery: MessageDelivery, in sessionID: String) {
        guard let index = messagesBySession[sessionID]?.firstIndex(where: { $0.id == id }) else { return }
        messagesBySession[sessionID]?[index].delivery = delivery
    }
}

enum AppSection: String, CaseIterable, Identifiable, Hashable {
    case sessions
    case study
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .study: return "Study"
        case .settings: return "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .sessions: return "bubble.left.and.bubble.right"
        case .study: return "rectangle.stack"
        case .settings: return "gearshape"
        }
    }
}

import Foundation

protocol SessionRepository {
    func loadSessions() async throws -> [StudySession]
    func loadMessages(for sessionID: String) async throws -> [ChatMessage]
}

struct FixtureSessionRepository: SessionRepository {
    private let sessions: [StudySession]

    init(now: Date = .now) {
        self.sessions = FixtureData.sessions(now: now)
    }

    func loadSessions() async throws -> [StudySession] {
        sessions
    }

    func loadMessages(for sessionID: String) async throws -> [ChatMessage] {
        sessions.first(where: { $0.id == sessionID })?.messages ?? []
    }
}

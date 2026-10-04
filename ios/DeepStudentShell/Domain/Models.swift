import Foundation

// MARK: - Sessions and chat

enum SessionStatus: String, Codable, CaseIterable, Hashable {
    case active
    case waiting
    case completed
    case draft

    var label: String {
        switch self {
        case .active: return "Active"
        case .waiting: return "Waiting"
        case .completed: return "Completed"
        case .draft: return "Draft"
        }
    }
}

enum ChatRole: String, Codable, Hashable {
    case user
    case assistant
    case system
}

enum MessageDelivery: String, Codable, Hashable {
    case sent
    case streaming
    case failed
}

struct ChatMessage: Identifiable, Codable, Hashable {
    let id: String
    let role: ChatRole
    var content: String
    let createdAt: Date
    var delivery: MessageDelivery

    init(
        id: String = UUID().uuidString,
        role: ChatRole,
        content: String,
        createdAt: Date = .now,
        delivery: MessageDelivery = .sent
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.createdAt = createdAt
        self.delivery = delivery
    }
}

struct StudySession: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var topic: String
    var preview: String
    var lastActivity: Date
    var status: SessionStatus
    var unreadCount: Int
    var isPinned: Bool
    var messages: [ChatMessage]
}

// MARK: - Runtime contracts

struct HealthSnapshot: Codable, Hashable {
    let status: String
    let service: String
    let version: String
    let runtime: String?
    let requestID: String?
    let time: Date?

    var isHealthy: Bool { status == "ok" || status == "ready" }
}

struct ReadinessSnapshot: Codable, Hashable {
    let status: String
    let requestID: String?

    var isReady: Bool { status == "ready" }
}

struct RunRequest: Encodable, Hashable {
    let sessionID: String
    let prompt: String
    let model: String?
    let maxTokens: Int?

    init(sessionID: String, prompt: String, model: String? = nil, maxTokens: Int? = nil) {
        self.sessionID = sessionID
        self.prompt = prompt
        self.model = model
        self.maxTokens = maxTokens
    }

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case prompt
        case model
        case maxTokens = "max_tokens"
    }
}

struct RunAccepted: Decodable, Hashable {
    let runID: String
    let sessionID: String
    let eventsURL: URL
    let requestID: String?

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case sessionID = "session_id"
        case eventsURL = "events_url"
        case requestID = "request_id"
    }
}

struct RuntimeEvent: Decodable, Hashable {
    let id: String
    let runID: String
    let type: String
    let delta: String?
    let text: String?
    let errorCode: String?
    let errorMessage: String?
    let done: Bool?
    let createdAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case runID = "run_id"
        case type
        case delta
        case text
        case errorCode = "error_code"
        case errorMessage = "error_message"
        case done
        case createdAt = "created_at"
    }

    var displayDelta: String { delta ?? text ?? "" }
}

enum RuntimeConnectionState: Equatable {
    case unknown
    case checking
    case ready
    case unavailable(String)
}

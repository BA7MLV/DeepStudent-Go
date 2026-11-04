import Foundation

// Mirrors the formal watchBot result codec in typert.remote-client.js. No
// dependency on RuntimeRead's unrelated resource/session union is necessary.
public struct BotActivity: Decodable, Equatable, Sendable {
    public enum Phase: String, Decodable, Sendable { case queued, running, waitingUser = "waiting_user", model, tools, waitingEvent = "waiting_event" }
    public struct Tool: Decodable, Equatable, Sendable { public let id: String; public let name: String }
    public let phase: Phase
    public let tools: [Tool]
    public let activeTools: Int
    public let completedTools: Int
}

public struct BotRun: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case queued, running, waitingUser = "waiting_user", completed, failed, cancelled, waitingEvent = "waiting_event" }
    public let id: String
    public let threadId: String
    public let mode: ConversationMode
    public let status: Status
    public let createdAt: String
    public let startedAt: String?
    public let completedAt: String?
    private enum Keys: String, CodingKey { case id, threadId, mode, status, createdAt, startedAt, completedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id); threadId = try c.decode(String.self, forKey: .threadId)
        mode = try c.decode(ConversationMode.self, forKey: .mode); status = try c.decode(Status.self, forKey: .status)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        startedAt = try c.decode(String?.self, forKey: .startedAt)
        completedAt = try c.decode(String?.self, forKey: .completedAt)
    }
}

public enum BotJournalEvent: Decodable, Sendable {
    case message(Message), invalidated, activity(BotActivity?), resync
    case reaction(messageId: String, reaction: String, active: Bool)
    case run(BotRun), progress(runId: String, text: String), failed(BotRun, String)
    private enum Keys: String, CodingKey { case type, message, activity, messageId, reaction, active, run, runId, text, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "message.pending", "message.accepted", "message.updated": self = .message(try c.decode(Message.self, forKey: .message))
        case "thread.state_invalidated": self = .invalidated
        case "thread.activity": self = .activity(try c.decode(Optional<BotActivity>.self, forKey: .activity))
        case "resync.required": self = .resync
        case "message.reaction": self = .reaction(messageId: try c.decode(String.self, forKey: .messageId), reaction: try c.decode(String.self, forKey: .reaction), active: try c.decode(Bool.self, forKey: .active))
        case "run.started", "run.waiting_user", "run.completed": self = .run(try c.decode(BotRun.self, forKey: .run))
        case "run.failed": self = .failed(try c.decode(BotRun.self, forKey: .run), try c.decode(String.self, forKey: .error))
        case "run.progress": self = .progress(runId: try c.decode(String.self, forKey: .runId), text: try c.decode(String.self, forKey: .text))
        default: throw APIError(status: 0, code: "invalid_bot_event")
        }
    }
}

public struct BotJournalFrame: Decodable, Sendable {
    public enum Kind: String, Decodable, Sendable { case ready, event }
    public let type: Kind
    public let cursor: Int
    public let event: BotJournalEvent?
    private enum Keys: String, CodingKey { case type, cursor, event }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        type = try c.decode(Kind.self, forKey: .type)
        cursor = try c.decode(Int.self, forKey: .cursor)
        guard cursor >= 0, cursor <= 9_007_199_254_740_991 else { throw APIError(status: 0, code: "invalid_cursor") }
        event = type == .event ? try c.decode(BotJournalEvent.self, forKey: .event) : nil
    }
}

public struct BotSyncState: Decodable, Sendable {
    public let thread: ThreadSummary
    public let approvals: [Approval]
    public let running: Bool
    public let activity: BotActivity?
    public let eventCursor: Int
}

public struct BotMessagePage: Decodable, Sendable {
    public let messages: [Message]
    public let approvals: [Approval]
    public let hasOlder: Bool
    public let nextBeforeSeq: Int?
}

public struct BotSnapshot: Decodable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let mode: ConversationMode
    public let title: String?
    public let createdAt: String
    public let updatedAt: String
    public let messages: [Message]
    public let approvals: [Approval]
    public let eventCursor: Int
    public let hasOlder: Bool
    public let activity: BotActivity?
    public var detail: ThreadDetail { ThreadDetail(id: id, mode: mode, title: title, createdAt: createdAt, updatedAt: updatedAt, messages: messages, approvals: approvals) }
}

/// Applied watermark is independent of state/activity watermarks. Global event
/// IDs can legitimately have gaps for another thread; only Host resync.required
/// indicates a retained journal gap. Never infer contiguity from cursor + 1.
public struct BotProjection: Sendable {
    public let baselineID = UUID()
    public private(set) var detail: ThreadDetail
    public private(set) var cursor: Int
    public private(set) var stateCursor: Int
    public private(set) var activityCursor: Int
    public private(set) var activity: BotActivity?
    public private(set) var hasOlder: Bool
    public init(snapshot: BotSnapshot) throws {
        guard snapshot.schemaVersion == 1, snapshot.mode == .bot, snapshot.eventCursor >= 0,
              snapshot.eventCursor <= 9_007_199_254_740_991,
              snapshot.messages.allSatisfy({ $0.threadId == snapshot.id }) else { throw APIError(status: 0, code: "invalid_bot_snapshot") }
        detail = snapshot.detail; cursor = snapshot.eventCursor; stateCursor = cursor
        activityCursor = cursor; activity = snapshot.activity; hasOlder = snapshot.hasOlder
    }
    /// Returns true when a typed state query is needed. Throws before advancing
    /// a cursor when a frame cannot be applied.
    public mutating func apply(_ frame: BotJournalFrame) throws -> Bool {
        if frame.type == .ready {
            guard frame.cursor == cursor else { throw APIError(status: 0, code: "journal_resync") }
            return false
        }
        guard let event = frame.event else { throw APIError(status: 0, code: "invalid_bot_event") }
        if case .resync = event { throw APIError(status: 0, code: "journal_resync") }
        guard frame.cursor > cursor else { return false }
        var invalidate = false
        switch event {
        case .message(let message):
            guard message.threadId == detail.id else { throw APIError(status: 0, code: "invalid_bot_thread") }
            detail.messages = MessageGrouping.merge(message, into: detail.messages)
        case .activity(let value):
            if frame.cursor >= activityCursor { activity = value; activityCursor = frame.cursor }
        case .invalidated: invalidate = true
        case .run(let run), .failed(let run, _):
            guard run.threadId == detail.id else { throw APIError(status: 0, code: "invalid_bot_thread") }
        case .progress, .reaction: break // existing UI does not render run/reaction metadata
        case .resync: break
        }
        cursor = frame.cursor
        return invalidate
    }
    public mutating func applyState(_ state: BotSyncState) throws {
        guard state.thread.id == detail.id, state.eventCursor >= 0 else { throw APIError(status: 0, code: "invalid_bot_state") }
        guard state.eventCursor >= stateCursor else { return }
        detail.approvals = state.approvals
        stateCursor = state.eventCursor
        if state.eventCursor >= activityCursor { activity = state.activity; activityCursor = state.eventCursor }
    }
}

/// Foundation-only follower used by the SwiftUI shell and executable harness.
/// Backoff runs only after disconnection; there is no idle business timer.
public enum BotFollower {
    public static func run(client: APIClient, threadId: String,
        receive: @escaping @Sendable (BotProjection) async -> Void) async throws {
        var projection: BotProjection?
        var failures = 0
        var resyncs = 0
        while !Task.isCancelled {
            do {
                if projection == nil {
                    let snapshot = try await client.botSnapshot(threadId: threadId)
                    try Task.checkCancellation()
                    guard snapshot.id == threadId else { throw APIError(status: 0, code: "invalid_bot_snapshot") }
                    projection = try BotProjection(snapshot: snapshot)
                    await receive(projection!)
                }
                let subscription = try await client.remoteConnection().watchBot(threadId: threadId, after: projection!.cursor)
                do {
                    try await withTaskCancellationHandler {
                        for try await frame in subscription.frames {
                            try Task.checkCancellation()
                            let refresh = try projection!.apply(frame)
                            await receive(projection!)
                            failures = 0
                            if refresh {
                                let rows = projection!.detail.messages
                                let state = try await client.botState(threadId: threadId, fromSeq: rows.first?.seq ?? 0, toSeq: rows.last?.seq ?? 0)
                                try Task.checkCancellation()
                                try projection!.applyState(state)
                                await receive(projection!)
                            }
                        }
                    } onCancel: { Task { await subscription.cancel() } }
                    await subscription.cancel()
                    try Task.checkCancellation()
                } catch {
                    await subscription.cancel()
                    throw error
                }
            } catch {
                try Task.checkCancellation()
                if let api = error as? APIError, [401, 403, 404].contains(api.status) { throw api }
                if let remote = error as? RemoteFailure, ["client/unauthenticated", "client/forbidden"].contains(remote.code) {
                    throw APIError(status: remote.code == "client/unauthenticated" ? 401 : 403, code: remote.code)
                }
                if error is RemoteFailure { throw error }
                if let api = error as? APIError, ["journal_resync", "journal_overflow"].contains(api.code) {
                    resyncs += 1
                    guard resyncs <= 3 else { throw api }
                    projection = nil // snapshot+cursor atomically replace a retained-gap baseline
                    continue
                }
                if error is DecodingError { throw error } // corrupted/new schema is not silently retried
                if let api = error as? APIError, api.code.hasPrefix("invalid_") { throw api }
                // A revoked/expired live socket is closed by Host. Check actual
                // credentials before reconnecting; do not loop forever on 401.
                do {
                    guard try await client.currentUser() != nil else { throw APIError(status: 401, code: "unauthorized") }
                } catch let auth as APIError where [401, 403].contains(auth.status) { throw auth }
                catch { try Task.checkCancellation() /* offline: keep stale projection and back off */ }
            }
            let delay = min(30_000, 500 * (1 << min(failures, 6)))
            failures += 1
            try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
        }
        throw CancellationError()
    }
}

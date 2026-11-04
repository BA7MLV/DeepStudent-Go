import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct RemoteFailure: Error, Decodable, Sendable, LocalizedError {
    public let code: String
    public let message: String
    public let details: [String: RemoteJSON]
    public var errorDescription: String? { message }
}

public struct RuntimeReceipt: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case missing, pending, uncertain, completed, failed }
    public let status: Status
    public let value: RemoteJSON?
    public let code: String?
}
struct ReceiptResponse: Decodable {
    struct Result: Decodable { let ok: Bool; let value: RuntimeReceipt?; let error: RemoteFailure? }
    let type: String
    let rpcId: String
    let result: Result
}

/// JSON projection used only at the generated Remote boundary (not a new wire).
public enum RemoteJSON: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([RemoteJSON]), object([String: RemoteJSON])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self), v.isFinite { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([RemoteJSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: RemoteJSON].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

public struct BotSubscription: Sendable {
    public let frames: AsyncThrowingStream<BotJournalFrame, Error>
    let id: String
    let connection: RemoteConnection
    public func cancel() async { await connection.cancel(id) }
}

/// DSH alpha.2 stream-protocol/stream-server: text open/item/end/error/cancel.
/// There is no JSON heartbeat or socket "ready" handshake; ready is a Bot item.
public actor RemoteConnection {
    private let request: URLRequest
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var generation = UUID()
    private var disposed = false
    private var streams: [String: AsyncThrowingStream<BotJournalFrame, Error>.Continuation] = [:]

    public init(request: URLRequest, session: URLSession = .shared) {
        self.request = request; self.session = session
    }

    public func watchBot(threadId: String, after: Int) async throws -> BotSubscription {
        try Task.checkCancellation()
        guard !disposed else { throw CancellationError() }
        guard after >= 0, after <= 9_007_199_254_740_991 else { throw APIError(status: 0, code: "invalid_cursor") }
        if socket == nil {
            let task = session.webSocketTask(with: request)
            task.maximumMessageSize = 2 * 1024 * 1024
            socket = task
            let current = generation
            task.resume()
            receiver = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let message = try await task.receive()
                        guard let self else { return }
                        try await self.receive(message, generation: current)
                    }
                } catch {
                    await self?.failed(error, socket: task, generation: current)
                }
            }
        }
        let id = UUID().uuidString
        let pair = AsyncThrowingStream<BotJournalFrame, Error>.makeStream(bufferingPolicy: .bufferingOldest(64))
        streams[id] = pair.continuation
        pair.continuation.onTermination = { [weak self] _ in Task { await self?.cancel(id) } }
        let task = socket!
        do {
            let frame = RemoteJSON.object(["type": .string("open"), "streamId": .string(id),
                "endpoint": .string("clientRuntime/watchBot"), "payload": .object(["args": .object([
                    "threadId": .string(threadId), "after": .number(Double(after))])])])
            let text = String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
            try await withTaskCancellationHandler {
                try await task.send(.string(text))
            } onCancel: { Task { await self.cancel(id) } }
            try Task.checkCancellation()
        } catch {
            await cancel(id)
            throw error
        }
        return BotSubscription(frames: pair.stream, id: id, connection: self)
    }

    private struct Incoming: Decodable {
        let type: String
        let streamId: String
        let value: BotJournalFrame?
        let error: RemoteFailure?
    }

    private func receive(_ message: URLSessionWebSocketTask.Message, generation current: UUID) throws {
        guard current == generation else { return }
        guard case .string(let text) = message else { throw APIError(status: 0, code: "invalid_remote_frame") }
        // Ignore late items for cancelled logical streams, just like upstream.
        struct Header: Decodable { let type: String; let streamId: String }
        let data = Data(text.utf8)
        let header = try JSONDecoder().decode(Header.self, from: data)
        guard let continuation = streams[header.streamId] else { return }
        let keys = Set((try JSONDecoder().decode([String: RemoteJSON].self, from: data)).keys)
        let expected: Set<String>
        switch header.type {
        case "item": expected = ["type", "streamId", "value"] // watchBot never yields undefined
        case "end": expected = ["type", "streamId"]
        case "error": expected = ["type", "streamId", "error"]
        default: throw APIError(status: 0, code: "invalid_remote_frame")
        }
        guard keys == expected else { throw APIError(status: 0, code: "invalid_remote_frame") }
        let frame = try JSONDecoder().decode(Incoming.self, from: data)
        switch frame.type {
        case "item":
            guard let value = frame.value else { throw APIError(status: 0, code: "invalid_remote_item") }
            if case .dropped = continuation.yield(value) {
                // Never silently drop a journal item or acknowledge its cursor.
                continuation.finish(throwing: APIError(status: 0, code: "journal_overflow"))
                Task { await self.cancel(header.streamId) }
            }
        case "end":
            streams.removeValue(forKey: frame.streamId)?.finish()
            if streams.isEmpty { reset(CancellationError()) }
        case "error":
            guard let error = frame.error else { throw APIError(status: 0, code: "invalid_remote_error") }
            streams.removeValue(forKey: frame.streamId)?.finish(throwing: error)
            if streams.isEmpty { reset(CancellationError()) }
        default: throw APIError(status: 0, code: "invalid_remote_frame")
        }
    }

    private func failed(_ error: Error, socket task: URLSessionWebSocketTask, generation current: UUID) {
        guard current == generation else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let failure: Error = status == 401 ? APIError(status: 401, code: "unauthorized") : error
        reset(failure)
    }

    private func reset(_ error: Error) {
        generation = UUID()
        receiver?.cancel(); receiver = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        let active = streams.values; streams.removeAll()
        for continuation in active { continuation.finish(throwing: error) }
    }

    func cancel(_ id: String) async {
        guard let continuation = streams.removeValue(forKey: id) else { return }
        continuation.finish()
        // Closing the last carrier releases its Host Peer/observers too, and is
        // immediate even while the HTTP upgrade is still in flight.
        if streams.isEmpty { reset(CancellationError()); return }
        let task = socket
        if let task {
            let frame = RemoteJSON.object(["type": .string("cancel"), "streamId": .string(id)])
            if let data = try? JSONEncoder().encode(frame) { try? await task.send(.string(String(decoding: data, as: UTF8.self))) }
        }
        // A concurrent open during send must keep its socket alive.
        if streams.isEmpty { reset(CancellationError()) }
    }

    public func close() { disposed = true; reset(CancellationError()) }
    public var activeStreams: Int { streams.count }
}

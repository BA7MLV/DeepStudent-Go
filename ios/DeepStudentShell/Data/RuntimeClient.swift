import Foundation

protocol DeepStudentRuntimeClient {
    func health() async throws -> HealthSnapshot
    func readiness() async throws -> ReadinessSnapshot
    func startRun(_ request: RunRequest) async throws -> RunAccepted
    func events(for run: RunAccepted) -> AsyncThrowingStream<RuntimeEvent, Error>
}

enum RuntimeClientError: LocalizedError {
    case invalidResponse
    case http(status: Int, message: String)
    case malformedURL
    case malformedEvent

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "The runtime returned an invalid response."
        case let .http(status, message): return "Runtime request failed (\(status)): \(message)"
        case .malformedURL: return "The runtime URL is invalid."
        case .malformedEvent: return "The runtime sent an unreadable stream event."
        }
    }
}

struct GoRuntimeClient: DeepStudentRuntimeClient {
    let baseURL: URL
    var session: URLSession = .shared

    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = ISO8601DateFormatter().date(from: value) {
                return date
            }
            throw RuntimeClientError.malformedEvent
        }
        return decoder
    }

    private var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private func endpoint(_ path: String) -> URL {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return baseURL.appendingPathComponent(trimmed)
    }

    private func resolve(_ url: URL) -> URL {
        guard url.scheme == nil else { return url }
        return URL(string: url.absoluteString, relativeTo: baseURL)?.absoluteURL ?? url
    }

    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        body: Encodable? = nil,
        as type: T.Type
    ) async throws -> T {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try encoder.encode(AnyEncodable(body))
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw RuntimeClientError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error.message
                ?? String(data: data, encoding: .utf8)
                ?? "Unknown runtime error"
            throw RuntimeClientError.http(status: response.statusCode, message: message)
        }
        return try decoder.decode(type, from: data)
    }

    func health() async throws -> HealthSnapshot {
        try await request(path: "healthz", as: HealthSnapshot.self)
    }

    func readiness() async throws -> ReadinessSnapshot {
        try await request(path: "readyz", as: ReadinessSnapshot.self)
    }

    func startRun(_ request: RunRequest) async throws -> RunAccepted {
        try await self.request(path: "api/v1/runs", method: "POST", body: request, as: RunAccepted.self)
    }

    func events(for run: RunAccepted) -> AsyncThrowingStream<RuntimeEvent, Error> {
        let url = resolve(run.eventsURL)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: url)
                    request.httpMethod = "GET"
                    request.timeoutInterval = .infinity
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let response = response as? HTTPURLResponse,
                          (200..<300).contains(response.statusCode) else {
                        throw RuntimeClientError.invalidResponse
                    }

                    var eventID = ""
                    var eventType = "message"
                    var dataLines: [String] = []

                    func emitBufferedEvent() {
                        guard !dataLines.isEmpty else { return }
                        let payload = dataLines.joined(separator: "\n").data(using: .utf8) ?? Data()
                        guard let event = try? decoder.decode(RuntimeEvent.self, from: payload) else {
                            continuation.finish(throwing: RuntimeClientError.malformedEvent)
                            return
                        }
                        continuation.yield(event)
                        eventID = ""
                        eventType = "message"
                        dataLines.removeAll(keepingCapacity: true)
                    }

                    for try await line in bytes.lines {
                        if line.isEmpty {
                            emitBufferedEvent()
                            continue
                        }
                        if line.hasPrefix(":") { continue }
                        if line.hasPrefix("id:") {
                            eventID = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("event:") {
                            eventType = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    emitBufferedEvent()
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

struct FixtureRuntimeClient: DeepStudentRuntimeClient {
    func health() async throws -> HealthSnapshot {
        HealthSnapshot(status: "ok", service: "fixture", version: "local", runtime: "fixture", requestID: nil, time: .now)
    }

    func readiness() async throws -> ReadinessSnapshot {
        ReadinessSnapshot(status: "ready", requestID: nil)
    }

    func startRun(_ request: RunRequest) async throws -> RunAccepted {
        RunAccepted(
            runID: "fixture-run-\(UUID().uuidString)",
            sessionID: request.sessionID,
            eventsURL: URL(string: "fixture://run/events")!,
            requestID: "fixture-request"
        )
    }

    func events(for run: RunAccepted) -> AsyncThrowingStream<RuntimeEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let now = Date()
                let answer = "Here's a compact way to think about it: start with the intuition, then test it with one example."
                let words = answer.split(separator: " ")
                continuation.yield(RuntimeEvent(id: "fixture-start", runID: run.runID, type: "run.started", delta: nil, text: nil, errorCode: nil, errorMessage: nil, done: false, createdAt: now))
                for (index, word) in words.enumerated() {
                    try? await Task.sleep(for: .milliseconds(35))
                    continuation.yield(RuntimeEvent(id: "fixture-delta-\(index)", runID: run.runID, type: "message.delta", delta: "\(word) ", text: nil, errorCode: nil, errorMessage: nil, done: false, createdAt: now))
                }
                continuation.yield(RuntimeEvent(id: "fixture-complete", runID: run.runID, type: "run.completed", delta: nil, text: answer, errorCode: nil, errorMessage: nil, done: true, createdAt: .now))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private struct ErrorEnvelope: Decodable {
    let error: Detail

    struct Detail: Decodable {
        let message: String
    }
}

private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void

    init(_ value: Encodable) {
        self.encodeClosure = { encoder in try value.encode(to: encoder) }
    }

    func encode(to encoder: Encoder) throws {
        try encodeClosure(encoder)
    }
}

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct APIError: Error, LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String
    public init(status: Int, code: String) { self.status = status; self.code = code }

    public var errorDescription: String? {
        switch code {
        case "invalid_credentials": return "密码不正确，请重试或查看忘记密码帮助"
        case "unauthorized": return "登录已过期，请重新登录"
        case "token_login_unsupported": return "这个服务端版本还不支持 App 登录，请先升级服务端"
        case "network": return "连不上服务器"
        default: return code
        }
    }
}

/// All data comes from Host. Native UI uses the existing account Cookie session;
/// legacy bearer clients remain explicit and are never converted to Worker auth.
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let lock = NSLock()
    private var _token: String?
    private var _remote: RemoteConnection?
    private var _sessionCookie: String?
    public var sessionCookie: String? { lock.lock(); defer { lock.unlock() }; return _sessionCookie }

    public var token: String? {
        get { lock.lock(); defer { lock.unlock() }; return _token }
        set {
            lock.lock()
            let previous = _remote
            _remote = nil
            _token = newValue
            lock.unlock()
            if let previous { Task { await previous.close() } }
        }
    }

    public init(baseURL: URL, token: String? = nil, session: URLSession? = nil, sessionCookie: String? = nil) {
        self.baseURL = baseURL
        self._token = token
        self.session = session ?? URLSession(configuration: .ephemeral)
        self._sessionCookie = sessionCookie
    }

    // MARK: - 请求

    func makeRequest(_ path: String, method: String = "GET", body: Encodable? = nil) throws -> URLRequest {
        guard let url = URL(string: "api/v1" + path, relativeTo: baseURL.appendingSlash) else {
            throw APIError(status: 0, code: "invalid_url")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let sessionCookie { request.setValue("wangke_session=\(sessionCookie)", forHTTPHeaderField: "Cookie") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        return request
    }

    func send<T: Decodable>(_ request: URLRequest, as type: T.Type = T.self) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError(status: 0, code: "network")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let code = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "http_\(status)"
            throw APIError(status: status, code: code)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - 鉴权

    public func health() async throws -> ServerHealth {
        try await send(makeRequest("/health"))
    }

    /// 访问密码换 token。成功后自动带在后续请求上。
    public func login(password: String, deviceName: String) async throws -> TokenGrant {
        let health = try await health()
        if let auth = health.auth, !auth.contains("token") {
            throw APIError(status: 0, code: "token_login_unsupported")
        }
        let grant: TokenGrant = try await send(makeRequest("/auth/token", method: "POST", body: [
            "password": password, "deviceName": deviceName,
        ]))
        token = grant.token
        return grant
    }

    /// Existing account password/session endpoint, not a new native protocol.
    /// Persist only the opaque HttpOnly session value in the existing Keychain.
    public func loginSession(password: String) async throws -> WangkeUser {
        let body: SessionLoginBody = try await send(makeRequest("/auth/password/login", method: "POST", body: ["password": password]))
        let cookies = session.configuration.httpCookieStorage?.cookies(for: baseURL) ?? []
        guard let cookie = cookies.first(where: { $0.name == "wangke_session" }), !cookie.value.isEmpty else {
            throw APIError(status: 0, code: "session_cookie_missing")
        }
        setSessionCookie(cookie.value)
        token = nil
        return body.user
    }

    private func setSessionCookie(_ value: String?) { lock.lock(); _sessionCookie = value; lock.unlock() }

    public func logout() async {
        await disconnectRemote()
        _ = try? await send(makeRequest("/auth/logout", method: "POST"), as: OkBody.self)
        token = nil
        setSessionCookie(nil)
    }

    public func currentUser() async throws -> WangkeUser? {
        let session: SessionBody = try await send(makeRequest("/auth/session"))
        return session.authenticated ? session.user : nil
    }

    // MARK: - 线程与消息

    public func threads() async throws -> [ThreadSummary] {
        let body: ThreadsBody = try await send(makeRequest("/threads"))
        return body.threads.filter { $0.mode == .bot }
    }

    public func thread(_ id: String) async throws -> ThreadDetail {
        try await send(makeRequest("/threads/\(id.urlPathEscaped)"))
    }

    public func createThread(title: String? = nil) async throws -> ThreadSummary {
        var body: [String: String] = ["mode": "bot"]
        if let title { body["title"] = title }
        return try await send(makeRequest("/threads", method: "POST", body: body))
    }

    public func sendText(_ content: String, to threadId: String, nonce: String = UUID().uuidString) async throws -> Message {
        try await send(makeRequest("/threads/\(threadId.urlPathEscaped)/messages", method: "POST", body: [
            "clientNonce": nonce, "role": "user", "kind": "text", "content": content,
        ]))
    }

    public func stop(threadId: String) async throws {
        _ = try await send(makeRequest("/threads/\(threadId.urlPathEscaped)/stop", method: "POST"), as: StopBody.self)
    }

    public func resolveApproval(_ id: String, approved: Bool) async throws -> Approval {
        try await send(makeRequest("/approvals/\(id.urlPathEscaped)/resolve", method: "POST", body: ApprovalBody(approved: approved)))
    }

    public func react(messageId: String, reaction: String = "👍") async throws {
        _ = try await send(makeRequest("/messages/\(messageId.urlPathEscaped)/reactions", method: "POST", body: ["reaction": reaction]), as: ReactionBody.self)
    }

    public func botSnapshot(threadId: String) async throws -> BotSnapshot {
        try await send(makeRequest("/threads/\(threadId.urlPathEscaped)/snapshot"))
    }

    public func botMessages(threadId: String, beforeSeq: Int) async throws -> BotMessagePage {
        try await send(makeRequest("/threads/\(threadId.urlPathEscaped)/messages?beforeSeq=\(beforeSeq)&limit=50"))
    }

    /// Formal generated unary Remote. Correlation IDs and error envelopes are
    /// DSH Connection's, not an ad-hoc REST RPC dialect.
    public func receipt(operationId: String) async throws -> RuntimeReceipt {
        let rpcId = UUID().uuidString
        var request = try makeRequest("/unused")
        request.url = URL(string: "api/clientRuntime/receipt", relativeTo: baseURL.appendingSlash)!.absoluteURL
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RemoteJSON.object([
            "type": .string("client-request"), "rpcId": .string(rpcId), "method": .string("clientRuntime/receipt"),
            "payload": .object(["args": .object(["operationId": .string(operationId)])])]))
        let response: ReceiptResponse = try await send(request)
        guard response.type == "server-response", response.rpcId == rpcId else { throw APIError(status: 0, code: "invalid_remote_response") }
        if response.result.ok, let value = response.result.value { return value }
        if let error = response.result.error { throw error }
        throw APIError(status: 0, code: "invalid_remote_response")
    }

    public func botState(threadId: String, fromSeq: Int, toSeq: Int) async throws -> BotSyncState {
        try await send(makeRequest("/threads/\(threadId.urlPathEscaped)/sync-state?fromSeq=\(fromSeq)&toSeq=\(toSeq)"))
    }

    /// One mux per APIClient/account. Cookie sessions use the same URLSession;
    /// native token login additionally supplies Authorization on the upgrade.
    public func remoteConnection() throws -> RemoteConnection {
        lock.lock(); defer { lock.unlock() }
        if let remote = _remote { return remote }
        var request = URLRequest(url: URL(string: "api/remote.mux", relativeTo: baseURL.appendingSlash)!.absoluteURL)
        var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: true)!
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        request.url = parts.url
        if let token = _token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let cookie = _sessionCookie { request.setValue("wangke_session=\(cookie)", forHTTPHeaderField: "Cookie") }
        let remote = RemoteConnection(request: request, session: session)
        _remote = remote
        return remote
    }

    private func takeRemote() -> RemoteConnection? {
        lock.lock(); defer { lock.unlock() }
        let remote = _remote; _remote = nil; return remote
    }

    public func disconnectRemote() async {
        await takeRemote()?.close()
    }
}

// MARK: - 内部 DTO

struct ErrorBody: Decodable { let error: String }
struct OkBody: Decodable { let ok: Bool? }
struct StopBody: Decodable { let stopped: Int }
struct ReactionBody: Decodable { let active: Bool }
struct ThreadsBody: Decodable { let threads: [ThreadSummary] }
struct SessionBody: Decodable { let authenticated: Bool; let user: WangkeUser? }
struct SessionLoginBody: Decodable { let user: WangkeUser }
struct ApprovalBody: Encodable { let approved: Bool }

struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

extension URL {
    var appendingSlash: URL {
        absoluteString.hasSuffix("/") ? self : URL(string: absoluteString + "/") ?? self
    }
}

extension String {
    var urlPathEscaped: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? self
    }
}

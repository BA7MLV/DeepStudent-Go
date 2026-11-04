#if canImport(SwiftUI) && canImport(Observation)
import Foundation
import Observation
import WangkeKit

/// 整个壳层的状态：登录凭据、线程列表、打开的线程。界面只读它、调它的方法，不直接碰网络。
@MainActor
@Observable
public final class AppModel {
    public private(set) var credential: StoredCredential?
    public private(set) var threads: [ThreadSummary] = []
    public private(set) var details: [String: ThreadDetail] = [:]
    public var errorMessage: String?
    public private(set) var hasOlder: [String: Bool] = [:]

    private var client: APIClient?
    private let store: TokenStore
    private var streams: [String: Task<Void, Never>] = [:]
    private var generation = UUID()
    private var loginGeneration = UUID()
    private var streamGenerations: [String: UUID] = [:]
    private var olderMessages: [String: [Message]] = [:]
    private var baselines: [String: UUID] = [:]
    private var olderLoading: Set<String> = []

    public init(store: TokenStore) {
        self.store = store
        if let saved = store.load() {
            credential = saved
            client = APIClient(baseURL: saved.serverURL, token: saved.sessionCookie == nil ? saved.token : nil, sessionCookie: saved.sessionCookie)
        }
    }

    public var isSignedIn: Bool { credential != nil }

    // MARK: - 登录

    public func signIn(server: String, password: String, deviceName: String) async throws {
        let attempt = UUID()
        loginGeneration = attempt
        guard let url = Self.normalizedServerURL(server) else {
            throw APIError(status: 0, code: "服务器地址不对")
        }
        let client = APIClient(baseURL: url)
        let user = try await client.loginSession(password: password)
        guard loginGeneration == attempt else { await client.logout(); throw CancellationError() }
        let credential = StoredCredential(serverURL: url, token: "", user: user, sessionCookie: client.sessionCookie)
        let previous = self.client
        generation = UUID()
        streams.values.forEach { $0.cancel() }
        streams = [:]; streamGenerations = [:]; details = [:]; threads = []
        olderMessages = [:]; baselines = [:]; hasOlder = [:]; olderLoading = []
        store.save(credential)
        self.client = client
        self.credential = credential
        await previous?.disconnectRemote()
        await refreshThreads()
    }

    public func signOut() async {
        let previous = client
        loginGeneration = UUID()
        generation = UUID()
        streams.values.forEach { $0.cancel() }
        streams = [:]
        streamGenerations = [:]
        store.clear()
        client = nil
        credential = nil
        threads = []
        details = [:]
        olderMessages = [:]; baselines = [:]; hasOlder = [:]; olderLoading = []
        await previous?.logout()
    }

    /// 补全协议、去掉末尾斜杠。没写协议时默认 https。
    public nonisolated static func normalizedServerURL(_ input: String) -> URL? {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if !value.contains("://") { value = "https://" + value }
        while value.hasSuffix("/") { value.removeLast() }
        guard let url = URL(string: value), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else { return nil }
        return url
    }

    // MARK: - 数据

    public func refreshThreads() async {
        guard let client else { return }
        let current = generation
        do {
            let result = try await client.threads()
            guard generation == current else { return }
            threads = result
        } catch let error as APIError where error.status == 401 {
            if generation == current { await expire() }
        } catch {
            if generation == current { errorMessage = error.localizedDescription }
        }
    }

    public func newThread() async -> ThreadSummary? {
        guard let client else { return nil }
        let current = generation
        do {
            let thread = try await client.createThread(title: "新的 Bot 任务")
            guard generation == current else { return nil }
            threads.insert(thread, at: 0)
            details[thread.id] = ThreadDetail(id: thread.id, mode: thread.mode, title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt, messages: [], approvals: [])
            return thread
        } catch {
            await commandError(error, account: current)
            return nil
        }
    }

    /// Snapshot and durable journal share an applied watermark. Every open uses
    /// the account's one mux; closing only releases this thread's observer.
    public func open(_ threadId: String) async {
        guard let client else { return }
        guard streams[threadId] == nil else { return }
        let account = generation
        let incarnation = UUID()
        streamGenerations[threadId] = incarnation
        streams[threadId] = Task { [weak self] in
            do {
                try await BotFollower.run(client: client, threadId: threadId) { [weak self] projection in
                    await self?.receive(projection, threadId: threadId, account: account, incarnation: incarnation)
                }
            } catch is CancellationError {
                // Disappear/account changes release observation, never stop a run.
            } catch {
                guard let self, self.generation == account, self.streamGenerations[threadId] == incarnation else { return }
                if let api = error as? APIError, api.status == 401 { await self.expire() }
                else { self.errorMessage = error.localizedDescription }
            }
            guard let self, self.generation == account, self.streamGenerations[threadId] == incarnation else { return }
            self.streams[threadId] = nil
            self.streamGenerations[threadId] = nil
        }
    }

    public func close(_ threadId: String) {
        streams[threadId]?.cancel()
        streams[threadId] = nil
        streamGenerations[threadId] = nil
    }

    private func receive(_ projection: BotProjection, threadId: String, account: UUID, incarnation: UUID) {
        guard generation == account, streamGenerations[threadId] == incarnation else { return }
        var detail = projection.detail
        if baselines[threadId] != projection.baselineID {
            olderMessages[threadId] = nil
            baselines[threadId] = projection.baselineID
            hasOlder[threadId] = projection.hasOlder
        }
        var messages = olderMessages[threadId] ?? []
        for message in detail.messages { messages = MessageGrouping.merge(message, into: messages) }
        detail.messages = messages
        for pending in details[threadId]?.messages.filter({ $0.id.hasPrefix("pending-") }) ?? [] {
            if !detail.messages.contains(where: { $0.clientNonce == pending.clientNonce }) {
                detail.messages = MessageGrouping.merge(pending, into: detail.messages)
            }
        }
        details[threadId] = detail
    }

    public func loadOlder(_ threadId: String) async {
        guard let client, hasOlder[threadId] == true, !olderLoading.contains(threadId),
              let first = details[threadId]?.messages.first?.seq else { return }
        let account = generation
        let baseline = baselines[threadId]
        olderLoading.insert(threadId)
        defer { if generation == account { olderLoading.remove(threadId) } }
        do {
            let page = try await client.botMessages(threadId: threadId, beforeSeq: first)
            guard generation == account, baselines[threadId] == baseline else { return }
            var messages = olderMessages[threadId] ?? []
            for message in page.messages { messages = MessageGrouping.merge(message, into: messages) }
            olderMessages[threadId] = messages
            if var detail = details[threadId] {
                for message in detail.messages { messages = MessageGrouping.merge(message, into: messages) }
                detail.messages = messages
                let existing = Set((detail.approvals ?? []).map(\.id))
                detail.approvals = (detail.approvals ?? []) + page.approvals.filter { !existing.contains($0.id) }
                details[threadId] = detail
            }
            hasOlder[threadId] = page.hasOlder
        } catch { await commandError(error, account: account) }
    }

    private func apply(_ message: Message, to threadId: String) {
        guard var detail = details[threadId] else { return }
        detail.messages = MessageGrouping.merge(message, into: detail.messages)
        details[threadId] = detail
    }

    public func send(_ text: String, to threadId: String) async -> Bool {
        guard let client else { return false }
        let account = generation
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return false }
        let nonce = UUID().uuidString
        // 先放一条本地气泡，服务端确认后按 clientNonce 替换。
        let pending = Message(id: "pending-\(nonce)", threadId: threadId, clientNonce: nonce, seq: Int.max, role: .user, kind: .text, content: content, createdAt: ISO8601DateFormatter().string(from: Date()), replyTo: nil)
        apply(pending, to: threadId)
        do {
            let sent = try await client.sendText(content, to: threadId, nonce: nonce)
            guard generation == account else { return false }
            apply(sent, to: threadId)
            return true
        } catch {
            guard generation == account else { return false }
            details[threadId]?.messages.removeAll { $0.id == pending.id }
            await commandError(error, account: account)
            return false
        }
    }

    public func resolve(_ approval: Approval, approved: Bool) async {
        guard let client else { return }
        let account = generation
        do {
            let resolved = try await client.resolveApproval(approval.id, approved: approved)
            guard generation == account else { return }
            if var detail = details[approval.threadId] {
                detail.approvals = detail.approvals?.map { $0.id == resolved.id ? resolved : $0 }
                details[approval.threadId] = detail
            }
        } catch {
            await commandError(error, account: account)
        }
    }

    public func react(to message: Message) async {
        guard let client else { return }
        let account = generation
        do { try await client.react(messageId: message.id) }
        catch { await commandError(error, account: account) }
    }

    public func stop(_ threadId: String) async {
        guard let client else { return }
        let account = generation
        do { try await client.stop(threadId: threadId) }
        catch { await commandError(error, account: account) }
    }

    private func commandError(_ error: Error, account: UUID) async {
        guard generation == account else { return }
        if let api = error as? APIError, api.status == 401 { await expire() }
        else { errorMessage = error.localizedDescription }
    }

    private func expire() async {
        let previous = client
        generation = UUID()
        loginGeneration = UUID()
        errorMessage = APIError(status: 401, code: "unauthorized").localizedDescription
        store.clear()
        streams.values.forEach { $0.cancel() }
        streams = [:]
        streamGenerations = [:]
        threads = []; details = [:]
        olderMessages = [:]; baselines = [:]; hasOlder = [:]; olderLoading = []
        client = nil
        credential = nil
        await previous?.disconnectRemote()
    }
}
#endif

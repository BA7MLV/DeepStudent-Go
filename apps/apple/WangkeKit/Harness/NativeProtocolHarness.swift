import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import WangkeKit
import WangkeUI

struct CheckFailure: Error, CustomStringConvertible { let description: String }
func check(_ condition: Bool, _ label: String) throws {
    if !condition { throw CheckFailure(description: label) }
}
func timeout<T: Sendable>(_ label: String, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask { try await Task.sleep(nanoseconds: 12_000_000_000); throw CheckFailure(description: "Timeout: \(label)") }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}
func until(_ label: String, _ condition: @escaping @Sendable () async -> Bool) async throws {
    try await timeout(label) {
        while !(await condition()) { try await Task.sleep(nanoseconds: 20_000_000) }
    }
}
actor ProjectionProbe {
    var values: [BotProjection] = []
    var failure: Error?
    var done = false
    func append(_ value: BotProjection) { values.append(value) }
    func finish(_ error: Error?) { failure = error; done = true }
    func contains(_ content: String) -> Bool { values.last?.detail.messages.contains { $0.content == content } ?? false }
    func cursor() -> Int { values.last?.cursor ?? 0 }
    func baselines() -> Int { Set(values.map(\.baselineID)).count }
    func status() -> Int { (failure as? APIError)?.status ?? 0 }
}
struct Fixture: Decodable {
    let snapshot: BotSnapshot
    let frames: [BotJournalFrame]
    let invalid: [String]
    let states: [BotSyncState]
}

@main struct NativeProtocolHarness {
    static func main() async throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        var projection = try BotProjection(snapshot: fixture.snapshot)
        for frame in fixture.frames { _ = try projection.apply(frame) }
        try check(projection.cursor == 12, "applied watermark and global cursor gaps")
        try check(projection.detail.messages.last?.content == "updated", "typed message apply")
        for invalid in fixture.invalid {
            do { _ = try JSONDecoder().decode(BotJournalFrame.self, from: Data(invalid.utf8)); throw CheckFailure(description: "invalid frame accepted") }
            catch is CheckFailure { throw CheckFailure(description: "invalid frame accepted") }
            catch { }
        }
        let resync = try JSONDecoder().decode(BotJournalFrame.self, from: Data(#"{"type":"event","cursor":12,"event":{"type":"resync.required"}}"#.utf8))
        do { _ = try projection.apply(resync); throw CheckFailure(description: "resync was acknowledged") }
        catch let error as APIError { try check(error.code == "journal_resync", "resync signal") }
        try check(projection.cursor == 12, "resync never advances watermark")
        for state in fixture.states { try projection.applyState(state) }
        try check(projection.stateCursor == 20 && projection.activityCursor == 20, "old state cannot regress watermarks")
        try check(projection.activity?.completedTools == 3 && projection.cursor == 12, "state/activity do not acknowledge unapplied journal events")
        print("PASS generated Bot codec fixtures, malformed rejection, duplicate/global-gap ordering and resync watermark")

        guard let raw = ProcessInfo.processInfo.environment["WANGKE_NATIVE_URL"], let base = URL(string: raw),
              let secret = ProcessInfo.processInfo.environment["WANGKE_NATIVE_CONTROL"] else { return }
        try await live(base: base, secret: secret)
    }

    static func control(_ base: URL, _ secret: String, _ action: String, thread: String = "", content: String = "") async throws -> [String: RemoteJSON] {
        var request = URLRequest(url: base.appendingPathComponent("__native/control"))
        request.httpMethod = "POST"
        request.setValue(secret, forHTTPHeaderField: "x-native-control")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action, "thread": thread, "content": content])
        let (data, response) = try await URLSession.shared.data(for: request)
        try check((response as? HTTPURLResponse)?.statusCode == 200, "fixture control \(action)")
        return try JSONDecoder().decode([String: RemoteJSON].self, from: data)
    }

    static func next(_ subscription: BotSubscription) async throws -> BotJournalFrame {
        try await timeout("journal frame") {
            var iterator = subscription.frames.makeAsyncIterator()
            guard let value = try await iterator.next() else { throw CheckFailure(description: "unexpected journal end") }
            return value
        }
    }

    static func live(base: URL, secret: String) async throws {
        let bearer = APIClient(baseURL: base)
        let grant = try await bearer.login(password: "native-fixture-password-123", deviceName: "isolated native harness")
        let user = try await bearer.currentUser()
        try check(user?.id == grant.user.id, "real bearer principal")
        let bearerReceipt = try await bearer.receipt(operationId: "native-missing-operation-0001")
        try check(bearerReceipt.status == .missing, "account Bearer must enter account Remote domain")
        print("PASS native account Bearer admitted by Remote Host")
        let client = APIClient(baseURL: base)
        let sessionUser = try await client.loginSession(password: "native-fixture-password-123")
        try check(sessionUser.id == grant.user.id && client.sessionCookie != nil, "native account session login")
        let receipt = try await client.receipt(operationId: "native-missing-operation-0001")
        try check(receipt.status == .missing, "DSH unary envelope/args/rpcId/result")
        do { _ = try await client.receipt(operationId: "bad"); throw CheckFailure(description: "bad command ID accepted") }
        catch let error as RemoteFailure { try check(error.code == "gateway/bad-request", "typed unary error envelope") }
        let first = try await client.createThread(title: "native one")
        let second = try await client.createThread(title: "native two")
        let remote = try client.remoteConnection()
        let a = try await remote.watchBot(threadId: first.id, after: 0)
        let b = try await remote.watchBot(threadId: second.id, after: 0)
        try check(try await next(a).type == .ready, "first ready")
        try check(try await next(b).type == .ready, "second ready")
        let stats = try await control(base, secret, "stats")
        try check(stats["upgrades"] == .number(1), "two logical streams share one physical socket")
        await a.cancel()
        _ = try await control(base, secret, "append", thread: second.id, content: "live")
        let live = try await next(b)
        if case .message(let message) = live.event { try check(message.content == "live", "real pushed message") }
        else { throw CheckFailure(description: "expected message") }
        let resumed = try await remote.watchBot(threadId: second.id, after: 0)
        _ = try await next(resumed)
        let replay = try await next(resumed)
        try check(replay.cursor == live.cursor, "durable replay starts after applied cursor")
        await resumed.cancel()
        let forbidden = try await remote.watchBot(threadId: "native-other-account-thread", after: 0)
        do { _ = try await next(forbidden); throw CheckFailure(description: "cross-account journal allowed") }
        catch let error as RemoteFailure { try check(error.code == "client/forbidden", "typed forbidden error") }
        await forbidden.cancel()
        let active = await remote.activeStreams
        try check(active == 1, "logical cancel/error leaves other observer active")
        let slow = try await remote.watchBot(threadId: first.id, after: 0)
        _ = try await control(base, secret, "burst", thread: first.id)
        try await Task.sleep(nanoseconds: 500_000_000)
        do {
            try await timeout("bounded slow consumer") {
                for try await _ in slow.frames { /* deliberately drain only after overflow */ }
            }
            throw CheckFailure(description: "slow consumer silently dropped frames")
        } catch let error as APIError { try check(error.code == "journal_overflow", "overflow is explicit and recoverable") }
        await slow.cancel()
        try check(await remote.activeStreams == 1, "overflow releases only slow logical observer")
        print("PASS bounded native slow-consumer overflow fails explicitly without cursor acknowledgement")
        let beforeIdle = try await control(base, secret, "stats")
        try await Task.sleep(nanoseconds: 1_200_000_000)
        let afterIdle = try await control(base, secret, "stats")
        try check(beforeIdle["businessRequests"] == afterIdle["businessRequests"], "idle journal has zero business HTTP polling")
        await b.cancel()
        let empty = await remote.activeStreams
        try check(empty == 0, "last cancel releases connection")
        print("PASS real account auth, DSH unary, two logical streams/one mux, durable replay, forbidden scope, cancellation and idle zero HTTP")

        // Browser-style session cookies must authenticate BOTH unary and upgrade.
        let session = URLSession(configuration: .ephemeral)
        var login = URLRequest(url: base.appendingPathComponent("api/v1/auth/password/login"))
        login.httpMethod = "POST"; login.setValue("application/json", forHTTPHeaderField: "content-type")
        login.httpBody = Data(#"{"password":"native-fixture-password-123"}"#.utf8)
        let (_, response) = try await session.data(for: login)
        try check((response as? HTTPURLResponse)?.statusCode == 200, "cookie login")
        let cookieClient = APIClient(baseURL: base, session: session)
        try check(try await cookieClient.currentUser()?.id == grant.user.id, "cookie unary identity")
        let cookieStream = try await cookieClient.remoteConnection().watchBot(threadId: first.id, after: 0)
        _ = try await next(cookieStream)
        await cookieStream.cancel()
        await cookieClient.disconnectRemote()
        print("PASS real Cookie/session identity shared by HTTP and URLSession WebSocket upgrade")

        _ = try await control(base, secret, "arm-race", thread: first.id)
        let probe = ProjectionProbe()
        let follower = Task {
            do {
                try await BotFollower.run(client: client, threadId: first.id) { await probe.append($0) }
                await probe.finish(nil)
            } catch { await probe.finish(error) }
        }
        try await until("snapshot/open concurrent commit") { await probe.contains("snapshot-open-race") }
        let beforeDrop = await probe.cursor()
        _ = try await control(base, secret, "disconnect")
        _ = try await control(base, secret, "append", thread: first.id, content: "after-disconnect")
        try await until("WS reconnect replays durable update") { await probe.contains("after-disconnect") }
        try check(await probe.cursor() > beforeDrop, "reconnect cursor advanced after apply")
        let beforeGap = await probe.baselines()
        _ = try await control(base, secret, "gap", thread: first.id)
        try await until("retained cursor gap rebuild") {
            let contains = await probe.contains("gap-rebuilt")
            let count = await probe.baselines()
            return contains && count > beforeGap
        }
        print("PASS atomic snapshot/open race, disconnect/resume and Host retained-gap resync -> new snapshot")

        // Test SwiftUI adapter's actual account/observer generation guards with a
        // held old snapshot response, not a mock implementation of its guards.
        #if canImport(SwiftUI)
        try await generationTest(base: base, secret: secret, grant: grant, thread: second.id)
        try await paginationTest(base: base, secret: secret, thread: first.id)
        #endif

        _ = try await control(base, secret, "expire")
        try await until("automatic authentication lease expiry") { await probe.done }
        try check(await probe.status() == 401, "expired live socket is terminal unauthorized, no fallback")
        follower.cancel(); await follower.value
        await client.disconnectRemote()
        print("PASS automatic live credential expiry terminates follower; no SSE or polling fallback")
    }

    #if canImport(SwiftUI)
    @MainActor static func paginationTest(base: URL, secret: String, thread: String) async throws {
        let client = APIClient(baseURL: base)
        let user = try await client.loginSession(password: "native-fixture-password-123")
        let model = AppModel(store: MemoryTokenStore(StoredCredential(serverURL: base, token: "", user: user, sessionCookie: client.sessionCookie)))
        await model.open(thread)
        try await until("bounded native initial page") { await MainActor.run { model.details[thread]?.messages.count == 50 } }
        try check(model.hasOlder[thread] == true, "older pages exposed")
        await model.loadOlder(thread)
        try check(model.details[thread]?.messages.count == 100, "explicit 50-row older page")
        _ = try await control(base, secret, "append", thread: thread, content: "page-live")
        try await until("live frame after older-page load") { await MainActor.run { model.details[thread]?.messages.last?.content == "page-live" } }
        try check(model.details[thread]?.messages.count == 101, "journal update preserves explicit older window")
        model.close(thread)
        await model.signOut()
        print("PASS actual SwiftUI AppModel bounded snapshot, explicit older page and stable window after live update")
    }

    @MainActor static func generationTest(base: URL, secret: String, grant: TokenGrant, thread: String) async throws {
        let isolated = APIClient(baseURL: base)
        let ownUser = try await isolated.loginSession(password: "native-fixture-password-123")
        let model = AppModel(store: MemoryTokenStore(StoredCredential(serverURL: base, token: "", user: ownUser, sessionCookie: isolated.sessionCookie)))
        _ = try await control(base, secret, "hold-snapshot", thread: thread)
        await model.open(thread)
        try await until("old snapshot held") { (try? await control(base, secret, "stats"))?["held"] == .bool(true) }
        model.close(thread)
        _ = try await control(base, secret, "append", thread: thread, content: "new-generation")
        await model.open(thread)
        try await until("new incarnation publishes") { await MainActor.run { model.details[thread]?.messages.contains { $0.content == "new-generation" } ?? false } }
        _ = try await control(base, secret, "release-snapshot")
        try await Task.sleep(nanoseconds: 150_000_000)
        try check(model.details[thread]?.messages.contains { $0.content == "new-generation" } == true, "late old snapshot cannot replace new generation")
        await model.signOut()
        try check(model.details.isEmpty && !model.isSignedIn, "account disposal clears state")
        print("PASS actual SwiftUI AppModel close/reopen late-snapshot generation guard and account disposal")
    }
    #endif
}

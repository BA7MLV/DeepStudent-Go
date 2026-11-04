import XCTest
@testable import WangkeKit

/// Optional account-only smoke; never submits a Bot run/model/IM request.
/// 默认跳过；设置 WANGKE_E2E_URL 和 WANGKE_E2E_PASSWORD 后运行：
///   WANGKE_E2E_URL=http://127.0.0.1:3000 WANGKE_E2E_PASSWORD=… swift test --filter LiveServerTests
final class LiveServerTests: XCTestCase {
    func testLoginThreadJournalLogout() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["WANGKE_E2E_URL"], let url = URL(string: raw), let password = env["WANGKE_E2E_PASSWORD"] else {
            throw XCTSkip("WANGKE_E2E_URL / WANGKE_E2E_PASSWORD not set")
        }
        let client = APIClient(baseURL: url)
        do {
            _ = try await client.loginSession(password: "wrong-password")
            XCTFail("wrong password should fail")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "invalid_credentials")
        }
        let user = try await client.loginSession(password: password)
        let savedCookie = client.sessionCookie
        XCTAssertNotNil(savedCookie)
        let me = try await client.currentUser()
        XCTAssertEqual(me?.id, user.id)

        let thread = try await client.createThread(title: "Swift E2E")
        let threads = try await client.threads()
        XCTAssertTrue(threads.contains { $0.id == thread.id })
        let subscription = try await client.remoteConnection().watchBot(threadId: thread.id, after: 0)
        var found = false
        for try await frame in subscription.frames {
            if frame.type == .ready { found = true; break }
        }
        await subscription.cancel()
        XCTAssertTrue(found)
        let snapshot = try await client.botSnapshot(threadId: thread.id)
        XCTAssertEqual(snapshot.id, thread.id)

        await client.logout()
        let stale = APIClient(baseURL: url, sessionCookie: savedCookie)
        do {
            _ = try await stale.threads()
            XCTFail("revoked token should be rejected")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 401)
        }
    }
}

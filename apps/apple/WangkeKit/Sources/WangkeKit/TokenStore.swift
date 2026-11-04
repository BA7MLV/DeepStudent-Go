import Foundation
#if canImport(Security)
import Security
#endif

/// Session/token credentials stay in the existing Apple Keychain, never in a URL.
public protocol TokenStore: Sendable {
    func load() -> StoredCredential?
    func save(_ credential: StoredCredential)
    func clear()
}

public struct StoredCredential: Codable, Equatable, Sendable {
    public let serverURL: URL
    public let token: String
    /// New native logins use the same account session as Remote. Old saved
    /// bearer credentials remain decodable and are never mistaken for Worker tokens.
    public let sessionCookie: String?
    public let user: WangkeUser

    public init(serverURL: URL, token: String, user: WangkeUser, sessionCookie: String? = nil) {
        self.serverURL = serverURL
        self.token = token
        self.user = user
        self.sessionCookie = sessionCookie
    }
}

/// 测试和预览用。
public final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private var value: StoredCredential?
    private let lock = NSLock()
    public init(_ value: StoredCredential? = nil) { self.value = value }
    public func load() -> StoredCredential? { lock.lock(); defer { lock.unlock() }; return value }
    public func save(_ credential: StoredCredential) { lock.lock(); value = credential; lock.unlock() }
    public func clear() { lock.lock(); value = nil; lock.unlock() }
}

#if canImport(Security)
/// 钥匙串存整条凭据（JSON），只在本机解锁后可读，不随 iCloud 钥匙串同步。
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    private let account = "default"

    public init(service: String = "app.wangke.agent.credential") {
        self.service = service
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func load() -> StoredCredential? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(StoredCredential.self, from: data)
    }

    public func save(_ credential: StoredCredential) {
        guard let data = try? JSONEncoder().encode(credential) else { return }
        SecItemDelete(baseQuery as CFDictionary)
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    public func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
#endif

import Foundation
import Security

/// The paired app's key, in the Keychain on this iPhone only, readable after
/// the first unlock since a restart (so a reminder's Taken can send while
/// Rufi is closed). Not synced, not backed up to another device.
nonisolated enum Keychain {
    private static var item: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.mahesh.rufi",
            kSecAttrAccount as String: "door-key",
        ]
    }

    static func key() -> String? {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
              let data = found as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func save(_ key: String) -> Bool {
        forget()
        var add = item
        add[kSecValueData as String] = Data(key.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func forget() {
        SecItemDelete(item as CFDictionary)
    }
}

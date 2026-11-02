import Foundation

/// This iPhone's pairing with Rufi on a Mac, kept until it is unpaired. The
/// key itself is in the Keychain.
nonisolated struct Pairing: Codable, Equatable, Sendable {
    /// Rufi's door on the Mac.
    let origin: URL
    /// This app, as the Mac knows it.
    let app: String
    /// Whose record it opens.
    let person: Door.Person
    /// The Mac's name, as Rufi there gives it.
    let mac: String
    /// Rufi's data folder on the Mac.
    let folder: String

    private static let stored = "pairing"

    static func saved() -> Pairing? {
        UserDefaults.standard.data(forKey: stored).flatMap { try? JSONDecoder().decode(Pairing.self, from: $0) }
    }

    func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: Self.stored)
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: stored)
    }
}

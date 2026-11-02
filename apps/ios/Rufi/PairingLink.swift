import Foundation

/// A pairing link from Rufi on the Mac (Settings › iPhone):
/// `https://<the Mac's name>:<the door's port>/pair#code=<code>`, by the QR
/// code or pasted. Only `https`, so the code, and the key it is exchanged
/// for, never travel in the clear.
nonisolated struct PairingLink: Equatable, Sendable {
    /// Rufi's door on the Mac: where the app's calls and the screens go.
    let origin: URL
    /// The one-time code, used up by the first phone to pair with it.
    let code: String

    init?(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              url.scheme == "https",
              let host = url.host(), !host.isEmpty,
              url.user() == nil, url.password() == nil,
              url.path() == "/pair", url.query() == nil,
              let fragment = url.fragment(), fragment.hasPrefix("code=")
        else { return nil }
        let code = String(fragment.dropFirst("code=".count))
        let base64url = { (character: Character) in
            character.isASCII && (character.isLetter || character.isNumber || character == "-" || character == "_")
        }
        guard !code.isEmpty, code.allSatisfy(base64url) else { return nil }
        var parts = URLComponents()
        parts.scheme = "https"
        parts.host = host
        parts.port = url.port
        guard let origin = parts.url else { return nil }
        self.origin = origin
        self.code = code
    }
}

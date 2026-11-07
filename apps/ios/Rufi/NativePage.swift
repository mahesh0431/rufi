import Foundation

/// The pages the iPhone draws itself, by their address on the Mac; any
/// other address opens in Rufi's screens, until it is drawn here too. The
/// addresses are the Mac's, so a link in a reply opens the same page.
nonisolated enum NativePage: Equatable, Sendable {
    case overview
    /// A record page: its kind's rows.
    case list(String)
    /// One row opened: what it is, its sources and its history.
    case row(kind: String, id: String)
    case followUps

    /// The record pages drawn here.
    static let kinds: Set<String> = ["condition", "allergy", "symptom", "care_event"]

    /// The page at `path` when the iPhone draws it.
    static func of(_ path: String, person: String) -> NativePage? {
        guard let components = URLComponents(string: path) else { return nil }
        let opened = components.queryItems?.first { $0.name == "open" }?.value
        if components.path == "/" { return .overview }
        let at = "/people/\(person.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? person)/"
        guard components.path.hasPrefix(at) else { return nil }
        let rest = components.path.dropFirst(at.count).split(separator: "/", omittingEmptySubsequences: false)
        switch (rest.first, rest.count) {
        case ("follow-ups", 1):
            return opened.map { .row(kind: "follow_up", id: $0) } ?? .followUps
        case ("record", 2) where kinds.contains(String(rest[1])):
            return opened.map { .row(kind: String(rest[1]), id: $0) } ?? .list(String(rest[1]))
        default:
            return nil
        }
    }
}

import Foundation

/// The pages the iPhone draws itself, by their address on the Mac; any
/// other address opens in Rufi's screens, until it is drawn here too. The
/// addresses are the Mac's, so a link in a reply opens the same page.
nonisolated enum NativePage: Equatable, Sendable {
    case overview
    /// A record page: its kind's rows.
    case list(String)
    /// Lab results: each test once, by section.
    case labResults
    /// A test's page: its values.
    case test(String)
    /// A visit's page: the doctor's words and what was saved from it.
    case visit(String)
    /// One row opened: what it is, its sources and its history.
    case row(kind: String, id: String)
    case followUps

    /// The record pages drawn here.
    static let kinds: Set<String> = [
        "lab_result", "measurement", "medicine_use", "visit", "condition", "allergy", "symptom", "care_event",
    ]

    /// The page at `path` when the iPhone draws it.
    static func of(_ path: String, person: String) -> NativePage? {
        guard let components = URLComponents(string: path) else { return nil }
        let query = { (name: String) in components.queryItems?.first { $0.name == name }?.value }
        let opened = query("open")
        if components.path == "/" { return .overview }
        let at = "/people/\(person.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? person)/"
        guard components.path.hasPrefix(at) else { return nil }
        let rest = components.path.dropFirst(at.count).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        switch (rest.first, rest.count) {
        case ("follow-ups", 1):
            return opened.map { .row(kind: "follow_up", id: $0) } ?? .followUps
        case ("tests", 2):
            return opened.map { .row(kind: "result", id: $0) } ?? .test(rest[1])
        case ("visits", 2):
            return .visit(rest[1])
        case ("record", 2) where kinds.contains(rest[1]):
            let page = rest[1]
            guard let opened else { return page == "lab_result" ? .labResults : .list(page) }
            if page == "visit" { return .visit(opened) }
            // A row whose kind isn't its page's says so: a result, "No known allergies".
            return .row(kind: query("kind") ?? (page == "lab_result" || page == "measurement" ? "result" : page), id: opened)
        default:
            return nil
        }
    }
}

import Foundation

/// The four tabs, each with its first page in Rufi's screens.
nonisolated enum Tab: String, CaseIterable, Hashable, Sendable {
    case chat, medicines, record, documents

    var label: String {
        switch self {
        case .chat: "Chat"
        case .medicines: "Medicines"
        case .record: "Record"
        case .documents: "Documents"
        }
    }

    /// The title of the tab's first page.
    var title: String {
        self == .chat ? "Chat with Rufi" : label
    }

    var symbol: String {
        switch self {
        case .chat: "message"
        case .medicines: "pills"
        case .record: "heart.text.clipboard"
        case .documents: "doc.text"
        }
    }

    /// The tab's first page, for `person`.
    func root(_ person: String) -> String {
        let at = "/people/\(person.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? person)"
        return switch self {
        case .chat: "\(at)/chat"
        case .medicines: "\(at)/record/medicine_use"
        case .record: "/"
        case .documents: "\(at)/documents"
        }
    }
}

/// Where a page the person tapped opens: a tab's own first page switches to
/// that tab, back at its first page; any other page is pushed in the tab
/// they are in, so a result from a reply opens in Chat, with Back to it.
nonisolated enum Route: Equatable, Sendable {
    case tab(Tab)
    case push(String)

    static func of(_ path: String, person: String) -> Route {
        Tab.allCases.first { $0.root(person) == path }.map(Route.tab) ?? .push(path)
    }
}

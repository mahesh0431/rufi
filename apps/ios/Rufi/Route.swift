import Foundation

/// The places in the sidebar, in the Mac's order, each with its own page in
/// Rufi's screens. Settings is on the Mac only.
nonisolated enum Place: String, CaseIterable, Hashable, Sendable {
    case chat, overview
    case labResults = "lab_result", measurements = "measurement", medicines = "medicine_use", visits = "visit"
    case conditions = "condition", allergies = "allergy", symptoms = "symptom", careEvents = "care_event"
    case followUps, documents, help

    /// The health record's pages, under their heading.
    static let record: [Place] = [
        .labResults, .measurements, .medicines, .visits, .conditions, .allergies, .symptoms, .careEvents,
    ]

    /// Its name in the sidebar, and its page's title.
    var title: String {
        switch self {
        case .chat: "Chat with Rufi"
        case .overview: "Overview"
        case .labResults: "Lab results"
        case .measurements: "Measurements"
        case .medicines: "Medicines"
        case .visits: "Visits"
        case .conditions: "Conditions"
        case .allergies: "Allergies"
        case .symptoms: "Symptoms"
        case .careEvents: "Care events"
        case .followUps: "Follow-ups"
        case .documents: "Documents"
        case .help: "Help"
        }
    }

    var symbol: String {
        switch self {
        case .chat: "message"
        case .overview: "house"
        case .labResults: "flask"
        case .measurements: "ruler"
        case .medicines: "pills"
        case .visits: "stethoscope"
        case .conditions: "heart"
        case .allergies: "shield"
        case .symptoms: "waveform.path.ecg"
        case .careEvents: "syringe"
        case .followUps: "clock"
        case .documents: "doc.text"
        case .help: "questionmark.circle"
        }
    }

    /// Its page, for `person`.
    func path(_ person: String) -> String {
        let at = "/people/\(person.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? person)"
        return switch self {
        case .chat: "\(at)/chat"
        case .overview: "/"
        case .followUps: "\(at)/follow-ups"
        case .documents: "\(at)/documents"
        case .help: "/help"
        default: "\(at)/record/\(rawValue)"
        }
    }

    /// The place the sidebar marks for the page at `path`: the one whose
    /// page it is or is under, as the Mac's sidebar marks it (Overview only
    /// for itself). None for a page no place holds, such as a test.
    static func current(at path: String, person: String) -> Place? {
        let page = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return allCases.first { place in
            let own = place.path(person)
            return page == own || (place != .overview && page.hasPrefix(own + "/"))
        }
    }
}

/// Where a page the person tapped opens: a place's own page replaces what is
/// shown, as choosing it in the sidebar does; any other page opens on top,
/// with Back, so a result from a reply opens over the chat.
nonisolated enum Route: Equatable, Sendable {
    case place(Place)
    case push(String)

    static func of(_ path: String, person: String) -> Route {
        Place.allCases.first { $0.path(person) == path }.map(Route.place) ?? .push(path)
    }
}

/// One page in the stack. Its address and title can change as the page says.
struct Screen: Hashable, Identifiable {
    let id = UUID()
}

/// Where the person is in Rufi's pages: a place's own page, and the pages
/// opened on top of it. The chrome reads everything from here, and each
/// page says where it is as it draws (`drawn`), so the sidebar's current
/// place, the title and Back follow every move made inside the pages too:
/// a link in a reply, Ask Rufi, Back, a page opened on top.
struct Navigator {
    struct Page: Equatable {
        var path: String
        var title: String
    }

    let person: String
    /// The place's own page, at the bottom of the stack.
    private(set) var root = Screen()
    /// The pages opened on top of it, bottom first.
    var stack: [Screen] = []
    private(set) var pages: [Screen.ID: Page] = [:]

    init(person: String, at place: Place) {
        self.person = person
        pages[root.id] = Page(path: place.path(person), title: place.title)
    }

    /// The page on top.
    var top: Screen { stack.last ?? root }

    /// The place the sidebar marks: the page on top's, as it last said.
    var current: Place? {
        pages[top.id].flatMap { Place.current(at: $0.path, person: person) }
    }

    func page(_ screen: Screen) -> Page? {
        pages[screen.id]
    }

    func page(at id: Screen.ID) -> Page? {
        pages[id]
    }

    /// Every screen in the stack, bottom first.
    var screens: [Screen] { [root] + stack }

    /// A tap on a link to `path`: a place's page replaces what is shown, any
    /// other opens on top. Gives the screen that shows it.
    @discardableResult
    mutating func go(_ path: String) -> Screen {
        switch Route.of(path, person: person) {
        case let .place(place):
            return choose(place)
        case let .push(path):
            let screen = Screen()
            pages[screen.id] = Page(path: path, title: "")
            stack.append(screen)
            return screen
        }
    }

    /// A place chosen in the sidebar: its page, with nothing on top.
    @discardableResult
    mutating func choose(_ place: Place) -> Screen {
        root = Screen()
        stack = []
        pages = [root.id: Page(path: place.path(person), title: place.title)]
        return root
    }

    /// The page in `screen` drew at `path`, with its title.
    mutating func drawn(_ screen: Screen.ID, _ path: String, _ title: String) {
        guard pages[screen] != nil else { return }
        pages[screen] = Page(path: path, title: title)
    }

    /// Back, or the edge swipe: what is left of the stack.
    mutating func popped(to stack: [Screen]) {
        self.stack = stack
        let kept = Set(screens.map(\.id))
        pages = pages.filter { kept.contains($0.key) }
    }
}

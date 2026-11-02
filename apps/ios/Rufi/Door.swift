import Foundation

/// The app's own calls to Rufi's door on the Mac, each with the paired
/// app's key. Redirects are never followed. Small calls wait 20 seconds.
nonisolated struct Door: Sendable {
    /// The shape of the calls this app makes; the door says its own in `/api/me`.
    static let api = 1

    let origin: URL
    let key: String

    /// Why a call didn't work, as the app shows it.
    enum Problem: Error, Equatable {
        /// No answer in time, or no route to the Mac.
        case unreachable
        /// The Mac unpaired this iPhone, or never paired it.
        case unpaired
        /// The pairing code was used, or is older than 10 minutes.
        case codeExpired
        /// The app and the Mac were built for different calls.
        case mismatch
        /// The door refused, in its own words.
        case refused(String)
    }

    struct Person: Codable, Equatable, Sendable {
        let id: String
        let name: String
    }

    /// What `POST /api/pair` gives: the key, once, and whose record it opens.
    struct Paired: Decodable, Sendable {
        struct App: Decodable, Sendable { let id: String }
        let key: String
        let app: App
        let person: Person
        let mac: String
        let folder: String
    }

    /// `GET /api/me`: who this key acts as.
    struct Me: Decodable, Sendable {
        let person: Person
        let mac: String
        let api: Int
    }

    /// Exchanges the link's code for a key, as `name`.
    static func pair(_ link: PairingLink, name: String) async throws(Problem) -> Paired {
        try await call(origin: link.origin, key: nil, method: "POST", path: "/api/pair",
                       body: ["code": link.code, "name": name])
    }

    /// Who this key acts as; `mismatch` when the Mac speaks another `api`.
    func me() async throws(Problem) -> Me {
        let me: Me = try await Self.call(origin: origin, key: key, method: "GET", path: "/api/me", body: nil)
        guard me.api == Self.api else { throw .mismatch }
        return me
    }

    /// A launch link that opens Rufi's screens at `path`, once, within 60 seconds.
    func open(_ path: String) async throws(Problem) -> URL {
        struct Opened: Decodable { let url: URL }
        let opened: Opened = try await Self.call(origin: origin, key: key, method: "POST", path: "/api/open",
                                                 body: ["path": path])
        // Only the door's own origin loads in the screens.
        guard opened.url.scheme == origin.scheme, opened.url.host() == origin.host(),
              opened.url.port == origin.port
        else { throw .refused("Rufi on your Mac gave a link elsewhere.") }
        return opened.url
    }

    /// The person's reminder setting: what a notice shows, where it rings.
    struct Setting: Codable, Equatable, Sendable {
        var show: ReminderPlan.Show
        var ring: ReminderPlan.Ring
    }

    /// The reminder plan for `person`, for the days from `from`.
    func plan(for person: String, from: String) async throws(Problem) -> ReminderPlan {
        try await Self.call(origin: origin, key: key, method: "GET", path: "\(Self.people)/\(person)/reminders/plan",
                            query: ["from": from, "days": String(Notices.days)], body: nil)
    }

    func reminders(for person: String) async throws(Problem) -> Setting {
        try await Self.call(origin: origin, key: key, method: "GET", path: "\(Self.people)/\(person)/reminders", body: nil)
    }

    /// Keeps the person's two choices; what applies comes back.
    func save(_ setting: Setting, for person: String) async throws(Problem) -> Setting {
        try await Self.call(origin: origin, key: key, method: "PUT", path: "\(Self.people)/\(person)/reminders",
                            body: ["show": setting.show.rawValue, "ring": setting.ring.rawValue])
    }

    /// Unpairs this iPhone on the Mac.
    func unpair() async throws(Problem) {
        struct Nothing: Decodable {}
        let _: Nothing = try await Self.call(origin: origin, key: key, method: "POST", path: "/api/unpair", body: [:])
    }

    private static let people = "/api/people"

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    private static func call<Answer: Decodable>(
        origin: URL, key: String?, method: String, path: String, query: [String: String] = [:],
        body: [String: String]?
    ) async throws(Problem) -> Answer {
        var url = origin.appending(path: path)
        if !query.isEmpty {
            url.append(queryItems: query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) })
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONEncoder().encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw .unreachable }
        let refusal = try? JSONDecoder().decode(Refusal.self, from: data)
        switch http.statusCode {
        case 200..<300:
            guard let answer = try? JSONDecoder().decode(Answer.self, from: data) else { throw .mismatch }
            return answer
        case 401 where refusal?.problem == "unpaired": throw .unpaired
        case 410 where refusal?.problem == "code_expired": throw .codeExpired
        default:
            throw .refused(refusal?.error ?? "Rufi on your Mac refused (\(http.statusCode)).")
        }
    }
}

/// The door's refusal: its words, and what kind when it says.
nonisolated private struct Refusal: Decodable {
    let error: String?
    let problem: String?
}

/// A redirect is refused: the key goes only to the door.
nonisolated private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

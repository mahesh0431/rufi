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

    /// Fetches one of `document`'s files, as it came, into `staging`; an
    /// original may be large, so it has 5 minutes.
    func file(person: String, document: String, file: String, into staging: URL) async throws(Problem) -> URL {
        let path = ["api", "people", person, "documents", document, "files", file]
            .map { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? "" }
            .joined(separator: "/")
        guard let url = URL(string: "/" + path, relativeTo: origin) else { throw .refused("That file isn't there.") }
        var request = URLRequest(url: url, timeoutInterval: Self.fileSeconds)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let fetched: URL
        let response: URLResponse
        do {
            (fetched, response) = try await Self.files.download(for: request)
        } catch {
            throw .unreachable
        }
        // At once where Rufi's own cleanup finds it, whatever happens next.
        let staged = staging.appending(path: UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: fetched, to: staged)
        } catch {
            try? FileManager.default.removeItem(at: fetched)
            throw .refused("Rufi couldn't keep a copy to show. Try again.")
        }
        guard let http = response as? HTTPURLResponse else {
            try? FileManager.default.removeItem(at: staged)
            throw .unreachable
        }
        guard (200..<300).contains(http.statusCode) else {
            let refusal = (try? Data(contentsOf: staged)).flatMap { try? JSONDecoder().decode(Refusal.self, from: $0) }
            try? FileManager.default.removeItem(at: staged)
            if http.statusCode == 401, refusal?.problem == "unpaired" { throw .unpaired }
            throw .refused(refusal?.error ?? "Rufi on your Mac refused (\(http.statusCode)).")
        }
        return staged
    }

    /// What the Mac did with a dose log.
    enum Logged: Equatable, Sendable {
        /// Stored, or it had this very log already (sent again).
        case stored
        /// Refused, in its words: another log under this id, or a medicine
        /// that isn't the person's. Sending it again changes nothing.
        case refused(String)
    }

    /// Sends one dose log to its person's log on the Mac, under its own id.
    /// The Mac out of reach, or failing: `unreachable`, for the next time.
    func log(_ log: UnsentLog) async throws(Problem) -> Logged {
        var body = [
            "id": log.id, "medicineUseId": log.medicine, "doseAt": log.doseAt,
            "state": log.state.rawValue, "loggedAt": log.loggedAt,
        ]
        if let takenAt = log.takenAt { body["takenAt"] = takenAt }
        var request = URLRequest(url: origin.appending(path: "\(Self.people)/\(log.made.person)/doses"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw .unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw .unreachable }
        let refusal = try? JSONDecoder().decode(Refusal.self, from: data)
        switch http.statusCode {
        case 200..<300: return .stored
        case 401 where refusal?.problem == "unpaired": throw .unpaired
        case 400, 404, 409: return .refused(refusal?.error ?? "Rufi on your Mac refused this log.")
        default: throw .unreachable
        }
    }

    /// What the Mac said of a batch it took.
    enum Received: Sendable {
        case gotIt
        case alreadyGot
    }

    /// Sends one Apple Health batch, as it is, into this app's device source
    /// on the Mac. A refusal comes back in the Mac's words.
    func batch(_ body: Data) async throws(Problem) -> Received {
        var request = URLRequest(url: origin.appending(path: "/api/batches"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.upload(for: request, from: body)
        } catch {
            throw .unreachable
        }
        // A Mac whose Rufi doesn't take batches yet.
        if (response as? HTTPURLResponse)?.statusCode == 404 { throw .mismatch }
        // A refusal says why (unpaired, couldn't store, refused); only an
        // answer the app can't read is a mismatch.
        let accepted = try Self.taken(data, response)
        struct Answer: Decodable { let answer: String }
        switch (try? JSONDecoder().decode(Answer.self, from: accepted))?.answer {
        case "got_it": return .gotIt
        case "already_got": return .alreadyGot
        default: throw .mismatch
        }
    }

    /// Unpairs this iPhone on the Mac.
    func unpair() async throws(Problem) {
        struct Nothing: Decodable {}
        let _: Nothing = try await Self.call(origin: origin, key: key, method: "POST", path: "/api/unpair", body: [:])
    }

    private static let people = "/api/people"
    /// How long an original or an upload may take, as the screens give a file.
    static let fileSeconds: TimeInterval = 5 * 60

    private static let files: URLSession = {
        let configuration = Self.configuration()
        configuration.timeoutIntervalForRequest = fileSeconds
        configuration.timeoutIntervalForResource = fileSeconds
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    private static let session: URLSession = {
        let configuration = Self.configuration()
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    private static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        #if DEBUG
        if let standIn { configuration.protocolClasses = [standIn] }
        #endif
        return configuration
    }

    #if DEBUG
    /// Tests answer for the door with a URLProtocol, set before the first call.
    nonisolated(unsafe) static var standIn: AnyClass?
    #endif

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
        // A refusal says why; only an answer the app can't read is a mismatch.
        let accepted = try taken(data, response)
        guard let answer = try? JSONDecoder().decode(Answer.self, from: accepted) else { throw .mismatch }
        return answer
    }

    /// The form that adds scanned pages, as the paperclip's add sends photos:
    /// each page a JPEG `file`, together as one document, from the chat.
    static func scanForm(_ pages: [Data], boundary: String) -> Data {
        var body = Data()
        func part(_ head: String, _ data: Data) {
            body.append(Data("--\(boundary)\r\n\(head)\r\n\r\n".utf8))
            body.append(data)
            body.append(Data("\r\n".utf8))
        }
        for (index, page) in pages.enumerated() {
            part("Content-Disposition: form-data; name=\"file\"; filename=\"Scan page \(index + 1).jpg\"\r\nContent-Type: image/jpeg", page)
        }
        part("Content-Disposition: form-data; name=\"together\"", Data("yes".utf8))
        part("Content-Disposition: form-data; name=\"from\"", Data("chat".utf8))
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }

    /// The answer when the door took the call; else why not.
    private static func taken(_ data: Data, _ response: URLResponse) throws(Problem) -> Data {
        guard let http = response as? HTTPURLResponse else { throw .unreachable }
        let refusal = try? JSONDecoder().decode(Refusal.self, from: data)
        switch http.statusCode {
        case 200..<300: return data
        case 401 where refusal?.problem == "unpaired": throw .unpaired
        case 410 where refusal?.problem == "code_expired": throw .codeExpired
        default:
            throw .refused(refusal?.error ?? "Rufi on your Mac refused (\(http.statusCode)).")
        }
    }

    /// Adds scanned pages to `person`'s documents from the chat, together as
    /// one document, as the paperclip adds photos; pages may be large, so it
    /// has 5 minutes. The door's answer, as it came, for the chat box.
    func add(person: String, pages: [Data]) async throws(Problem) -> Data {
        let at = person.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? ""
        var request = URLRequest(url: origin.appending(path: "/api/people/\(at)/documents"), timeoutInterval: Self.fileSeconds)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let boundary = "rufi-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let body = Self.scanForm(pages, boundary: boundary)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.files.upload(for: request, from: body)
        } catch {
            throw .unreachable
        }
        return try Self.taken(data, response)
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

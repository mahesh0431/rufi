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
        let me: Me = try await Self.call(origin: origin, key: key, method: "GET", path: "/api/me", body: nil,
                                         wait: Self.openSeconds)
        guard me.api == Self.api else { throw .mismatch }
        return me
    }

    /// A launch link that opens Rufi's screens at `path`, once, within 60 seconds.
    func open(_ path: String) async throws(Problem) -> URL {
        struct Opened: Decodable { let url: URL }
        let opened: Opened = try await Self.call(origin: origin, key: key, method: "POST", path: "/api/open",
                                                 body: ["path": path], wait: Self.openSeconds)
        // Only the door's own origin loads in the screens.
        guard opened.url.scheme == origin.scheme, opened.url.host() == origin.host(),
              opened.url.port == origin.port
        else { throw .refused("Rufi on your Mac gave a link elsewhere.") }
        return opened.url
    }

    /// What the sidebar counts, as the Mac's does: each record page's
    /// records (on Lab results, its tests) and the open follow-ups.
    struct Counts: Decodable, Equatable, Sendable {
        struct Tile: Decodable, Equatable, Sendable {
            let kind: String
            let count: Int
        }

        let tiles: [Tile]
        let openFollowUps: Int

        /// The count beside `place`; none for a place the Mac counts nothing on.
        func of(_ place: Place) -> Int? {
            if place == .followUps { return openFollowUps }
            guard Place.record.contains(place) else { return nil }
            return tiles.first { $0.kind == place.rawValue }?.count ?? 0
        }
    }

    /// The person's counts, from their Overview.
    func counts(for person: String) async throws(Problem) -> Counts {
        struct Answer: Decodable { let overview: Counts }
        let answer: Answer = try await Self.call(origin: origin, key: key, method: "GET",
                                                 path: "\(Self.people)/\(person)/overview", body: nil)
        return answer.overview
    }

    /// Reads `path` under the person's routes, as the Mac's pages read it:
    /// "overview", "record/condition", "follow-ups".
    func read<Answer: Decodable>(_ path: String, for person: String, query: [String: String] = [:])
        async throws(Problem) -> Answer {
        try await Self.call(origin: origin, key: key, method: "GET", path: "\(Self.people)/\(person)/\(path)",
                            query: query, body: nil)
    }

    /// Posts `body` to `path` under the person's routes, as the Mac's pages do.
    func post<Answer: Decodable>(_ path: String, for person: String, body: [String: String])
        async throws(Problem) -> Answer {
        try await Self.call(origin: origin, key: key, method: "POST", path: "\(Self.people)/\(person)/\(path)", body: body)
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
        try await fetch(["api", "people", person, "documents", document, "files", file], into: staging).file
    }

    /// A document's page as Rufi AI saw it, in memory: a PDF's page drawn
    /// 1600 px on its longer side, a photo as it came (a HEIC as its JPEG).
    func page(person: String, document: String, position: Int) async throws(Problem) -> Data {
        let parts = ["api", "people", person, "documents", document, "pages", String(position)]
            .map { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? "" }
        var request = URLRequest(url: origin.appending(path: "/" + parts.joined(separator: "/")), timeoutInterval: Self.fileSeconds)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.files.data(for: request)
        } catch {
            throw .unreachable
        }
        return try Self.taken(data, response)
    }

    /// Fetches a visit brief's PDF, which Rufi makes fresh, into `staging`,
    /// with its name as Rufi gives it.
    func briefPDF(person: String, brief: String, into staging: URL) async throws(Problem) -> (file: URL, name: String) {
        let (file, response) = try await fetch(["api", "people", person, "briefs", brief, "pdf"], into: staging)
        return (file, response.suggestedFilename ?? "Visit brief.pdf")
    }

    private func fetch(_ parts: [String], into staging: URL) async throws(Problem) -> (file: URL, response: HTTPURLResponse) {
        let path = parts
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
        return (staged, http)
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

    /// Sends a message the box kept into `person`'s chat, under its own id,
    /// with its chips, and how it goes while a reply runs when it says. The
    /// box saves its own draft, so the Mac's stays (`draft: keep`). Rufi
    /// refused it: its words. The Mac out of reach: `unreachable`, for the next time.
    func send(_ message: PendingMessage, for person: String) async throws(Problem) {
        struct Message: Encodable {
            let id: String
            let text: String
            let refs: [Pointer]
            let kind: String?
            let draft = "keep"
        }
        struct Nothing: Decodable {}
        let _: Nothing = try await Self.call(
            origin: origin, key: key, method: "POST", path: "\(Self.people)/\(person)/chat/messages",
            body: Message(id: message.id, text: message.text, refs: (message.refs ?? []).map(\.ref), kind: message.kind))
    }

    /// Keeps the box's words and chips as `person`'s draft; the chips come back named.
    func save(draft text: String, refs: [Pointer], for person: String) async throws(Problem) -> Draft {
        struct Save: Encodable {
            let text: String
            let refs: [Pointer]
        }
        return try await Self.call(origin: origin, key: key, method: "PUT", path: "\(Self.people)/\(person)/chat/draft",
                                   body: Save(text: text, refs: refs))
    }

    /// Changes `field` (model or effort) of `person`'s chat, from the next reply.
    func choose(_ field: String, _ value: String, for person: String) async throws(Problem) {
        struct Nothing: Decodable {}
        let _: Nothing = try await Self.call(origin: origin, key: key, method: "PUT",
                                             path: "\(Self.people)/\(person)/chat/\(field)", body: [field: value])
    }

    /// Stops the reply running in `person`'s chat.
    func stop(for person: String) async throws(Problem) {
        struct Nothing: Decodable {}
        let _: Nothing = try await Self.call(origin: origin, key: key, method: "POST",
                                             path: "\(Self.people)/\(person)/chat/stop", body: [String: String]())
    }

    /// Changes what waits to go to the AI in `person`'s chat (`chat/queue`
    /// and below it): the queue as it is then.
    func queue(_ method: String, _ path: String = "", body: (any Encodable & Sendable)? = nil, for person: String)
        async throws(Problem) -> Queue {
        try await Self.call(origin: origin, key: key, method: method,
                            path: "\(Self.people)/\(person)/chat/queue\(path)", body: body)
    }

    /// Stops a sub-agent of `person`'s chat, and the agents it started.
    func stop(agent: String, for person: String) async throws(Problem) {
        struct Nothing: Decodable {}
        let _: Nothing = try await Self.call(origin: origin, key: key, method: "POST",
                                             path: "\(Self.people)/\(person)/chat/agents/stop",
                                             query: ["agent": agent], body: [String: String]())
    }

    /// A file added from the box, never sent, leaves Rufi; once sent, it
    /// stays (the Mac says so, and that is fine).
    func unsent(_ document: String, for person: String) async throws(Problem) {
        let at = [person, document]
            .map { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? "" }
        var request = URLRequest(url: origin.appending(path: "\(Self.people)/\(at[0])/documents/\(at[1])/unsent"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw .unreachable
        }
        if (response as? HTTPURLResponse)?.statusCode == 409 { return }
        _ = try Self.taken(data, response)
    }

    /// Reads `path` outside the person's routes: "/api/settings", "/api/status".
    func read<Answer: Decodable>(api path: String) async throws(Problem) -> Answer {
        try await Self.call(origin: origin, key: key, method: "GET", path: path, body: nil)
    }

    /// `person`'s chat as it goes: a page, then a line at each change. None
    /// when the person has no chat. It ends when nothing comes for 45
    /// seconds (the Mac says something every 15).
    func chat(for person: String) async throws(Problem) -> URLSession.AsyncBytes? {
        var request = URLRequest(url: origin.appending(path: "\(Self.people)/\(person)/chat/stream"), timeoutInterval: 45)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await Self.streams.bytes(for: request)
        } catch {
            throw .unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw .unreachable }
        if (200..<300).contains(http.statusCode) { return bytes }
        if http.statusCode == 404 { return nil }
        var data = Data()
        do {
            for try await byte in bytes where data.count < 64 * 1024 { data.append(byte) }
        } catch {
            throw .unreachable
        }
        _ = try Self.taken(data, response)
        throw .unreachable
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
        let _: Nothing = try await Self.call(origin: origin, key: key, method: "POST", path: "/api/unpair", body: [String: String]())
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

    /// The chat's stream: open for as long as it is read.
    private static let streams: URLSession = {
        let configuration = Self.configuration()
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
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

    /// How long opening Rufi, or asking whether it can be reached, waits.
    static let openSeconds: TimeInterval = 10

    private static func call<Answer: Decodable>(
        origin: URL, key: String?, method: String, path: String, query: [String: String] = [:],
        body: (any Encodable & Sendable)?, wait: TimeInterval? = nil
    ) async throws(Problem) -> Answer {
        var url = origin.appending(path: path)
        if !query.isEmpty {
            url.append(queryItems: query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) })
        }
        var request = URLRequest(url: url)
        if let wait { request.timeoutInterval = wait }
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

    /// A file to add: its name, its type and its bytes.
    struct Upload: Sendable {
        let name: String
        let type: String
        let data: Data
    }

    /// The form that adds files from the chat, as the web's paperclip sends
    /// them: each a `file`, and whether photos go together as one document.
    static func form(_ files: [Upload], together: Bool, boundary: String) -> Data {
        var body = Data()
        func part(_ head: String, _ data: Data) {
            body.append(Data("--\(boundary)\r\n\(head)\r\n\r\n".utf8))
            body.append(data)
            body.append(Data("\r\n".utf8))
        }
        for file in files {
            let name = file.name.replacingOccurrences(of: "\"", with: "'")
            part("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(file.type)", file.data)
        }
        part("Content-Disposition: form-data; name=\"together\"", Data((together ? "yes" : "no").utf8))
        part("Content-Disposition: form-data; name=\"from\"", Data("chat".utf8))
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }

    /// A proxy in front of the door refused a request as too large.
    static let tooLarge = "Too large to send to your Mac. Add fewer at a time."

    /// The answer when the door took the call; else why not.
    private static func taken(_ data: Data, _ response: URLResponse) throws(Problem) -> Data {
        guard let http = response as? HTTPURLResponse else { throw .unreachable }
        let refusal = try? JSONDecoder().decode(Refusal.self, from: data)
        switch http.statusCode {
        case 200..<300: return data
        case 401 where refusal?.problem == "unpaired": throw .unpaired
        case 410 where refusal?.problem == "code_expired": throw .codeExpired
        // A gateway's own answer, no words of Rufi's: Tailscale's when Rufi
        // isn't running behind it, Cloudflare's (530) when its tunnel is down.
        case 502...504 where refusal?.error == nil, 520...530 where refusal?.error == nil: throw .unreachable
        // Cloudflare's limit on what one request may carry, below Rufi's own.
        case 413 where refusal?.error == nil: throw .refused(Self.tooLarge)
        default:
            throw .refused(refusal?.error ?? "Rufi on your Mac refused (\(http.statusCode)).")
        }
    }

    /// Adds files to `person`'s documents from the chat (the box's Photos,
    /// Files and Camera), photos together as one document or each its own;
    /// files may be large, so it has 5 minutes. The door's answer, as it
    /// came, for the chat box.
    func add(person: String, files: [Upload], together: Bool) async throws(Problem) -> Data {
        let at = person.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? ""
        var request = URLRequest(url: origin.appending(path: "/api/people/\(at)/documents"), timeoutInterval: Self.fileSeconds)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let boundary = "rufi-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let body = Self.form(files, together: together, boundary: boundary)
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

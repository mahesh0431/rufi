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

    /// Unpairs this iPhone on the Mac.
    func unpair() async throws(Problem) {
        struct Nothing: Decodable {}
        let _: Nothing = try await Self.call(origin: origin, key: key, method: "POST", path: "/api/unpair", body: [:])
    }

    /// How long an original or an upload may take, as the screens give a file.
    static let fileSeconds: TimeInterval = 5 * 60

    private static let files: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = fileSeconds
        configuration.timeoutIntervalForResource = fileSeconds
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    private static func call<Answer: Decodable>(
        origin: URL, key: String?, method: String, path: String, body: [String: String]?
    ) async throws(Problem) -> Answer {
        var request = URLRequest(url: origin.appending(path: path))
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
        guard let answer = try? JSONDecoder().decode(Answer.self, from: try taken(data, response)) else {
            throw .mismatch
        }
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

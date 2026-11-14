import Foundation
import WebKit

/// The two pages a reply's visual draws in (ADR 0034), the door's card page
/// and the visual's own, kept for the pairing's chat in this app run. Each is
/// fetched from the door once, when a card first needs it, and kept with
/// its headers, its policy among them; a page that didn't come is asked for
/// again by the next card. A card's web view loads them from here, on
/// Rufi's own scheme, as the door served them: so a reply's visual draws
/// without asking the Mac again, and while it can't be reached.
final class VisualPages: NSObject, WKURLSchemeHandler {
    /// A page as the door served it.
    nonisolated struct Page: Sendable {
        let headers: [String: String]
        let body: Data
    }

    static let scheme = "rufi-visual"
    /// The card page; the frame it holds is at its own path, beside it.
    static let card = URL(string: "\(scheme)://card/visual-card.html")!
    static let frame = URL(string: "\(scheme)://card/visual-frame.html")!

    private let fetch: (String) async throws -> Page
    private var kept: [String: Task<Page, any Error>] = [:]
    /// The web view's requests not answered yet and not stopped.
    private var waiting: Set<ObjectIdentifier> = []

    /// Pages that `fetch` gives, by their path on the door.
    init(fetch: @escaping (String) async throws -> Page) {
        self.fetch = fetch
    }

    convenience init(door: Door) {
        self.init { try await door.page($0) }
    }

    /// The page at `path`: the one kept, or the door's, then kept. Cards
    /// asking at once share one fetch.
    func page(_ path: String) async throws -> Page {
        let task = kept[path] ?? Task { try await fetch(path) }
        kept[path] = task
        do {
            return try await task.value
        } catch {
            if kept[path] == task { kept[path] = nil }
            throw error
        }
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        waiting.insert(id)
        Task {
            // Only the two pages: the card's and, in its frame, the visual's.
            guard let url = task.request.url, url == Self.card || url == Self.frame else {
                guard waiting.remove(id) != nil else { return }
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            do {
                let page = try await page(url.path())
                guard waiting.remove(id) != nil else { return }
                task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                                headerFields: page.headers)!)
                task.didReceive(page.body)
                task.didFinish()
            } catch {
                guard waiting.remove(id) != nil else { return }
                task.didFailWithError(error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        waiting.remove(ObjectIdentifier(task))
    }
}

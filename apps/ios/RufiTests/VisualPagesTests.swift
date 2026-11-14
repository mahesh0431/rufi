import Foundation
import Network
import Synchronization
import Testing
import UIKit
import WebKit
@testable import Rufi

/// A visual drawn from the pages the chat keeps (VisualPages), in the
/// card's real web view: it draws, says its height and takes a new theme;
/// the visual's page keeps its policy, which WebKit enforces from the kept
/// headers alone; and each page is fetched once, again only when it didn't
/// come. Probes go into the visual's frame after its markup guard ran, so
/// only the policy stands in their way; with the policy left out of the
/// kept headers, the same probes run and connect.
@MainActor
@Suite(.serialized)
struct VisualPagesTests {
    /// The door's two pages as it serves them (ios-fixtures.test.ts).
    private static func served() throws -> [String: VisualPages.Page] {
        struct Served: Decodable {
            let headers: [String: String]
            let body: String
        }
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/visual-pages.json")
        let pages = try JSONDecoder().decode([String: Served].self, from: Data(contentsOf: file))
        return pages.mapValues { VisualPages.Page(headers: $0.headers, body: Data($0.body.utf8)) }
    }

    /// The served pages, with the visual's page under `policy` instead of its own.
    private static func pages(policy: (String) -> String?) throws -> VisualPages {
        var pages = try served()
        let frame = try #require(pages["/visual-frame.html"])
        var headers = frame.headers
        headers["content-security-policy"] = policy(try #require(headers["content-security-policy"]))
        pages["/visual-frame.html"] = VisualPages.Page(headers: headers, body: frame.body)
        return VisualPages { path in
            guard let page = pages[path] else { throw URLError(.fileDoesNotExist) }
            return page
        }
    }

    // MARK: - The gate

    @Test func theKeptPagesDrawAVisualAndRelayItsHeightAndTheme() async throws {
        let card = try await Card(pages: Self.pages { $0 })
        try await card.until("its height") { card.heights.last == 120 }
        #expect(try await card.inFrame("document.getElementById('drawn')?.textContent") as? String == "Drawn")

        card.theme(Card.dark)
        try await card.until("the new theme") {
            try await card.inFrame("getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()")
                as? String == "#eeeeee"
        }
        #expect(!card.broken && !card.ended)
    }

    @Test func theVisualsPolicyHoldsFromTheKeptHeadersAlone() async throws {
        let outside = try await Outside()
        let card = try await Card(pages: Self.pages { $0 })
        try await card.until("its height") { card.heights.last == 120 }

        // An opaque origin: nothing of the card page, cookies or storage.
        // WebKit refuses the cookie on a card's first load, and on later
        // ones reads none; either way the one it set never comes back.
        let reach = try #require(try await card.inFrame(Card.reach) as? [String: String])
        #expect(reach.filter { $0.key != "cookie" } == ["origin": "null", "parent": "refused", "storage": "refused"])
        #expect(["refused", ""].contains(reach["cookie"]))
        let said = try await card.probe(Probe.allCases, outside: outside, own: Self.ownHash())
        #expect(said == ["ran": "no", "handler": "no"])
        #expect(outside.reached == Outside.Reached(connections: 0, paths: []))
    }

    @Test func withoutThePolicyTheSameProbesRunAndConnect() async throws {
        let outside = try await Outside()
        let card = try await Card(pages: Self.pages { _ in nil })
        try await card.until("its height") { card.heights.last == 120 }

        let said = try await card.probe(Probe.allCases, outside: outside, own: Self.ownHash())
        #expect(said == ["ran": "yes", "handler": "yes"])
        try await card.until("the probes' requests") {
            Set(outside.reached.paths).isSuperset(of: ["/fetch", "/picture.png", "/active.js"])
        }
    }

    /// The second policy on its own keeps a script file named by a hash the
    /// first allows from loading; without it, the file loads.
    @Test func theSecondPolicyAloneKeepsAScriptFileOut() async throws {
        let own = try Self.ownHash()
        let second = try await Outside()
        let card = try await Card(pages: Self.pages { $0.components(separatedBy: ", ").last })
        try await card.until("its height") { card.heights.last == 120 }
        _ = try await card.probe([.file], outside: second, own: own)
        #expect(second.reached == Outside.Reached(connections: 0, paths: []))

        let none = try await Outside()
        let open = try await Card(pages: Self.pages { _ in nil })
        try await open.until("its height") { open.heights.last == 120 }
        _ = try await open.probe([.file], outside: none, own: own)
        try await open.until("the file's request") { none.reached.paths.contains("/active.js") }
    }

    /// The hash of the visual page's own script, which its policy allows.
    private static func ownHash() throws -> String {
        let policy = try #require(try served()["/visual-frame.html"]?.headers["content-security-policy"])
        let hash = try #require(policy.firstMatch(of: /'(sha256-[^']+)'/))
        return String(hash.1)
    }

    // MARK: - Fetched once

    @Test func eachPageIsFetchedOnceAndAgainOnlyWhenItDidntCome() async throws {
        let asked = Mutex<[String]>([])
        let failing = Mutex(true)
        let pages = VisualPages { path in
            asked.withLock { $0.append(path) }
            try await Task.sleep(for: .milliseconds(20))
            if failing.withLock({ $0 }) { throw Door.Problem.unreachable }
            return VisualPages.Page(headers: ["content-type": "text/html"], body: Data(path.utf8))
        }
        await #expect(throws: Door.Problem.unreachable) { try await pages.page("/visual-card.html") }

        failing.withLock { $0 = false }
        // Cards asking at once share one fetch; later ones ask nobody.
        async let first = pages.page("/visual-card.html")
        async let second = pages.page("/visual-card.html")
        #expect(try await [first.body, second.body] == [Data("/visual-card.html".utf8), Data("/visual-card.html".utf8)])
        failing.withLock { $0 = true }
        #expect(try await pages.page("/visual-card.html").body == Data("/visual-card.html".utf8))
        #expect(asked.withLock { $0 } == ["/visual-card.html", "/visual-card.html"])
    }

    @Test func aCardLoadsOnlyTheTwoKeptPages() {
        let at = { (text: String) in URL(string: text) }
        #expect(VisualCard.loads(at("rufi-visual://card/visual-card.html"), mainFrame: true))
        #expect(VisualCard.loads(at("rufi-visual://card/visual-frame.html"), mainFrame: false))
        #expect(VisualCard.loads(at("about:blank"), mainFrame: false))
        #expect(!VisualCard.loads(at("rufi-visual://card/visual-frame.html"), mainFrame: true))
        #expect(!VisualCard.loads(at("rufi-visual://card/visual-frame.html?hba1c=6.4"), mainFrame: false))
        #expect(!VisualCard.loads(at("rufi-visual://elsewhere/visual-frame.html"), mainFrame: false))
        #expect(!VisualCard.loads(at("https://mac.tailnet.test/visual-frame.html"), mainFrame: false))
        #expect(!VisualCard.loads(at("data:text/html,hi"), mainFrame: false))
    }
}

/// What the test puts into the visual's frame, past its markup guard.
private enum Probe: String, CaseIterable {
    /// A script element of the visual's own, and an event handler.
    case inline, handler
    /// A fetch and a picture from the outside server.
    case network
    /// A script file named by the hash the first policy allows.
    case file
}

/// A card's real web view on `pages`, in a window, with the frame of its
/// visual at hand for the test.
@MainActor
private final class Card: NSObject {
    static let light: [String: Any] = ["scheme": "light", "fontSize": "17px", "variables": ["--ink": "#111111"]]
    static let dark: [String: Any] = ["scheme": "dark", "fontSize": "17px", "variables": ["--ink": "#eeeeee"]]
    static let visual = #"<div id="drawn" style="height:120px">Drawn</div>"#
    static let reach = """
        const tried = (what) => { try { return String(what()); } catch { return "refused"; } };
        return { origin: self.origin, parent: tried(() => window.parent.document.title),
                 cookie: tried(() => { document.cookie = "kept=hba1c"; return document.cookie; }),
                 storage: tried(() => localStorage.length) };
        """

    private(set) var heights: [Double] = []
    private(set) var broken = false
    private(set) var ended = false
    private var coordinator: CardView.Coordinator!
    private var view: WKWebView!
    private var window: UIWindow!
    /// The visual's frame, as its page told the test's own world.
    private var frame: WKFrameInfo?

    init(pages: VisualPages) async throws {
        super.init()
        coordinator = card(pages: pages, theme: Self.light).makeCoordinator()
        view = CardView.made(coordinator)
        let world = WKContentWorld.world(name: "gate")
        view.configuration.userContentController.add(Told(self), contentWorld: world, name: "gate")
        view.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.webkit.messageHandlers.gate.postMessage('here')",
            injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: world))
        // Only now the card loads, so its frame's first document has the script.
        view.load(URLRequest(url: VisualPages.card))
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        view.frame = window.bounds
        window.addSubview(view)
        window.isHidden = false
        try await until("the visual's frame") { frame != nil }
    }

    isolated deinit {
        window?.isHidden = true
    }

    private func card(pages: VisualPages, theme: [String: Any]) -> CardView {
        CardView(html: Self.visual, theme: theme, pages: pages) { [weak self] in
            self?.heights.append($0)
        } broke: { [weak self] in
            self?.broken = true
        } ended: { [weak self] in
            self?.ended = true
        }
    }

    /// The visual's frame said it is there.
    func told(_ message: WKScriptMessage) {
        if !message.frameInfo.isMainFrame { frame = message.frameInfo }
    }

    /// Holds the card weakly, as the card's own relay does: the web view
    /// keeps its handlers, so the card goes when the test is done with it.
    private final class Told: NSObject, WKScriptMessageHandler {
        weak var card: Card?

        init(_ card: Card) {
            self.card = card
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            card?.told(message)
        }
    }

    func theme(_ theme: [String: Any]) {
        coordinator.card = card(pages: coordinator.card.pages, theme: theme)
        coordinator.themed()
    }

    /// Runs `body` in the visual's frame, as its page's own script would.
    func inFrame(_ body: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        let script = body.contains("return") ? body : "return \(body)"
        return try await view.callAsyncJavaScript(script, arguments: arguments, in: frame, contentWorld: .page)
    }

    /// Puts `probes` into the visual, waits a second, and says whether its
    /// script and its handler ran.
    func probe(_ probes: [Probe], outside: Outside, own: String) async throws -> [String: String]? {
        try await inFrame("""
            const add = (html) => document.body.insertAdjacentHTML("beforeend", html);
            if (probes.includes("inline")) {
              const script = document.createElement("script");
              script.textContent = 'document.body.dataset.ran = "yes"';
              document.body.append(script);
            }
            if (probes.includes("handler")) {
              add('<img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onload="document.body.dataset.handler = \\'yes\\'">');
            }
            if (probes.includes("network")) {
              fetch(out + "/fetch").catch(() => {});
              add('<img alt="" src="' + out + '/picture.png">');
            }
            if (probes.includes("file")) {
              const file = document.createElement("script");
              file.src = out + "/active.js";
              file.integrity = own;
              file.crossOrigin = "anonymous";
              document.body.append(file);
            }
            await new Promise((done) => setTimeout(done, 1000));
            return { ran: document.body.dataset.ran ?? "no", handler: document.body.dataset.handler ?? "no" };
            """, ["probes": probes.map(\.rawValue), "out": outside.address, "own": own]) as? [String: String]
    }

    /// Waits up to 30 seconds for `done`: a first web view on a cold
    /// Simulator starts WebKit's processes.
    func until(_ what: String, _ done: () async throws -> Bool) async throws {
        let end = ContinuousClock.now + .seconds(30)
        while try await !done() {
            guard ContinuousClock.now < end else {
                throw Waited(what: what, heights: heights, frame: frame != nil, broken: broken, ended: ended)
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    /// What the card had when a wait ran out.
    struct Waited: Error {
        let what: String
        let heights: [Double]
        let frame: Bool
        let broken: Bool
        let ended: Bool
    }
}

/// A server on this Mac that counts every connection, even one that never
/// sends a request, and the paths asked for; it answers each with "out".
nonisolated private final class Outside: Sendable {
    struct Reached: Equatable {
        var connections = 0
        var paths: [String] = []
    }

    /// What reached it, shared with its handlers.
    private final class Tally: Sendable {
        let state = Mutex(Reached())
    }

    private let listener: NWListener
    private let tally = Tally()
    let address: String

    var reached: Reached { tally.state.withLock { $0 } }

    init() async throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        let queue = DispatchQueue(label: "outside")
        let tally = tally
        listener.newConnectionHandler = { connection in
            tally.state.withLock { $0.connections += 1 }
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                let line = data.flatMap { String(data: $0, encoding: .utf8) }?.split(separator: "\r\n").first
                if let path = line?.split(separator: " ").dropFirst().first {
                    tally.state.withLock { $0.paths.append(String(path)) }
                }
                let answer = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nout"
                connection.send(content: Data(answer.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { done in
            let once = Mutex(false)
            listener.stateUpdateHandler = { update in
                let first = once.withLock { told in
                    defer { told = true }
                    return !told
                }
                switch update {
                case .ready where first: done.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error) where first: done.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
        address = "http://127.0.0.1:\(port)"
    }

    deinit {
        listener.cancel()
    }
}

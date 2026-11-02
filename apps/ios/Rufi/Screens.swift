import SwiftUI
import UIKit
import WebKit

/// Rufi's screens: one web view for the whole app, moved to the screen on
/// top. One, because the screens keep their session per web view and the
/// door keeps one session per app; a second would end the first's.
///
/// The page is marked as the phone's before it loads (`data-place`, the
/// iPhone's body text size and how much the bars cover), and talks to the
/// app through one message handler, `rufi`, taken only from the door's
/// origin in the main frame (apps/web/src/phone.ts).
@Observable
final class Screens: NSObject {
    let view: WKWebView
    /// The door: the only origin that loads here.
    private let origin: URL
    /// The page shown now, as it last said.
    private(set) var path: String?

    /// The person tapped a link to another page.
    var onGo: (String) -> Void = { _ in }
    /// A page has drawn, with its title.
    var onPage: (String, String) -> Void = { _, _ in }
    /// The session ended, or the page couldn't load.
    var onEnded: () -> Void = {}
    var onUnreachable: () -> Void = {}
    /// View original: a document and its files, each an id and a name.
    var onOriginal: (String, [(id: String, name: String)]) -> Void = { _, _ in }

    private var top: CGFloat = 0
    private var bottom: CGFloat = 0
    private var body = UIFont.preferredFont(forTextStyle: .body).pointSize

    init(origin: URL) {
        self.origin = origin
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.dataDetectorTypes = []
        configuration.allowsInlineMediaPlayback = true
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        view.allowsLinkPreview = false
        view.allowsBackForwardNavigationGestures = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.keyboardDismissMode = .interactive
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.navigationDelegate = self
        view.uiDelegate = self
        configuration.userContentController.add(Handler(self), contentWorld: .page, name: "rufi")
        mark()
        NotificationCenter.default.addObserver(
            self, selector: #selector(textSizeChanged),
            name: UIContentSizeCategory.didChangeNotification, object: nil)
    }

    /// Loads a launch link from the door.
    func load(_ url: URL) {
        path = nil
        view.load(URLRequest(url: url))
    }

    /// Shows `path` in the page that is open.
    func open(_ path: String) {
        guard let json = try? JSONEncoder().encode(path), let text = String(data: json, encoding: .utf8) else { return }
        view.evaluateJavaScript("window.rufi.open(\(text))") { [weak self] _, error in
            if error != nil { self?.onEnded() }
        }
    }

    /// A still of the page as it is now.
    func snapshot() async -> UIImage? {
        try? await view.takeSnapshot(configuration: nil)
    }

    /// How much the bars cover the web view, top and bottom.
    func bars(top: CGFloat, bottom: CGFloat) {
        guard top != self.top || bottom != self.bottom else { return }
        self.top = top
        self.bottom = bottom
        mark()
    }

    @objc private func textSizeChanged() {
        body = UIFont.preferredFont(forTextStyle: .body).pointSize
        mark()
    }

    /// The phone's marks and values, for the next page and the one open.
    private func mark() {
        // In a block of its own: run again on the same page, it declares
        // nothing twice.
        let values = """
            {
              const style = document.documentElement.style;
              style.setProperty("--ios-body", "\(body)px");
              style.setProperty("--bar-top", "\(top)px");
              style.setProperty("--bar-bottom", "\(bottom)px");
            }
            """
        let controller = view.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.place = \"phone\";\n" + values,
            injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        view.evaluateJavaScript(values)
    }

    private func isDoor(_ url: URL?) -> Bool {
        url?.scheme == origin.scheme && url?.host() == origin.host() && url?.port == origin.port
    }

    fileprivate func received(_ message: WKScriptMessage) {
        let from = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, from.protocol == origin.scheme, from.host == origin.host(),
              from.port == (origin.port ?? 443),
              let body = message.body as? [String: Any], let type = body["type"] as? String
        else { return }
        switch type {
        case "go":
            if let path = body["path"] as? String { onGo(path) }
        case "page":
            if let path = body["path"] as? String, let title = body["title"] as? String {
                self.path = path
                onPage(path, title)
            }
        case "ended":
            onEnded()
        case "original":
            let files = (body["files"] as? [[String: Any]] ?? []).compactMap { file in
                (file["id"] as? String).flatMap { id in (file["name"] as? String).map { (id: id, name: $0) } }
            }
            if let document = body["documentId"] as? String, !files.isEmpty { onOriginal(document, files) }
        default:
            break
        }
    }
}

extension Screens: WKNavigationDelegate, WKUIDelegate {
    /// The door's own pages load here; web links open in Safari; anything
    /// else (`tel:`, `mailto:`, another app's, `file:`, `data:`) does nothing.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = action.request.url
        if isDoor(url) { return .allow }
        if action.targetFrame?.isMainFrame == false, url?.scheme == "about" { return .allow }
        if let url, url.scheme == "https" || url.scheme == "http" {
            await UIApplication.shared.open(url)
        }
        return .cancel
    }

    /// No new windows: a link that asks for one went through the rule above.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        if (error as NSError).code != NSURLErrorCancelled { onUnreachable() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onEnded()
    }
}

/// The message handler, holding the screens weakly: the web view's
/// configuration keeps its handlers.
private final class Handler: NSObject, WKScriptMessageHandler {
    weak var screens: Screens?

    init(_ screens: Screens) {
        self.screens = screens
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        screens?.received(message)
    }
}

/// Where the web view shows: the screen on top holds it, filling the screen
/// under the bars; the page pads itself by how much they cover.
struct WebSlot: UIViewRepresentable {
    let screens: Screens

    func makeUIView(context: Context) -> Slot {
        Slot(screens: screens)
    }

    func updateUIView(_ slot: Slot, context: Context) {
        slot.hold()
    }

    final class Slot: UIView {
        let screens: Screens

        init(screens: Screens) {
            self.screens = screens
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError() }

        func hold() {
            let web = screens.view
            guard web.superview !== self else { return }
            addSubview(web)
            web.frame = bounds
            web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            screens.bars(top: safeAreaInsets.top, bottom: safeAreaInsets.bottom)
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { hold() }
        }

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            if screens.view.superview === self {
                screens.bars(top: safeAreaInsets.top, bottom: safeAreaInsets.bottom)
            }
        }
    }
}

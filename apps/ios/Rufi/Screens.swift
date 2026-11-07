import SwiftUI
import UIKit
import WebKit

/// Rufi's screens: one web view for the whole app, moved to the screen on
/// top. One, because the screens keep their session per web view and the
/// door keeps one session per app; a second would end the first's.
///
/// It keeps Rufi's built files (scripts, styles, fonts: hashed, never
/// changing) in WebKit's disk cache, so a cold start doesn't fetch them
/// again from the Mac; nothing else stays: at each start everything but
/// that cache is cleared before a page loads, and the door sends every page
/// and every answer as not to be kept (`no-store`).
///
/// The page is marked as the phone's before it loads (`data-place`, the
/// iPhone's body text size and how much the bars and the chat box cover),
/// and talks to the app through one message handler, `rufi`, taken only
/// from the door's origin in the main frame (apps/web/src/phone.ts).
@Observable
final class Screens: NSObject {
    let view: WKWebView
    /// The door: the only origin that loads here.
    private let origin: URL
    /// The page shown now, as it last said.
    private(set) var path: String?

    /// The person tapped a link to another page; true when they tapped it
    /// in the chat open over this one.
    var onGo: (String, Bool) -> Void = { _, _ in }
    /// A page has drawn, with its title and the chat box it has.
    var onPage: (String, String, String?) -> Void = { _, _, _ in }
    /// The session ended, or the page couldn't load.
    var onEnded: () -> Void = {}
    /// Doses, medicines or the reminder setting may have changed.
    var onRefresh: () -> Void = {}
    var onUnreachable: () -> Void = {}
    /// The page can reach Rufi, or can't.
    var onConnection: (Bool) -> Void = { _ in }
    /// View original: a document and its files, each an id and a name.
    var onOriginal: (String, [(id: String, name: String)]) -> Void = { _, _ in }
    /// View PDF: the visit brief with this id, as Rufi makes its PDF.
    var onBriefPDF: (String) -> Void = { _ in }
    /// The page drew in these colours, in dark or light.
    var onTheme: (Theme.Colours, Bool) -> Void = { _, _ in }

    private var top: CGFloat = 0
    private var bottom: CGFloat = 0
    /// Where the web view ends and the chat box starts, in the window; no
    /// box, no top.
    private var slotBottom: CGFloat = 0
    private var boxTop: CGFloat?
    private var body = UIFont.preferredFont(forTextStyle: .body).pointSize

    /// Everything of the last run but the disk cache is gone.
    private let cleared: Task<Void, Never>

    init(origin: URL) {
        self.origin = origin
        let configuration = WKWebViewConfiguration()
        let store = WKWebsiteDataStore.default()
        configuration.websiteDataStore = store
        var others = WKWebsiteDataStore.allWebsiteDataTypes()
        others.remove(WKWebsiteDataTypeDiskCache)
        cleared = Task { await store.removeData(ofTypes: others, modifiedSince: .distantPast) }
        configuration.dataDetectorTypes = []
        configuration.allowsInlineMediaPlayback = true
        view = PageView(frame: .zero, configuration: configuration)
        super.init()
        view.allowsLinkPreview = false
        view.allowsBackForwardNavigationGestures = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.keyboardDismissMode = .interactive
        // Rufi's pages are laid out for the phone; a pinch doesn't zoom them.
        view.scrollView.pinchGestureRecognizer?.isEnabled = false
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

    /// Loads a launch link from the door, once the last run's data is cleared.
    func load(_ url: URL) {
        path = nil
        Task {
            await cleared.value
            view.load(URLRequest(url: url))
        }
    }

    /// Unpaired: the cached files go too.
    static func forget() async {
        await WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    /// Shows `path` in the page that is open, with its chat open over it or not.
    func open(_ path: String, chat: Bool) {
        guard let json = try? JSONEncoder().encode(path), let text = String(data: json, encoding: .utf8) else { return }
        view.evaluateJavaScript("window.rufi.open(\(text), \(chat))") { [weak self] _, error in
            if error != nil { self?.onEnded() }
        }
    }

    /// Rufi can be reached again: the page asks now, and reads again.
    func reconnect() {
        view.evaluateJavaScript("window.rufi.reconnect()") { [weak self] _, error in
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

    /// Where the chat box starts, in the window, and the web view ends; no
    /// box, none. The page ends above the box, with the keyboard up too.
    func box(top: CGFloat?) {
        guard top != boxTop else { return }
        boxTop = top
        mark()
    }

    fileprivate func slot(bottom: CGFloat) {
        guard bottom != slotBottom else { return }
        slotBottom = bottom
        if boxTop != nil { mark() }
    }

    /// What covers the bottom of the web view: the chat box, else the bars.
    private var covered: CGFloat {
        guard let boxTop, slotBottom > 0 else { return bottom }
        return max(slotBottom - boxTop, 0)
    }

    /// A swipe down on the page puts the keyboard away: the pages scroll
    /// inside themselves, so the web view's own scrolling can't. It sits on
    /// the slot, around the web view.
    fileprivate func swipeDown() -> UIGestureRecognizer {
        let swipe = UIPanGestureRecognizer(target: self, action: #selector(swiped))
        swipe.cancelsTouchesInView = false
        swipe.delegate = self
        return swipe
    }

    @objc private func swiped(_ pan: UIPanGestureRecognizer) {
        guard pan.state == .changed, pan.translation(in: view).y > 24 else { return }
        view.window?.endEditing(true)
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
              style.setProperty("--bar-bottom", "\(covered)px");
            }
            """
        let controller = view.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.place = \"phone\";\n" + values,
            injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        view.evaluateJavaScript(values)
    }

    /// Where a navigation goes. Only the page's own web links open in
    /// Safari: a frame inside it, such as a reply's visual, never takes
    /// anything out of the app, and its web address loads nothing.
    enum Route: Equatable { case load, safari, nothing }
    /// The frame a navigation is for: the page, a frame in it, or a new
    /// window (`nil`, a link that asks for one).
    enum Frame { case page, frame }

    static func route(_ url: URL?, door: Bool, frame: Frame?) -> Route {
        if door { return .load }
        if frame == .frame { return url?.scheme == "about" ? .load : .nothing }
        if let url, url.scheme == "https" || url.scheme == "http" { return .safari }
        return .nothing
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
            if let path = body["path"] as? String { onGo(path, body["chat"] as? Bool ?? false) }
        case "page":
            if let path = body["path"] as? String, let title = body["title"] as? String {
                self.path = path
                onPage(path, title, body["box"] as? String)
            }
        case "ended":
            onEnded()
        case "refresh":
            onRefresh()
        case "connection":
            if let reachable = body["reachable"] as? Bool { onConnection(reachable) }
        case "theme":
            if let dark = body["dark"] as? Bool, let colours = body["colours"] as? [String: String],
               let json = try? JSONSerialization.data(withJSONObject: colours),
               let theme = try? JSONDecoder().decode(Theme.Colours.self, from: json) {
                onTheme(theme, dark)
            }
        case "original":
            let files = (body["files"] as? [[String: Any]] ?? []).compactMap { file in
                (file["id"] as? String).flatMap { id in (file["name"] as? String).map { (id: id, name: $0) } }
            }
            if let document = body["documentId"] as? String, !files.isEmpty { onOriginal(document, files) }
        case "brief_pdf":
            if let brief = body["briefId"] as? String { onBriefPDF(brief) }
        default:
            break
        }
    }
}

extension Screens: UIGestureRecognizerDelegate {
    /// The swipe never stops the page's own scrolling.
    func gestureRecognizer(_ gesture: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

extension Screens: WKNavigationDelegate, WKUIDelegate {
    /// The door's own pages load here; web links open in Safari; anything
    /// else (`tel:`, `mailto:`, another app's, `file:`, `data:`) does nothing.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = action.request.url
        switch Screens.route(url, door: isDoor(url), frame: action.targetFrame.map { $0.isMainFrame ? .page : .frame }) {
        case .load: return .allow
        case .safari:
            if let url { await UIApplication.shared.open(url) }
            return .cancel
        case .nothing: return .cancel
        }
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

/// No bar of arrows and Done above the keyboard for a field in a page: a
/// swipe down on the page puts the keyboard away (`swiped`). WebKit asks
/// its web view for the keyboard's accessory view; this one has none.
private final class PageView: WKWebView {
    override var inputAccessoryView: UIView? { nil }
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
            addGestureRecognizer(screens.swipeDown())
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

        override func layoutSubviews() {
            super.layoutSubviews()
            guard window != nil, screens.view.superview === self else { return }
            screens.slot(bottom: convert(bounds, to: nil).maxY)
        }

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            if screens.view.superview === self {
                screens.bars(top: safeAreaInsets.top, bottom: safeAreaInsets.bottom)
            }
        }
    }
}

import SwiftUI
import WebKit

/// A visual in a reply, drawn as the Mac's chat draws it (ADR 0034, "For a
/// screen of its own"): a web view loads the door's card page, which frames
/// the visual's own page and gives it the block and the theme; both pages
/// come as the chat keeps them (VisualPages), with the door's policies. That
/// page is the one guard for what the AI wrote; the app adds only what is its own:
/// nothing navigates, the card is the height the visual says (kept, so a
/// card drawn again doesn't jump), and when WebKit ends its process the card
/// loads once more, then says it can't show the visual. A card whose pages
/// didn't come says so too, and loads again when Rufi is reached.
struct VisualCard: View {
    let html: String
    /// Its entry and place in the reply: where its height is kept.
    let key: String
    let chat: ChatModel
    @Environment(Theme.self) private var theme
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
    @State private var height: Double?
    @State private var broken = false
    @State private var failed = false
    /// Goes up at Reload: a new card.
    @State private var loads = 0

    /// Its height until the visual says, and the most it takes.
    static let waiting = 160.0
    static let tallest = 800.0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if failed {
                HStack(spacing: 8) {
                    Text("Can't show this visual").foregroundStyle(.secondary)
                    Button("Reload", systemImage: "arrow.clockwise") {
                        failed = false
                        loads += 1
                    }
                }
                .font(.subheadline)
                .frame(maxWidth: .infinity, minHeight: 64)
                .background(theme.side, in: .rect(cornerRadius: 8))
            } else {
                let shown = height ?? chat.heights[key] ?? Self.waiting
                CardView(html: html, theme: theme.visual(dark: scheme == .dark, fontSize: fontSize), pages: chat.pages) {
                    let drawn = Self.height($0)
                    height = drawn
                    chat.heights[key] = drawn
                } broke: {
                    broken = true
                } ended: {
                    failed = true
                }
                .id(loads)
                .frame(height: shown)
                .background(height == nil ? theme.side : .clear)
                .clipShape(.rect(cornerRadius: 8))
                .accessibilityLabel("Visual")
                if broken || height == 0 {
                    Text("Part of this visual didn't load").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.bottom, 8)
        .onChange(of: chat.reaches) {
            if failed {
                failed = false
                loads += 1
            }
        }
    }

    /// The height a visual says, as the card takes it: whole points, at most 800.
    static func height(_ said: Double) -> Double {
        min(tallest, max(0, said.rounded(.up)))
    }

    /// Whether a navigation in a card loads: the card page itself, and in
    /// its frame the visual's page, both kept; nothing else.
    static func loads(_ url: URL?, mainFrame: Bool) -> Bool {
        guard let url else { return false }
        if !mainFrame, url.absoluteString == "about:blank" { return true }
        return url == (mainFrame ? VisualPages.card : VisualPages.frame)
    }
}

/// The card's web view. All cards keep nothing: their data store is in memory.
struct CardView: UIViewRepresentable {
    let html: String
    let theme: [String: Any]
    let pages: VisualPages
    let measured: (Double) -> Void
    let broke: () -> Void
    let ended: () -> Void

    private static let store = WKWebsiteDataStore.nonPersistent()

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let view = Self.made(context.coordinator)
        view.load(URLRequest(url: VisualPages.card))
        return view
    }

    /// The card's web view for `coordinator`, before it loads the card page.
    static func made(_ coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = Self.store
        configuration.dataDetectorTypes = []
        configuration.setURLSchemeHandler(coordinator.card.pages, forURLScheme: VisualPages.scheme)
        configuration.userContentController.add(Relay(coordinator), contentWorld: .page, name: "card")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsLinkPreview = false
        view.navigationDelegate = coordinator
        view.uiDelegate = coordinator
        coordinator.view = view
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.card = self
        context.coordinator.themed()
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "card", contentWorld: .page)
        view.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var card: CardView
        weak var view: WKWebView?
        /// The theme the visual has, as JSON: a new one goes to it.
        private var shown: Data?
        private var ready = false
        private var restarted = false

        init(_ card: CardView) {
            self.card = card
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            shown = try? JSONSerialization.data(withJSONObject: card.theme)
            webView.callAsyncJavaScript("rufiCard.show(html, theme)", arguments: ["html": card.html, "theme": card.theme],
                                        in: nil, in: .page, completionHandler: nil)
        }

        /// The theme changed (light or dark, the text size): the visual takes it.
        func themed() {
            guard ready, let view, let json = try? JSONSerialization.data(withJSONObject: card.theme), json != shown
            else { return }
            shown = json
            view.callAsyncJavaScript("rufiCard.theme(theme)", arguments: ["theme": card.theme], in: nil, in: .page,
                                     completionHandler: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let frame = action.targetFrame else { return .cancel }
            return VisualCard.loads(action.request.url, mainFrame: frame.isMainFrame) ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            nil
        }

        /// The card's pages didn't come (Rufi out of reach, not kept yet):
        /// it can't show the visual.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            ready = false
            card.ended()
        }

        /// WebKit ended the card's process (memory): it loads once more.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            ready = false
            if restarted {
                card.ended()
            } else {
                restarted = true
                webView.load(URLRequest(url: VisualPages.card))
            }
        }

        /// The card page's two messages, from the card page alone.
        func received(_ message: WKScriptMessage) {
            let from = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, from.protocol == VisualPages.scheme,
                  from.host == VisualPages.card.host(), from.port == 0,
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "rufi-visual-height": card.measured((body["height"] as? NSNumber)?.doubleValue ?? 0)
            case "rufi-visual-broken": card.broke()
            default: break
            }
        }
    }

    /// Holds the coordinator weakly: the web view keeps its handlers.
    private final class Relay: NSObject, WKScriptMessageHandler {
        weak var coordinator: Coordinator?

        init(_ coordinator: Coordinator) {
            self.coordinator = coordinator
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            coordinator?.received(message)
        }
    }
}

extension Theme {
    /// The theme a visual takes (ADR 0034): light or dark, the chat's text
    /// size, and the colours as CSS variables, as the Mac sends them.
    func visual(dark: Bool, fontSize: CGFloat) -> [String: Any] {
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        let hex = { (colour: UIColor) -> String in
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            colour.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            let byte = { (value: CGFloat) in Int((min(1, max(0, value)) * 255).rounded()) }
            // iOS's text and line colours see through a little.
            return alpha < 1 ? String(format: "rgba(%d, %d, %d, %.2f)", byte(red), byte(green), byte(blue), alpha)
                : String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
        }
        return [
            "scheme": dark ? "dark" : "light",
            "fontSize": "\(Int(fontSize.rounded()))px",
            "variables": [
                "--page": hex(UIColor(page)), "--surface": hex(UIColor(surface)), "--side": hex(UIColor(side)),
                "--line": hex(.separator), "--ink": hex(.label), "--muted": hex(.secondaryLabel),
                "--accent": hex(UIColor(accent)), "--accent-soft": hex(UIColor(accentSoft)),
                "--accent-ink": hex(UIColor(accentInk)), "--on-accent": hex(UIColor(onAccent)),
                "--font-ui": "-apple-system, system-ui, sans-serif",
            ],
        ]
    }
}

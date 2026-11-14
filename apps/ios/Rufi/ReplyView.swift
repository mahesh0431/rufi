import MarkdownUI
import SwiftUI

/// A reply: one Markdown document, as the Mac draws it, with each visual
/// block drawn as a card in its place (ADR 0034). While it is written, it
/// shows as the Mac's Settings › Chat chose (ReplyFlow): its whole blocks,
/// its words, or nothing until it is done.
struct ReplyView: View {
    let entry: Entry
    let streaming: Bool
    let chat: ChatModel
    /// Word by word: its pace, and the words shown, in UTF-16. Until it
    /// starts, the words the reply holds show at once.
    @State private var pace = WordPace()
    @State private var shown: Int?

    var body: some View {
        let flow = streaming ? chat.replyFlow : nil
        let text = switch flow {
        case .paragraphs?: ReplyFlow.finishedBlocks(entry.text)
        case .words?: ReplyFlow.prefix(entry.text, shown ?? ReplyFlow.wordsEnd(entry.text, upTo: entry.text.utf16.count))
        case .whole?: ""
        case nil: entry.text
        }
        // One view in every way, so a card drawn while the reply is written
        // stays as it is when the reply ends.
        if !text.isEmpty {
            ReplyText(text: text, streaming: flow == .words, id: entry.id, chat: chat)
                .task(id: flow == .words ? entry.text : nil) {
                    if flow == .words { await flowWords() }
                }
        }
    }

    /// The words, at a pace that follows how much waits, so uneven parts
    /// from the AI flow evenly. New text restarts this; the pace keeps its
    /// clock, so text that comes faster than a tick still flows.
    private func flowWords() async {
        let text = entry.text
        while true {
            let words = pace.step(text, at: .now)
            if words != shown { shown = words }
            guard !pace.caughtUp(text), (try? await Task.sleep(for: .milliseconds(16))) != nil else { return }
        }
    }
}

/// A reply's text, as shown. While it is still open (word by word), a
/// visual waits as an empty card until its block is whole; its code never
/// shows.
private struct ReplyText: View {
    let text: String
    let streaming: Bool
    let id: String
    let chat: ChatModel

    var body: some View {
        let visuals = Visuals.scan(text)
        RufiMarkdown(text: text) { configuration in
            if Visuals.isVisual(configuration.language) {
                let html = configuration.content
                let place = Visuals.place(of: html, in: visuals)
                if streaming, place.map({ !visuals[$0].whole }) ?? true {
                    RoundedRectangle(cornerRadius: 8).fill(.quaternary)
                        .frame(height: VisualCard.waiting)
                        .padding(.bottom, 8)
                } else {
                    VisualCard(html: html, key: "\(id):\(place ?? 0)", chat: chat)
                }
            } else {
                CodeBlock(configuration: configuration)
            }
        }
    }
}

/// Markdown as the chat draws it: the Mac's sizes, no pictures from the web,
/// links as the chat's `openURL` takes them.
struct RufiMarkdown<Code: View>: View {
    let text: String
    var muted = false
    /// How a code block draws: a reply's visual draws as a card.
    @ViewBuilder var code: (CodeBlockConfiguration) -> Code
    @Environment(Rufi.Theme.self) private var theme
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 17

    var body: some View {
        Markdown(text)
            .markdownTheme(MarkdownUI.Theme.rufi(size: muted ? size * 0.88 : size, theme: theme).codeBlock(body: code))
            .markdownImageProvider(NoImages())
            .markdownInlineImageProvider(NoImages())
            .foregroundStyle(muted ? .secondary : .primary)
            .textSelection(.enabled)
    }
}

extension RufiMarkdown where Code == CodeBlock {
    init(text: String, muted: Bool = false) {
        self.init(text: text, muted: muted) { CodeBlock(configuration: $0) }
    }
}

/// A code block: its text in a box that scrolls sideways.
struct CodeBlock: View {
    let configuration: CodeBlockConfiguration
    @Environment(Rufi.Theme.self) private var theme

    var body: some View {
        ScrollView(.horizontal) {
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .markdownTextStyle {
                    FontFamilyVariant(.monospaced)
                    FontSize(.em(0.85))
                }
                .padding(10)
        }
        .background(theme.side, in: .rect(cornerRadius: 8))
        .markdownMargin(top: .zero, bottom: 8)
    }
}

/// Replies show no pictures from addresses: Rufi's own come as links.
private struct NoImages: ImageProvider, InlineImageProvider {
    func makeImage(url: URL?) -> some View {
        EmptyView()
    }

    func image(with url: URL, label: String) async throws -> Image {
        throw CancellationError()
    }
}

extension MarkdownUI.Theme {
    /// The Mac's reply style: headings at the text's size, a little space
    /// under each block, links in the accent's ink.
    static func rufi(size: CGFloat, theme: Rufi.Theme) -> MarkdownUI.Theme {
        let heading = { (configuration: BlockConfiguration) in
            configuration.label
                .markdownMargin(top: 12, bottom: 4)
                .markdownTextStyle { FontWeight(.semibold) }
        }
        return MarkdownUI.Theme()
            .text { FontSize(size) }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.85))
                BackgroundColor(theme.side)
            }
            .strong { FontWeight(.semibold) }
            .link {
                ForegroundColor(theme.accentInk)
                UnderlineStyle(.single)
            }
            .heading1(body: heading)
            .heading2(body: heading)
            .heading3(body: heading)
            .heading4(body: heading)
            .heading5(body: heading)
            .heading6(body: heading)
            .paragraph { configuration in
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.15))
                    .markdownMargin(top: .zero, bottom: 8)
            }
            .list { $0.label.markdownMargin(top: .zero, bottom: 8) }
            .listItem { $0.label.markdownMargin(top: .em(0.2)) }
            .blockquote { configuration in
                HStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color(.separator)).frame(width: 3)
                    configuration.label
                        .foregroundStyle(.secondary)
                        .padding(.leading, 10)
                }
                .fixedSize(horizontal: false, vertical: true)
                .markdownMargin(top: .zero, bottom: 8)
            }
            .table { configuration in
                ScrollView(.horizontal) {
                    configuration.label
                        .fixedSize(horizontal: false, vertical: true)
                        .markdownTableBorderStyle(.init(.horizontalBorders, color: Color(.separator)))
                }
                .markdownMargin(top: .zero, bottom: 8)
            }
            .tableCell { configuration in
                configuration.label
                    .markdownTextStyle { if configuration.row == 0 { FontWeight(.semibold) } }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
            }
            .thematicBreak { Divider().markdownMargin(top: 8, bottom: 8) }
    }
}

/// The visual blocks in a reply (ADR 0034): fenced code whose info string
/// starts with `rufi-visual`, and whether each is whole yet (its closing
/// fence is in the text).
enum Visuals {
    struct Block: Equatable {
        /// The block's text, without its last line end.
        let html: String
        let whole: Bool
    }

    /// Which block a code block MarkdownUI draws is: its content comes
    /// without the fence's last line end, as `scan` keeps it; a blank last
    /// line stays.
    static func place(of content: String, in visuals: [Block]) -> Int? {
        visuals.firstIndex { $0.html == content }
    }

    static func isVisual(_ info: String?) -> Bool {
        info?.split(whereSeparator: \.isWhitespace).first == "rufi-visual"
    }

    /// Each fence at the top of the text: up to three spaces, then three or
    /// more backticks or tildes; it closes with as many or more of the same.
    static func scan(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var open: (mark: Character, count: Int, indent: Int, visual: Bool, lines: [Substring])?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let indent = line.prefix { $0 == " " }.count
            let rest = line.dropFirst(indent)
            if let fence = open {
                let run = rest.prefix { $0 == fence.mark }.count
                if indent <= 3, run >= fence.count, rest.dropFirst(run).allSatisfy({ $0 == " " || $0 == "\t" }) {
                    if fence.visual { blocks.append(Block(html: fence.lines.joined(separator: "\n"), whole: true)) }
                    open = nil
                } else {
                    // A fence's indent leaves its lines, as Markdown reads them.
                    open?.lines.append(line.dropFirst(min(fence.indent, line.prefix { $0 == " " }.count)))
                }
            } else if indent <= 3, let mark = rest.first, mark == "`" || mark == "~" {
                let run = rest.prefix { $0 == mark }.count
                guard run >= 3 else { continue }
                let info = rest.dropFirst(run).trimmingCharacters(in: .whitespaces)
                open = (mark, run, indent, isVisual(info), [])
            }
        }
        if let fence = open, fence.visual {
            blocks.append(Block(html: fence.lines.joined(separator: "\n"), whole: false))
        }
        return blocks
    }
}

/// Where a link in a reply goes, as the Mac's chat decides it.
enum ReplyLink: Equatable {
    /// A page of this person's: its address in Rufi.
    case page(String)
    /// A web page, in Safari.
    case web
    /// Nothing: a file, Settings (on the Mac only), or an address Rufi doesn't open.
    case nothing

    static func of(_ url: URL, person: String) -> ReplyLink {
        let scheme = url.scheme?.lowercased()
        if scheme == "http" || scheme == "https" { return .web }
        guard scheme == "rufi" else { return .nothing }
        // "rufi:/documents/doc-1": the part after the scheme, as written.
        let written = String(url.absoluteString.dropFirst("rufi:".count))
        guard written.hasPrefix("/"), !written.hasPrefix("//") else { return .nothing }
        let path = written.prefix { $0 != "?" && $0 != "#" }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        if segments.first?.lowercased() == "settings" { return .nothing }
        let decoded = segments.map { $0.removingPercentEncoding ?? String($0) }
        if decoded.contains(where: { $0 == "." || $0 == ".." || $0.contains("\\") || $0.contains("/") }) { return .nothing }
        let at = person.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? person
        return .page("/people/\(at)\(written)")
    }
}

import cmark_gfm
import cmark_gfm_extensions
import Foundation

/// How a reply shows while it is written, as Settings › Chat on the Mac
/// chose, the same as the Mac draws it. Paragraph by paragraph: each
/// top-level Markdown block once the next one has started, as the parser
/// MarkdownUI draws with reads them; the one being written waits. Word by
/// word: the words as they come, at a pace that follows how much waits.
/// Whole reply: nothing until it is done. The reply itself is the same.
enum ReplyFlow: String {
    case paragraphs, words, whole

    /// The reply's blocks that are whole: every top-level block but the
    /// last, which may still grow. "" while the first is being written.
    static func finishedBlocks(_ text: String) -> String {
        cmark_gfm_core_extensions_ensure_registered()
        guard let parser = cmark_parser_new(CMARK_OPT_DEFAULT) else { return "" }
        defer { cmark_parser_free(parser) }
        // The extensions MarkdownUI reads a reply with.
        for name in ["autolink", "strikethrough", "tagfilter", "tasklist", "table"] {
            if let syntax = cmark_find_syntax_extension(name) {
                cmark_parser_attach_syntax_extension(parser, syntax)
            }
        }
        cmark_parser_feed(parser, text, text.utf8.count)
        guard let document = cmark_parser_finish(parser) else { return "" }
        defer { cmark_node_free(document) }
        guard let last = cmark_node_last_child(document) else { return "" }
        // A top-level block starts a line: the text before that line.
        let start = Int(cmark_node_get_start_line(last))
        var line = 1
        var cut = text.startIndex
        while line < start, let newline = text[cut...].firstIndex(of: "\n") {
            line += 1
            cut = text.index(after: newline)
        }
        var finished = text[..<cut]
        while finished.last?.isWhitespace == true { finished.removeLast() }
        return String(finished)
    }

    /// Where the last whole word up to `upTo` (in UTF-16) ends: just before
    /// a space that follows it. 0 when none has. A word at the end waits for
    /// what follows it, so a word, a bold mark or a fence's opening line
    /// shows only whole.
    static func wordsEnd(_ text: String, upTo: Int) -> Int {
        let units = Array(text.utf16)
        let space: (UInt16) -> Bool = { $0 == 0x20 || $0 == 0x0A || $0 == 0x09 || $0 == 0x0D }
        var at = min(upTo, units.count - 1)
        while at > 0 {
            if space(units[at]) && !space(units[at - 1]) { return at }
            at -= 1
        }
        return 0
    }

    /// At least one character every 5 ms; what waits shows within 250 ms.
    static let msPerCharacter = 5.0
    static let catchUpMs = 250.0

    /// How far the flow has come after `ms` more, from `shown` towards
    /// `length`: quicker the more waits, so it keeps up without a jump.
    static func paced(_ shown: Double, length: Int, ms: Double) -> Double {
        let waiting = Double(length) - shown
        guard waiting > 0 else { return Double(length) }
        let perMs = max(waiting / catchUpMs, 1 / msPerCharacter)
        return min(Double(length), shown + ms * perMs)
    }

    /// The first `count` UTF-16 units of `text`, which end at a space.
    static func prefix(_ text: String, _ count: Int) -> String {
        String(decoding: text.utf16.prefix(count), as: UTF16.self)
    }
}

/// Word by word's pace for one reply. It keeps its clock from step to step,
/// new text or not, so the time between steps always counts: text that
/// comes faster than the view's ticks still flows.
struct WordPace {
    private var at: Double?
    private var last: ContinuousClock.Instant?
    /// The most one step counts, so text after a pause (a tool running)
    /// flows too, rather than showing at once.
    static let longestStepMs = 100.0

    /// The whole words of `text` shown `now`: all it holds the first time
    /// (a reply opened while it is written), then as far as the pace came.
    mutating func step(_ text: String, at now: ContinuousClock.Instant) -> Int {
        let length = text.utf16.count
        let since = last.map { min(Self.longestStepMs, max(0, (now - $0) / .milliseconds(1))) } ?? 0
        let paced = at.map { ReplyFlow.paced($0, length: length, ms: since) } ?? Double(length)
        at = paced
        last = now
        return ReplyFlow.wordsEnd(text, upTo: Int(paced))
    }

    /// The pace has reached the end of `text`.
    func caughtUp(_ text: String) -> Bool {
        (at ?? 0) >= Double(text.utf16.count)
    }
}

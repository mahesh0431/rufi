import Testing
@testable import Rufi

/// A reply while it is written, as the Mac draws it (reply-flow.test.ts):
/// paragraph by paragraph only whole blocks, word by word only whole words
/// at a pace that follows how much waits.
struct ReplyFlowTests {
    @Test func paragraphByParagraphShowsEachBlockOnceTheNextStarts() {
        #expect(ReplyFlow.finishedBlocks("Your HbA1c was 6.1") == "")
        #expect(ReplyFlow.finishedBlocks("Your HbA1c was 6.1%.\n\n") == "")
        #expect(ReplyFlow.finishedBlocks("Your HbA1c was 6.1%.\n\n## What it means\n\nIt is a lit")
            == "Your HbA1c was 6.1%.\n\n## What it means")
    }

    @Test func aListATableAndAVisualWaitUntilTheyEnd() {
        let list = "Two things:\n\n- fasting glucose\n- HbA1c\n\n"
        #expect(ReplyFlow.finishedBlocks(list) == "Two things:")
        #expect(ReplyFlow.finishedBlocks(list + "- lipids") == "Two things:")
        #expect(ReplyFlow.finishedBlocks(list + "Both are fine.") == "Two things:\n\n- fasting glucose\n- HbA1c")
        let table = "| Test | Value |\n| --- | --- |\n| HbA1c | 6.1% |\n"
        #expect(ReplyFlow.finishedBlocks("Lab:\n\n" + table) == "Lab:")
        #expect(ReplyFlow.finishedBlocks("Lab:\n\n" + table + "\nDone") == "Lab:\n\n" + table.dropLast())
        let visual = "```rufi-visual\n<div>\n\n<p>Chart</p>\n</div>\n```"
        #expect(ReplyFlow.finishedBlocks("Drawn:\n\n" + visual.prefix(30)) == "Drawn:")
        #expect(ReplyFlow.finishedBlocks("Drawn:\n\n" + visual) == "Drawn:")
        #expect(ReplyFlow.finishedBlocks("Drawn:\n\n" + visual + "\n\nAs you see") == "Drawn:\n\n" + visual)
    }

    @Test func wordByWordEndsAtAWholeWord() {
        let text = "Your **HbA1c** was 6.1%"
        #expect(ReplyFlow.wordsEnd(text, upTo: 3) == 0)
        #expect(ReplyFlow.wordsEnd(text, upTo: 10) == 4)
        #expect(ReplyFlow.wordsEnd(text, upTo: 14) == 14)
        #expect(ReplyFlow.wordsEnd(text, upTo: text.utf16.count) == 18)
        #expect(ReplyFlow.wordsEnd(text + " ", upTo: text.utf16.count + 1) == text.utf16.count)
        let fence = "Drawn:\n\n```rufi-visual\n<div>"
        #expect(ReplyFlow.prefix(fence, ReplyFlow.wordsEnd(fence, upTo: 20)) == "Drawn:")
        #expect(ReplyFlow.prefix(fence, ReplyFlow.wordsEnd(fence, upTo: fence.utf16.count)) == "Drawn:\n\n```rufi-visual")
    }

    @Test func thePaceFollowsHowMuchWaits() {
        #expect(abs(ReplyFlow.paced(0, length: 10, ms: 16) - 3.2) < 0.001)
        #expect(abs(ReplyFlow.paced(0, length: 1000, ms: 16) - 64) < 0.001)
        #expect(ReplyFlow.paced(5, length: 10, ms: 1000) == 10)
        #expect(ReplyFlow.paced(10, length: 10, ms: 16) == 10)
    }

    /// As the view runs it: each new text restarts its loop, which steps at
    /// once; text that comes every 8 ms cancels its 16 ms tick each time.
    @Test func wordsKeepFlowingWhenTextComesFasterThanATick() {
        var pace = WordPace()
        let start = ContinuousClock.now
        var text = ""
        var shown: [Int] = []
        for part in 0..<60 {
            text += "word "
            shown.append(pace.step(text, at: start.advanced(by: .milliseconds(8 * part))))
        }
        // The first word shows at once; then whole words go on showing
        // while the text still comes, at least one character every 5 ms.
        #expect(shown.first == 4)
        #expect(shown[30] > shown[10] && shown[59] > shown[30])
        #expect(shown[59] >= 8 * 59 / 5 - 5)
        // A pause lets it catch up with all the text.
        var last = start.advanced(by: .milliseconds(8 * 59))
        while !pace.caughtUp(text) {
            last = last.advanced(by: .milliseconds(16))
            _ = pace.step(text, at: last)
        }
        #expect(pace.step(text, at: last) == text.utf16.count - 1)
    }

    /// The fence's last line end is MarkdownUI's to drop: a visual whose
    /// last line is blank is still found whole, and draws before the end.
    @Test func aVisualEndingInABlankLineIsWhole() {
        let text = "```rufi-visual\n<p>Fictional HbA1c: 6.1%</p>\n\n```\n\nHere is what it means."
        let visuals = Visuals.scan(text)
        // MarkdownUI's content for this block: cmark's, less one line end.
        let content = "<p>Fictional HbA1c: 6.1%</p>\n"
        let place = Visuals.place(of: content, in: visuals)
        #expect(place.map { visuals[$0].whole } == true)
    }
}

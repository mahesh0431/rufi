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
}

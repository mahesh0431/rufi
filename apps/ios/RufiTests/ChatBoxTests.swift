import Foundation
import Testing
@testable import Rufi

/// The box shows what the page says, but the page's text never undoes typing,
/// and it opens while something is in it; what a page drawn here asks it
/// waits for a box to take it. What is chosen to add goes in whole, or not at all.
struct ChatBoxTests {
    private func state(text: String?, chips: String = "[]", ready: Bool = true) -> Data {
        let text = text.map { "\"\($0)\"" } ?? "null"
        return Data("""
            {"type":"box","text":\(text),"placeholder":"Ask","chips":\(chips),"ready":\(ready),"button":"send",
             "canSend":false,"model":{"id":"m","name":"M"},"effort":{"id":"e","name":"E"},"models":[],
             "signIn":[],"efforts":[],"effortWords":"","meter":null,"line":null,"retry":false,"closed":null,
             "asked":0,"panel":false}
            """.utf8)
    }

    @Test func typingStaysWhenThePageTellsWithoutText() {
        let box = ChatBox()
        var asked: [[String: Any]] = []
        box.asking = { asked.append($0) }
        box.took(state(text: "Draft"))
        box.typed("Draft and more")
        box.took(state(text: nil))
        #expect(box.text == "Draft and more")
        #expect(asked.last?["text"] as? String == "Draft and more")
        #expect(box.open(focused: false))
        box.took(state(text: ""))
        #expect(box.text == "")
        #expect(!box.open(focused: false))
        box.took(state(text: nil, chips: #"[{"key":"k","label":"HbA1c","kind":"test"}]"#))
        #expect(box.open(focused: false))
    }

    /// A waiting message Rufi refused, put back while the page is still
    /// loading: the page's draft doesn't replace it, and it leaves the
    /// waiting list only once the page's box holds it.
    @Test func wordsPutBackStayUntilThePageHasThem() {
        let box = ChatBox()
        var asked: [String] = []
        var restored: Set<String> = []
        box.asking = { asked.append($0["text"] as? String ?? "") }
        box.restored = { restored = $0 }
        let refused = PendingMessage(id: "m-1", text: "Here is my whole week of readings")
        box.giveBack(refused, refused: "That message is too long for Rufi.")
        // The page, not ready yet, then its draft from the Mac.
        box.took(state(text: nil, ready: false))
        box.took(state(text: "Typed on the Mac"))
        #expect(box.text == "Typed on the Mac\nHere is my whole week of readings")
        #expect(asked.last == box.text)
        #expect(box.said == "That message is too long for Rufi.")
        #expect(restored.isEmpty)
        // The page took them.
        box.took(state(text: nil))
        #expect(restored == ["m-1"])
    }

    /// From Help, which has no box, to Documents: Save in chat's chip and
    /// words wait for the chat's box, and go to it once.
    @Test func anAskWaitsForABoxToTakeIt() {
        let box = ChatBox()
        var asked: [String] = []
        box.asking = { command in
            if command["type"] as? String == "ask" { asked.append(command["text"] as? String ?? "") }
        }
        box.put(["type": "ask", "chips": [], "text": "Save these 2 results."])
        #expect(asked.isEmpty)
        box.kind = .page
        box.took(state(text: nil, ready: false))
        #expect(asked.isEmpty)
        box.took(state(text: nil))
        box.took(state(text: nil))
        #expect(asked == ["Save these 2 results."])
    }

    @Test func chosenFilesGoInWholeOrNotAtAll() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let page = folder.appending(path: "Fictional report page 1.pdf")
        try Data("%PDF-1.4 fictional".utf8).write(to: page)
        let gone = folder.appending(path: "Fictional report page 2.pdf")
        #expect(Chosen.files([page, gone]) == nil)
        #expect(Chosen.files([page])?.map(\.name) == ["Fictional report page 1.pdf"])
    }
}

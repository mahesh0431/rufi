import Foundation
import Testing
@testable import Rufi

/// The box shows what the page says, but the page's text never undoes typing,
/// and it opens while something is in it. What is chosen to add goes in
/// whole, or not at all.
struct ChatBoxTests {
    private func state(text: String?, chips: String = "[]") -> Data {
        let text = text.map { "\"\($0)\"" } ?? "null"
        return Data("""
            {"type":"box","text":\(text),"placeholder":"Ask","chips":\(chips),"ready":true,"button":"send",
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

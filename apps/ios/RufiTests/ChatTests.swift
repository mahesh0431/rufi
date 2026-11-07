import Foundation
import Testing
@testable import Rufi

/// The chat drawn here: what the Mac's chat routes answer (the fixtures),
/// in the Mac's order; a late read never undoes a newer one; a visual's
/// card loads only the door's two pages; a reply's links open only the
/// person's pages; and a send goes through Pending, once.
@MainActor
struct ChatTests {
    init() {
        Door.standIn = StandInDoor.self
    }

    private func read<Answer: Decodable>(_ name: String, as: Answer.Type = Answer.self) throws -> Answer {
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/\(name).json")
        return try JSONDecoder().decode(Answer.self, from: Data(contentsOf: file))
    }

    @Test func aPageFromTheMacShowsInItsOrder() throws {
        var transcript = Transcript()
        transcript.apply(.snapshot(try read("chat")))
        _ = try read("chat-draft", as: Draft.self)
        _ = try read("chat-queue", as: Queue.self)
        // The reply's thought and step fold into its Activity, under the answer.
        #expect(transcript.lines(calendar: Self.berlin) == [
            .day("ent-a1"), .entry("ent-a1"), .entry("ent-a4"), .activity("turn-a1"),
        ])
        #expect(transcript.steps(of: "turn-a1").map(\.id) == ["ent-a2", "ent-a3"])
        let reply = try #require(transcript.entries["ent-a4"])
        #expect(Visuals.scan(reply.text) == [Visuals.Block(html: "<p>6.8 %</p>", whole: true)])
        #expect(!transcript.streaming(reply))
    }

    @Test func aLateReadNeverUndoesANewerOne() throws {
        var transcript = Transcript()
        let page: ChatPage = try read("chat")
        transcript.apply(.snapshot(page))
        let reply = try #require(transcript.entries["ent-a4"])
        let newer = Entry(id: reply.id, seq: reply.seq, turnId: reply.turnId, kind: reply.kind, text: "Newer",
                          activity: nil, detail: nil, status: "done", createdAt: reply.createdAt,
                          updatedAt: reply.updatedAt, refs: nil, link: nil, agent: nil, from: nil)
        transcript.apply(.update(revision: 6, entries: [newer], turns: [], chat: nil))
        // An older page read before that update: its copy of the reply stays out.
        transcript.addOlder(ChatPage(revision: 5, chat: page.chat, entries: [reply], turns: [], before: nil),
                            window: transcript.window)
        #expect(transcript.entries["ent-a4"]?.text == "Newer")
        // One asked for before a reconnect changes nothing.
        let window = transcript.window
        transcript.apply(.snapshot(page))
        transcript.addOlder(ChatPage(revision: 9, chat: page.chat, entries: [newer], turns: [], before: nil), window: window)
        #expect(transcript.entries["ent-a4"]?.text == reply.text)
    }

    /// A held message goes only when the person says, and only as its hold
    /// allows: a new thread only between replies; steer only into a running one.
    @Test func aHeldMessageGoesOnlyWhenThePersonSays() throws {
        let queue: Queue = try read("chat-queue")
        let stopped = try #require(queue.items.first { $0.held == "stopped" })
        let unopened = try #require(queue.items.first { $0.held == "open_failed" })
        #expect(unopened.holdId == "hold-a2")
        #expect(WaitingRow.actions(stopped, running: false) == [.send, .edit, .remove])
        #expect(WaitingRow.actions(unopened, running: false) == [.send, .newThread, .edit, .remove])
        #expect(WaitingRow.actions(unopened, running: true) == [.send, .edit, .remove])
        let free = QueueItem(id: "q-3", origin: "person", text: "One more", state: "waiting", held: nil, heldText: nil,
                             holdId: nil, refs: [])
        #expect(WaitingRow.actions(free, running: true) == [.steer, .edit, .remove])
        #expect(WaitingRow.actions(free, running: false) == [.edit, .remove])
        // Rufi's note is never the person's to edit; one being given to the AI, nothing.
        let note = QueueItem(id: "q-4", origin: "rufi", text: "A document was read.", state: "waiting", held: nil,
                             heldText: nil, holdId: nil, refs: [])
        #expect(WaitingRow.actions(note, running: false) == [.remove])
        let going = QueueItem(id: "q-5", origin: "person", text: "Now", state: "handing_over", held: nil, heldText: nil,
                              holdId: nil, refs: [])
        #expect(WaitingRow.actions(going, running: true).isEmpty)
    }

    @Test func aVisualWaitsUntilItsBlockIsWhole() {
        let streaming = "Drawn:\n\n```rufi-visual\n<p>One</p>\n```\n\n~~~~ rufi-visual wide\n<p>Two</p>\n~~~"
        #expect(Visuals.scan(streaming) == [
            Visuals.Block(html: "<p>One</p>", whole: true), Visuals.Block(html: "<p>Two</p>\n~~~", whole: false),
        ])
        // Other code, and a fence indented as code, stay code.
        #expect(Visuals.scan("```swift\nlet a = 1\n```\n\n    ```rufi-visual\n    <p>x</p>\n    ```").isEmpty)
    }

    @Test func aCardLoadsOnlyTheDoorsTwoPages() throws {
        let door = try #require(URL(string: "https://mac.tailnet.test"))
        let at = { (address: String) in URL(string: address) }
        #expect(VisualCard.loads(at("https://mac.tailnet.test/visual-card.html"), door: door, mainFrame: true))
        #expect(VisualCard.loads(at("https://mac.tailnet.test/visual-frame.html"), door: door, mainFrame: false))
        #expect(!VisualCard.loads(at("https://mac.tailnet.test/visual-frame.html"), door: door, mainFrame: true))
        #expect(!VisualCard.loads(at("https://mac.tailnet.test/api/people/asha/chat"), door: door, mainFrame: false))
        #expect(!VisualCard.loads(at("https://elsewhere.test/visual-frame.html"), door: door, mainFrame: false))
        #expect(!VisualCard.loads(at("https://mac.tailnet.test:8443/visual-card.html"), door: door, mainFrame: true))
        #expect(!VisualCard.loads(at("data:text/html,hi"), door: door, mainFrame: false))
    }

    @Test func aReplysLinksOpenOnlyThePersonsPages() throws {
        let link = { (address: String) throws in ReplyLink.of(try #require(URL(string: address)), person: "asha") }
        #expect(try link("rufi:/tests/tst-hba1c") == .page("/people/asha/tests/tst-hba1c"))
        #expect(try link("rufi:/record/condition?open=cond-a1") == .page("/people/asha/record/condition?open=cond-a1"))
        #expect(try link("https://example.com/hba1c") == .web)
        // Settings are on the Mac; a path that leaves the person's pages, and a file, open nothing.
        #expect(try link("rufi:/settings/chat") == .nothing)
        #expect(try link("rufi:/../ravi/chat") == .nothing)
        #expect(try link("rufi:/%2e%2e/ravi/chat") == .nothing)
        #expect(try link("rufi://ravi/chat") == .nothing)
        #expect(try link("file:///Users/asha/scan.png") == .nothing)
        #expect(try link("mailto:clinic@example.com") == .nothing)
    }

    /// Kept on the iPhone first, so Rufi out of reach loses nothing; sent
    /// again under its own id when Rufi is back, so the Mac has it once.
    @Test func aSendGoesThroughPendingOnce() async throws {
        let pending = Pending(file: PendingTests.file())
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: pending)
        ChatDoor.away = true
        chat.open()
        for _ in 0..<100 where !chat.loaded { try await Task.sleep(for: .milliseconds(20)) }
        try #require(chat.loaded)

        chat.typed("I took my Metformin")
        #expect(chat.append("", [Chip(type: "document", id: "doc-asha-aug", label: "")]))
        chat.send()
        #expect(chat.text.isEmpty && chat.chips.isEmpty)
        await chat.deliver()
        #expect(pending.messages.map(\.text) == ["I took my Metformin"])
        #expect(chat.outgoing.map(\.state) == [.pending])

        ChatDoor.away = false
        await chat.deliver()
        await chat.deliver()
        #expect(pending.messages.isEmpty)
        let sent = ChatDoor.sent
        #expect(sent.count == 1)
        #expect(sent.first?.refs == ["doc-asha-aug"])
        // Taken: shown as sent until the chat has it.
        #expect(chat.outgoing.map(\.state) == [.sent])
        let id = try #require(sent.first?.id)
        chat.take(.update(revision: 1, entries: [Entry(
            id: id, seq: 1, turnId: nil, kind: "message", text: "I took my Metformin", activity: nil, detail: nil,
            status: nil, createdAt: "2026-10-05T08:00:00Z", updatedAt: "2026-10-05T08:00:00Z", refs: nil, link: nil,
            agent: nil, from: nil)], turns: [], chat: nil))
        #expect(chat.outgoing.isEmpty)
        chat.close()
    }

    static let berlin = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return calendar
    }()
}

/// The chat's routes on the Mac, for `aSendGoesThroughPendingOnce`: a draft,
/// no stream, and messages taken once each by id, or Rufi out of reach.
enum ChatDoor {
    struct Sent {
        let id: String
        let refs: [String]
    }

    nonisolated(unsafe) static var away = false
    nonisolated(unsafe) static var sent: [Sent] = []

    nonisolated static func answer(_ request: URLRequest) -> (Int, String)? {
        guard request.url?.host() == "chat.test" else { return nil }
        switch (request.httpMethod ?? "GET", request.url?.path() ?? "") {
        case ("GET", "/api/people/asha/chat/draft"), ("PUT", "/api/people/asha/chat/draft"):
            return (200, #"{"text":"","refs":[]}"#)
        case ("POST", "/api/people/asha/chat/messages"):
            if away { return (502, "") }
            struct Message: Decodable {
                struct Ref: Decodable { let id: String }
                let id: String
                let refs: [Ref]
            }
            guard let message = try? JSONDecoder().decode(Message.self, from: body(request)) else { return (400, "") }
            if !sent.contains(where: { $0.id == message.id }) {
                sent.append(Sent(id: message.id, refs: message.refs.map(\.id)))
            }
            return (202, #"{"id":"\#(message.id)","draft":{"text":"","refs":[]}}"#)
        default:
            return (404, #"{"error":"Not found."}"#)
        }
    }

    /// A request's body, which URLSession hands a stand-in as a stream.
    nonisolated private static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

import Foundation
import Testing
@testable import Rufi

/// The chat drawn here: what the Mac's chat routes answer (the fixtures),
/// in the Mac's order; a late read never undoes a newer one; a visual's
/// card loads only the door's two pages; a reply's links open only the
/// person's pages; a send goes through Pending, once; and an edit of a
/// waiting message says whether Rufi kept it.
@MainActor
@Suite(.serialized)
struct ChatTests {
    init() {
        Door.standIn = StandInDoor.self
        ChatDoor.reset()
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

    /// An edit says whether Rufi kept it, which the editor waits for: it
    /// closes once the words are kept, and stays open with them and why
    /// when they aren't, as for a message that went meanwhile.
    @Test func anEditSaysWhetherRufiKeptItsWords() async {
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: Pending(file: PendingTests.file()))
        #expect(await chat.change("PUT", "/q-1", body: ["text": "Fictional corrected question"]))
        #expect(chat.queue.map(\.text) == ["Fictional corrected question"])
        #expect(await !chat.change("PUT", "/q-gone", body: ["text": "Fictional rewritten question"]))
        #expect(chat.queueProblem == "Not found.")
        #expect(chat.queue.map(\.text) == ["Fictional corrected question"])
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

    /// A visual's button: its message goes through Pending as the person's
    /// own, as Enter would while a reply runs, and the box keeps its words.
    @Test func aCardsAnswerGoesAsTheirMessageAndTheBoxKeepsItsWords() async throws {
        let pending = Pending(file: PendingTests.file())
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: pending)
        ChatDoor.whileReplying = "queue"
        chat.open()
        try await Self.until { chat.loaded && chat.whileReplying == "queue" }
        chat.typed("And my ferritin")
        #expect(chat.append("", [Chip(type: "document", id: "doc-asha-aug", label: "")]))

        chat.answer("Yes, save metformin 500 mg, twice a day")
        try await Self.until { ChatDoor.sent.count == 1 }
        // A reply runs: the next goes as the Mac's setting says (Queue here).
        chat.take(.update(revision: 1, entries: [], turns: [Self.running], chat: nil))
        chat.answer("  Not now, don't save metformin  ")
        chat.answer("   ")
        try await Self.until { ChatDoor.sent.count == 2 }
        try await Task.sleep(for: .milliseconds(100))

        #expect(ChatDoor.sent.map(\.text) == ["Yes, save metformin 500 mg, twice a day", "Not now, don't save metformin"])
        #expect(ChatDoor.sent.map(\.kind) == [nil, "queue"])
        #expect(ChatDoor.sent.map(\.refs) == [[], []])
        #expect(chat.text == "And my ferritin")
        #expect(chat.chips.map(\.ref.id) == ["doc-asha-aug"])
        #expect(pending.messages.isEmpty)
        chat.end()
    }

    /// A card's answer is the pairing's own: one that comes after its
    /// pairing ended is never kept, so the next pairing never sends it,
    /// also when the chat hadn't yet heard that its pairing ended.
    @Test func aCardsLateAnswerNeverGoesToTheNextPairing() async throws {
        let pending = Pending(file: PendingTests.file())
        let door = Door(origin: URL(string: "https://chat.test")!, key: "a-key")
        // Unpaired, as AppModel does it: the chat ends, the messages go.
        let ended = ChatModel(door: door, person: "asha", pending: pending)
        ended.end()
        pending.clear()
        ended.answer("Yes, save metformin 500 mg, twice a day")
        #expect(pending.messages.isEmpty)
        // Unpaired again before this chat heard of it.
        let unaware = ChatModel(door: door, person: "asha", pending: pending)
        pending.clear()
        unaware.answer("Not now, don't save metformin")
        #expect(pending.messages.isEmpty)

        // The pairing now: it sends its own answer, and only that.
        let current = ChatModel(door: door, person: "asha", pending: pending)
        current.open()
        try await Self.until { current.loaded }
        current.answer("Yes, add a follow-up for my HbA1c")
        try await Self.until { ChatDoor.sent.count == 1 }
        await current.deliver()
        #expect(ChatDoor.sent.map(\.text) == ["Yes, add a follow-up for my HbA1c"])
        #expect(pending.messages.isEmpty)
        current.end()
    }

    /// A refused message's words go back in the box, and the message stays
    /// kept on the iPhone until a save of the box with its words is kept:
    /// a save that started before it doesn't count.
    @Test func aRefusedMessageStaysKeptUntilASaveHoldsIt() async throws {
        let file = PendingTests.file()
        let pending = Pending(file: file)
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: pending)
        chat.open()
        try await Self.until { chat.loaded }
        let held = DispatchSemaphore(value: 0)
        ChatDoor.holds["PUT /api/people/asha/chat/draft"] = held
        chat.typed("Earlier draft")
        chat.save()
        try await Self.until { ChatDoor.holds.isEmpty }

        ChatDoor.refusing = true
        try pending.add("Fictional symptom message")
        await chat.deliver()
        #expect(chat.text == "Earlier draft\n\nFictional symptom message")
        // The earlier save is kept, with only its own words; the one with the message can't reach the Mac.
        ChatDoor.awayFor = "Fictional symptom message"
        held.signal()
        try await Self.until { chat.failed }
        #expect(ChatDoor.saves == ["Earlier draft"])
        #expect(Pending(file: file).messages.map(\.text) == ["Fictional symptom message"])
        chat.end()
    }

    /// A chat whose pairing ended saves nothing more: not a save waiting
    /// behind one on its way, whose words would replace the new pairing's draft.
    @Test func anEndedChatNeverSavesAgain() async throws {
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: Pending(file: PendingTests.file()))
        chat.open()
        try await Self.until { chat.loaded }
        let held = DispatchSemaphore(value: 0)
        ChatDoor.holds["PUT /api/people/asha/chat/draft"] = held
        chat.typed("First old draft")
        chat.save()
        try await Self.until { ChatDoor.holds.isEmpty }
        chat.typed("Second old draft")
        chat.save()
        chat.typed("Old pairing's unsent words")
        chat.save()
        chat.end()
        // The save on its way comes back; nothing after it goes.
        held.signal()
        try await Task.sleep(for: .milliseconds(300))
        #expect(ChatDoor.saves == ["First old draft"])
    }

    /// The box's first read, asked again as Rufi goes to the background and
    /// back, is one read: a late one never replaces words typed since.
    @Test func aLateFirstReadNeverReplacesWordsTyped() async throws {
        ChatDoor.draft = #"{"text":"Old draft","refs":[]}"#
        let held = DispatchSemaphore(value: 0)
        ChatDoor.holds["GET /api/people/asha/chat/draft"] = held
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: Pending(file: PendingTests.file()))
        chat.open()
        try await Self.until { ChatDoor.holds.isEmpty }
        chat.close()
        chat.open()
        try await Task.sleep(for: .milliseconds(300))
        #expect(ChatDoor.draftReads == 1)
        held.signal()
        try await Self.until { chat.loaded }
        chat.typed("New health question")
        try await Task.sleep(for: .milliseconds(300))
        #expect(chat.text == "New health question")
        chat.end()
    }

    /// Waits up to two seconds for `done`.
    static func until(_ done: () -> Bool) async throws {
        for _ in 0..<100 where !done() { try await Task.sleep(for: .milliseconds(20)) }
        try #require(done())
    }

    /// A reply running on the Mac.
    static let running = Turn(id: "turn-running", model: "gpt-6-astra", effort: nil, before: nil, status: "running",
                              endReason: nil, endText: nil, resetsAt: nil, startedAt: "2026-10-05T08:00:00Z",
                              endedAt: nil, stepsGone: nil)

    static let berlin = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return calendar
    }()
}

/// The chat's routes on the Mac, for `aSendGoesThroughPendingOnce`: a draft,
/// no stream, messages taken once each by id, or Rufi out of reach, and one
/// waiting message to edit.
enum ChatDoor {
    struct Sent {
        let id: String
        let refs: [String]
        var text = ""
        var kind: String?
    }

    nonisolated(unsafe) static var away = false
    nonisolated(unsafe) static var sent: [Sent] = []
    /// The draft the Mac has, as its first read answers it.
    nonisolated(unsafe) static var draft = #"{"text":"","refs":[]}"#
    /// Requests ("PUT /api/people/asha/chat/draft") the test holds: the
    /// first of each waits until the test signals.
    nonisolated(unsafe) static var holds: [String: DispatchSemaphore] = [:]
    nonisolated(unsafe) static var draftReads = 0
    /// Messages refused, as when the Mac needs a sign-in.
    nonisolated(unsafe) static var refusing = false
    /// Settings › Chat › While a reply runs, as the Mac's settings answer it;
    /// none: the settings aren't read.
    nonisolated(unsafe) static var whileReplying: String?
    /// Draft saves can't reach the Mac.
    nonisolated(unsafe) static var savesAway = false
    /// A save whose words have this can't reach the Mac.
    nonisolated(unsafe) static var awayFor: String?
    /// The words of each save that reached the Mac, in order.
    nonisolated(unsafe) static var saves: [String] = []

    static func reset() {
        (away, sent, draft, holds, draftReads, refusing, savesAway, awayFor, saves) =
            (false, [], #"{"text":"","refs":[]}"#, [:], 0, false, false, nil, [])
        whileReplying = nil
    }

    /// The hold for this request, if the test holds it.
    nonisolated static func gate(_ request: URLRequest) -> DispatchSemaphore? {
        guard request.url?.host() == "chat.test" else { return nil }
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
        if key == "GET /api/people/asha/chat/draft" { draftReads += 1 }
        return holds.removeValue(forKey: key)
    }

    nonisolated static func answer(_ request: URLRequest) -> (Int, String)? {
        guard request.url?.host() == "chat.test" else { return nil }
        switch (request.httpMethod ?? "GET", request.url?.path() ?? "") {
        case ("GET", "/api/people/asha/chat/draft"):
            return (200, draft)
        case ("GET", "/api/settings"):
            guard let whileReplying else { return (404, #"{"error":"Not found."}"#) }
            return (200, #"{"activity":"folded","whileReplying":"\#(whileReplying)","replyFlow":"paragraphs"}"#)
        case ("PUT", "/api/people/asha/chat/draft"):
            // Kept as it came: its words come back.
            struct Saved: Decodable { let text: String }
            let text = (try? JSONDecoder().decode(Saved.self, from: body(request)))?.text ?? ""
            if savesAway || awayFor.map(text.contains) == true { return (502, "") }
            saves.append(text)
            let answer = try? JSONSerialization.data(withJSONObject: ["text": text, "refs": []])
            return (200, answer.map { String(decoding: $0, as: UTF8.self) } ?? "")
        case ("PUT", "/api/people/asha/chat/queue/q-1"):
            // The waiting message with its new words.
            struct Edit: Decodable { let text: String }
            let text = (try? JSONDecoder().decode(Edit.self, from: body(request)))?.text ?? ""
            let item: [String: Any?] = ["id": "q-1", "origin": "person", "text": text, "state": "waiting", "held": nil,
                                        "heldText": nil, "holdId": nil, "refs": []]
            let answer = try? JSONSerialization.data(withJSONObject: ["items": [item.mapValues { $0 ?? NSNull() }]])
            return (200, answer.map { String(decoding: $0, as: UTF8.self) } ?? "")
        case ("POST", "/api/people/asha/chat/messages"):
            if away { return (502, "") }
            if refusing { return (400, #"{"error":"Sign in to Claude on your Mac."}"#) }
            struct Message: Decodable {
                struct Ref: Decodable { let id: String }
                let id: String
                let refs: [Ref]
                let text: String
                let kind: String?
            }
            guard let message = try? JSONDecoder().decode(Message.self, from: body(request)) else { return (400, "") }
            if !sent.contains(where: { $0.id == message.id }) {
                sent.append(Sent(id: message.id, refs: message.refs.map(\.id), text: message.text, kind: message.kind))
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

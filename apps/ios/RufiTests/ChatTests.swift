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
        // The reply's thought and step fold into its Activity, under the
        // answer; its question card and the click that quotes it follow.
        #expect(transcript.lines(calendar: Self.berlin) == [
            .day("ent-a1"), .entry("ent-a1"), .entry("ent-a4"), .activity("turn-a1"),
            .entry("ent-a5"), .entry("ent-a6"),
        ])
        #expect(transcript.entries["ent-a5"]?.question?.answers == ["Save", "Not now"])
        #expect(transcript.entries["ent-a5"]?.answer == CardAnswer(message: "ent-a6", index: 0))
        #expect(transcript.entries["ent-a6"]?.refs?.map(\.ref) == [Pointer(type: "question", id: "ent-a5", answer: 0)])
        #expect(transcript.steps(of: "turn-a1").map(\.id) == ["ent-a2", "ent-a3"])
        let reply = try #require(transcript.entries["ent-a4"])
        #expect(Visuals.scan(reply.text) == [Visuals.Block(html: "<p>6.8 %</p>", whole: true)])
        #expect(!transcript.streaming(reply))
    }

    /// The words Rufi AI wrote just before a card: a progress note in the
    /// reply's Activity while it runs, then, with the card, a reply by the
    /// same id, shown above the card and gone from Activity.
    @Test func theWordsBeforeACardShowAboveIt() throws {
        let entry = { (id: String, seq: Double, kind: String, activity: String?, text: String, card: String?) throws -> Entry in
            let fields: [String: Any?] = [
                "id": id, "seq": seq, "turnId": Self.running.id, "kind": kind, "text": text,
                "activity": activity, "detail": nil, "status": "done",
                "createdAt": "2026-10-05T08:00:00Z", "updatedAt": "2026-10-05T08:00:00Z",
                "card": try card.map { try JSONSerialization.jsonObject(with: Data($0.utf8)) },
            ]
            let json = try JSONSerialization.data(withJSONObject: fields.compactMapValues { $0 })
            return try JSONDecoder().decode(Entry.self, from: json)
        }
        let card = try entry("q-visit", 4, "question", nil, "**Next visit**", Self.visit)
        var transcript = Transcript()
        transcript.apply(.update(revision: 1, entries: [
            try entry("m-1", 1, "message", nil, "Where can I book my visit?", nil),
            try entry("n-1", 1.000001, "activity", "note", "Dr Rao has two slots.", nil),
        ], turns: [Self.running], chat: nil))
        #expect(transcript.steps(of: Self.running.id).map(\.id) == ["n-1"])

        transcript.apply(.update(revision: 2, entries: [
            try entry("n-1", 3, "reply", nil, "Dr Rao has two slots.", nil), card,
        ], turns: [], chat: nil))
        #expect(transcript.steps(of: Self.running.id).isEmpty)
        let lines = transcript.lines(calendar: Self.berlin)
        let above = try #require(lines.firstIndex(of: .entry("n-1")))
        let below = try #require(lines.firstIndex(of: .entry(card.id)))
        #expect(above < below)
    }

    /// A card of a kind the iPhone doesn't draw reads as its words: the
    /// chat around it still reads.
    @Test func aCardOfAKindTheIPhoneDoesntDrawShowsItsWords() throws {
        let later = try Self.card(#"{"kind":"date","key":"Next scan","question":"Which day suits you?"}"#)
        #expect(later.kind == "question" && later.question == nil)
        #expect(later.text.hasPrefix("**Next visit**"))
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

    /// A tap on a card's answer: kept on the iPhone with the card's quote and
    /// the answer's place, through a reload of its file, once however often
    /// it is tapped, and sent with them; the box keeps its words.
    @Test func aCardsAnswerGoesThroughPendingWithItsPlaceOnce() async throws {
        let file = PendingTests.file()
        let pending = Pending(file: file)
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: pending)
        ChatDoor.away = true
        chat.open()
        try await Self.until { chat.loaded }
        chat.typed("And my ferritin")
        let card = try Self.card(Self.visit)
        chat.take(.update(revision: 1, entries: [card], turns: [], chat: nil))

        chat.choose(0, on: card)
        chat.choose(0, on: card)
        chat.choose(1, on: card)
        await chat.deliver()
        #expect(chat.click(on: card) == .pending(0))
        let kept = Pending(file: file).messages
        #expect(kept.map(\.text) == ["Book"])
        #expect(kept.first?.refs?.map(\.ref) == [Pointer(type: "question", id: "q-visit", answer: 0)])
        #expect(kept.first?.refs?.map(\.label) == ["Next visit"])

        ChatDoor.away = false
        await chat.deliver()
        #expect(ChatDoor.sent.map(\.text) == ["Book"])
        #expect(ChatDoor.sent.first?.refs == ["q-visit"])
        #expect(ChatDoor.sent.first?.answers == [0])
        #expect(chat.click(on: card) == .sending(0))
        #expect(chat.text == "And my ferritin")
        chat.end()
    }

    /// A tap while a reply runs goes as the Mac's setting says (Queue here),
    /// as Enter in the box would.
    @Test func aCardsTapWhileAReplyRunsGoesAsTheMacsSettingSays() async throws {
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: Pending(file: PendingTests.file()))
        ChatDoor.whileReplying = "queue"
        chat.open()
        try await Self.until { chat.loaded && chat.whileReplying == "queue" }
        let card = try Self.card(Self.visit)
        chat.take(.update(revision: 1, entries: [card], turns: [Self.running], chat: nil))
        chat.choose(0, on: card)
        try await Self.until { ChatDoor.sent.count == 1 }
        #expect(ChatDoor.sent.map(\.kind) == ["queue"])
        chat.end()
    }

    /// A refused tap comes back to the box as its words with the card's
    /// quote but not the answer's place: edited and sent, it's a reply, and
    /// the card is open again.
    @Test func aRefusedAnswerComesBackWithoutItsPlace() async throws {
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: Pending(file: PendingTests.file()))
        chat.open()
        try await Self.until { chat.loaded }
        let card = try Self.card(Self.visit)
        chat.take(.update(revision: 1, entries: [card], turns: [], chat: nil))
        ChatDoor.refusing = true
        chat.choose(1, on: card)
        try await Self.until { chat.text == "Not now" }
        #expect(chat.chips.map(\.ref) == [Pointer(type: "question", id: "q-visit")])
        #expect(chat.line == "Sign in to Claude on your Mac.")
        #expect(chat.click(on: card) == nil)
        chat.end()
    }

    /// A refused tap is kept as refused on the iPhone, without the answer's
    /// place, before its words come back: edited while the Mac can't keep
    /// the draft, then after a restart, it waits in the box and is never
    /// sent by itself; sent, it is a reply, with no answer.
    @Test func aRefusedAnswerEditedThenRestartedGoesAsAReply() async throws {
        let file = PendingTests.file()
        let door = Door(origin: URL(string: "https://chat.test")!, key: "a-key")
        let chat = ChatModel(door: door, person: "asha", pending: Pending(file: file))
        chat.open()
        try await Self.until { chat.loaded }
        let card = try Self.card(Self.visit)
        chat.take(.update(revision: 1, entries: [card], turns: [], chat: nil))
        ChatDoor.refusing = true
        ChatDoor.savesAway = true
        chat.choose(0, on: card)
        try await Self.until { chat.text == "Book" }
        chat.typed("Book, but not on Tuesday")
        let kept = Pending(file: file).messages
        #expect(kept.first?.refs?.map(\.ref) == [Pointer(type: "question", id: "q-visit")])
        #expect(kept.first?.refused == "Sign in to Claude on your Mac.")
        chat.end()

        // Rufi restarts with the Mac back and signed in.
        (ChatDoor.refusing, ChatDoor.savesAway) = (false, false)
        let again = ChatModel(door: door, person: "asha", pending: Pending(file: file))
        again.open()
        try await Self.until { again.loaded && again.text == "Book" }
        await again.deliver()
        #expect(ChatDoor.sent.isEmpty)
        again.typed("Book, but not on Tuesday")
        again.send()
        try await Self.until { ChatDoor.sent.count == 1 }
        #expect(ChatDoor.sent.first?.text == "Book, but not on Tuesday")
        #expect(ChatDoor.sent.first?.refs == ["q-visit"])
        #expect(ChatDoor.sent.first?.answers == [nil])
        again.end()
    }

    /// A card's answer is the pairing's own: a tap after its pairing ended
    /// keeps nothing.
    @Test func aCardsLateTapNeverGoesToTheNextPairing() async throws {
        let pending = Pending(file: PendingTests.file())
        let card = try Self.card(Self.visit)
        let chat = ChatModel(door: Door(origin: URL(string: "https://chat.test")!, key: "a-key"), person: "asha",
                             pending: pending)
        pending.clear()
        chat.choose(0, on: card)
        #expect(pending.messages.isEmpty)
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

    static let visit = #"{"kind":"choice","key":"Next visit","details":"- Dr Rao, City Clinic\n- Tue 20 Oct, 10:00","question":"Book this visit?","answers":["Book","Not now"]}"#

    /// A question entry with `card`, as the Mac's stream gives it.
    static func card(_ card: String) throws -> Entry {
        let json = #"{"id":"q-visit","seq":3,"turnId":null,"kind":"question","text":"**Next visit**\n\nBook this visit?","activity":null,"detail":null,"status":null,"createdAt":"2026-10-10T09:00:00Z","updatedAt":"2026-10-10T09:00:00Z","card":"# + card + #"}"#
        return try JSONDecoder().decode(Entry.self, from: Data(json.utf8))
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
        /// Each ref's answer place: a question card's click.
        var answers: [Int?] = []
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
                struct Ref: Decodable {
                    let id: String
                    let answer: Int?
                }
                let id: String
                let refs: [Ref]
                let text: String
                let kind: String?
            }
            guard let message = try? JSONDecoder().decode(Message.self, from: body(request)) else { return (400, "") }
            if !sent.contains(where: { $0.id == message.id }) {
                sent.append(Sent(id: message.id, refs: message.refs.map(\.id), answers: message.refs.map(\.answer),
                                 text: message.text, kind: message.kind))
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

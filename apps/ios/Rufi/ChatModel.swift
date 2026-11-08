import Foundation
import Observation

/// The person's chat, as the iPhone holds it: the transcript the stream
/// keeps current, what waits to go to the AI, and the box. The box's rules
/// are the Mac's (apps/web/src/draft.ts): its draft is kept on the Mac a
/// moment after typing stops, and the last save wins. Every send goes
/// through `Pending`: kept on the iPhone with its own id first, then sent
/// until the Mac answers, so a send while Rufi can't be reached and any
/// other are one path, and the Mac takes each once.
@Observable
final class ChatModel {
    enum Status: Equatable {
        case loading, open
        /// The person has no chat.
        case missing
    }

    enum Older: Equatable {
        case idle, loading, failed
    }

    /// What the stream said changed, for the pages drawn elsewhere.
    enum Change {
        /// Rufi saved to the record (a receipt), or the chat opened again:
        /// every page reads again, and the reminders follow.
        case saved
        case documents
        /// The dose log: Today reads again, and the reminders follow.
        case doses
    }

    /// An agent's sheet: which agent, and the name it was opened by.
    struct OpenAgent: Identifiable, Equatable {
        let id: String
        let title: String
    }

    /// A message of the person's not in the transcript yet: kept on the
    /// iPhone, taken by the Mac, or waiting in the Mac's queue.
    struct Outgoing: Identifiable, Equatable {
        enum State: Equatable {
            /// On the iPhone until the Mac takes it.
            case pending
            /// The Mac took it, or gives it to the AI now.
            case sent
        }

        let id: String
        let text: String
        let chips: [Chip]
        let state: State
    }

    private let door: Door
    private let person: String
    let pending: Pending
    /// Rufi couldn't be reached, or answered again.
    @ObservationIgnored var lost: () -> Void = {}
    @ObservationIgnored var reached: () -> Void = {}
    @ObservationIgnored var unpaired: () -> Void = {}
    @ObservationIgnored var changed: (Change) -> Void = { _ in }

    private(set) var transcript = Transcript()
    private(set) var status = Status.loading
    private(set) var older = Older.idle
    private(set) var queue: [QueueItem] = []
    /// Why the queue couldn't be read, or a change to it didn't go.
    private(set) var queueProblem: String?
    /// The chat's sub-agents, oldest first.
    private(set) var agents: [SubAgent] = []
    /// Goes up when the agents read again: an open agent's Activity follows.
    private(set) var agentReads = 0
    /// The agent whose sheet is open, by the name it was opened by.
    var openAgent: OpenAgent?
    /// Taken by the Mac, not in the transcript or the queue yet.
    private(set) var accepted: [PendingMessage] = []
    /// Goes up at each send: the transcript goes to its end.
    private(set) var sends = 0
    /// Goes up each time the stream opens: a card that couldn't load tries again.
    private(set) var reaches = 0
    /// Rufi can't be reached: a message kept says Pending.
    var away = false
    /// When the working line's clock started, and for what: a reply, or "starting".
    private(set) var clock: (key: String, since: Date)?

    /// The Mac's settings the chat follows.
    private(set) var activity = "working"
    private(set) var whileReplying = "steer"
    /// Which providers are signed in on the Mac: codex, claude.
    private(set) var signedIn: Set<String> = ["codex", "claude"]

    /// A visual's height as last drawn, by its entry and place, so a card
    /// drawn again is its height at once.
    @ObservationIgnored var heights: [String: Double] = [:]

    // The box.
    private(set) var text = ""
    private(set) var chips: [Chip] = []
    /// Its draft has been read: until then it can't be typed in.
    private(set) var loaded = false
    /// The last save didn't keep it: "Not saved", with Retry.
    private(set) var failed = false
    /// The box's line: why a save, an add or a send didn't go.
    var notice: String?
    /// Why a refused message is back in the box: until the box changes.
    private(set) var said: String?
    /// Goes up when a page puts something in the box: it lights.
    private(set) var asked = 0
    /// The draft as the Mac last kept it.
    @ObservationIgnored private var kept: Draft?
    /// Refused messages whose words are back in the box: they leave
    /// `pending` once the box's draft holds them.
    @ObservationIgnored private var restoring: Set<String> = []

    @ObservationIgnored private var stream: Task<Void, Never>?
    /// The stream gave its page and is open.
    @ObservationIgnored private var connected = false
    @ObservationIgnored private var pause: Task<Void, Never>?
    @ObservationIgnored private var saves: Task<Void, Never>?
    @ObservationIgnored private var queueReads = 0
    @ObservationIgnored private var delivering = false
    /// The draft's first read: one at a time, whatever the stream does.
    @ObservationIgnored private var loading: Task<Void, Never>?
    /// The pairing this chat is for (the outbox's generation then): only
    /// it sends the messages kept on the iPhone.
    @ObservationIgnored private let pairing: Int
    /// Its pairing ended: it does nothing more.
    @ObservationIgnored private var ended = false

    static let maxText = 10_000
    static let maxChips = 100

    init(door: Door, person: String, pending: Pending) {
        self.door = door
        self.person = person
        self.pending = pending
        pairing = pending.generation
    }

    // MARK: - The stream

    /// Opens the stream, and reads the box and the settings, unless open.
    func open() {
        guard stream == nil, !ended else { return }
        stream = Task { await run() }
        if !loaded, loading == nil {
            loading = Task {
                await load()
                loading = nil
            }
        }
        Task { await readSettings() }
    }

    /// Its pairing ended: the stream, the draft's read and the saves stop,
    /// and nothing it was waiting for acts any more.
    func end() {
        ended = true
        close()
        loading?.cancel()
        pause?.cancel()
        saves?.cancel()
        lost = {}
        reached = {}
        unpaired = {}
        changed = { _ in }
    }

    /// Closes the stream: Rufi went to the background, or unpaired.
    func close() {
        stream?.cancel()
        stream = nil
        connected = false
    }

    /// Connects again now, unless the stream is open: Rufi is back.
    func reconnect() {
        guard !connected else { return }
        close()
        open()
    }

    /// Reads the stream until it ends, then connects again after a wait
    /// that doubles from half a second to ten, and starts again once a page came.
    private func run() async {
        var wait = 0.5
        while !Task.isCancelled {
            do {
                guard let bytes = try await door.chat(for: person) else {
                    status = .missing
                    return
                }
                try await read(bytes) {
                    wait = 0.5
                    connected = true
                    reaches += 1
                    reached()
                }
            } catch .unpaired {
                connected = false
                unpaired()
                return
            } catch .unreachable {
                connected = false
                if !Task.isCancelled { lost() }
            } catch {
                // Rufi answered with a problem: ask again after the wait.
            }
            connected = false
            try? await Task.sleep(for: .seconds(wait))
            wait = min(wait * 2, 10)
        }
    }

    /// Takes each line as it comes; a page first (`opened`). Ends with the stream.
    private func read(_ bytes: URLSession.AsyncBytes, opened: () -> Void) async throws(Door.Problem) {
        do {
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8), !data.isEmpty,
                      let line = try? JSONDecoder().decode(StreamLine.self, from: data) else { continue }
                if case .snapshot = line { opened() }
                take(line)
            }
        } catch {
            throw .unreachable
        }
    }

    /// One line of the stream.
    func take(_ line: StreamLine) {
        switch line {
        case .snapshot:
            transcript.apply(line)
            status = .open
            older = .idle
            Task { await readQueue() }
            Task { await readAgents() }
            changed(.saved)
            // Rufi is there again: what it couldn't keep, it keeps now.
            if failed { save() }
        case let .update(_, entries, turns, _):
            transcript.apply(line)
            if entries.contains(where: { $0.kind == "receipt" }) { changed(.saved) }
            if turns.contains(where: { $0.endReason == "sign_in" }) { Task { await readStatus() } }
        case .queue:
            Task { await readQueue() }
        case .agents:
            Task { await readAgents() }
        case .documents:
            changed(.documents)
        case .doses:
            changed(.doses)
        default:
            break
        }
        settle()
    }

    /// Reads what waits; only the last read started is kept.
    private func readQueue() async {
        queueReads += 1
        let read = queueReads
        do throws(Door.Problem) {
            let answer: Queue = try await door.read("chat/queue", for: person)
            guard read == queueReads else { return }
            queue = answer.items
            queueProblem = nil
            settle()
        } catch {
            if read == queueReads, error != .unreachable { queueProblem = error.shown }
        }
    }

    private func readAgents() async {
        guard let answer: SubAgents = try? await door.read("chat/agents", for: person) else { return }
        agents = answer.agents
        agentReads += 1
    }

    // MARK: - What waits

    /// What waits to go to the AI, in order: the person's messages and
    /// Rufi's notes, not those being given to the AI now or in the chat.
    var waiting: [QueueItem] {
        let going = Set(goingNow.map(\.id))
        return queue.filter { !going.contains($0.id) && transcript.entries[$0.id] == nil }
    }

    /// The person's messages being given to the AI now: shown in the chat as sent.
    private var goingNow: [QueueItem] {
        let idle = transcript.running == nil
        let first = queue.first { $0.state == "waiting" && $0.held == nil }
        return queue.filter { item in
            item.origin == "person" && item.held == nil && transcript.entries[item.id] == nil
                && (item.state == "handing_over" || (idle && item.id == first?.id))
        }
    }

    /// Changes what waits: a waiting message into the running reply
    /// (steer), sent now (send), edited, removed, or put in another order;
    /// the queue comes back as it is then. A message the person sends
    /// takes the chat to its end. True once Rufi took the change.
    @discardableResult
    func change(_ method: String, _ path: String = "", body: (any Encodable & Sendable)? = nil, sends: Bool = false) async
        -> Bool {
        queueProblem = nil
        if sends { self.sends += 1 }
        do throws(Door.Problem) {
            let answer = try await door.queue(method, path, body: body, for: person)
            queueReads += 1
            queue = answer.items
            settle()
            return true
        } catch .unpaired {
            unpaired()
        } catch {
            queueProblem = error.shown ?? "Can't reach Rufi"
        }
        return false
    }

    /// Puts the waiting rows in the order `ids` gives; it shows at once, and
    /// goes back if Rufi refuses it.
    func reorder(_ ids: [String]) async {
        let before = queue
        var moved = ids.compactMap { id in queue.first { $0.id == id } }.makeIterator()
        queue = queue.map { $0.state == "waiting" ? (moved.next() ?? $0) : $0 }
        if await !change("PUT", body: ["ids": ids]) { queue = before }
    }

    /// The path of one waiting row, under the queue.
    static func one(_ item: QueueItem) -> String {
        "/\(item.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? "")"
    }

    /// Stops an agent and the agents it started.
    func stop(agent: String) async throws(Door.Problem) {
        try await door.stop(agent: agent, for: person)
    }

    /// An agent's latest `last` lines.
    func log(of agent: String, last: Int) async throws(Door.Problem) -> AgentLog {
        try await door.read("chat/agents/log", for: person, query: ["agent": agent, "last": String(last)])
    }

    private func readSettings() async {
        struct Settings: Decodable {
            let activity: String
            let whileReplying: String
        }
        if let settings: Settings = try? await door.read(api: "/api/settings") {
            activity = settings.activity
            whileReplying = settings.whileReplying
        }
        await readStatus()
    }

    private func readStatus() async {
        struct Provider: Decodable { let state: String }
        guard let status: [String: Provider] = try? await door.read(api: "/api/status") else { return }
        signedIn = Set(status.filter { $0.value.state == "signed_in" }.keys)
    }

    /// The page before the oldest read, when there is one and none is being read.
    func loadOlder() async {
        guard let before = transcript.before, older != .loading else { return }
        older = .loading
        let window = transcript.window
        do {
            let page: ChatPage = try await door.read("chat", for: person, query: ["before": String(before)])
            transcript.addOlder(page, window: window)
            older = .idle
        } catch {
            older = .failed
        }
    }

    /// A message taken drops out of `accepted` once the chat or the queue
    /// has it; the working clock follows.
    private func settle() {
        let known = Set(transcript.entries.keys).union(queue.map(\.id))
        if accepted.contains(where: { known.contains($0.id) }) { accepted.removeAll { known.contains($0.id) } }
        let key: String?
        var since = Date.now
        if let turn = transcript.running {
            key = turn.id
            since = Words.instant(turn.startedAt) ?? .now
            // A reply that follows its own start keeps the start's time.
            if clock?.key == "starting", let started = clock?.since, started < since { since = started }
        } else if !accepted.isEmpty || (!away && pending.messages.contains { !restoring.contains($0.id) })
                    || queue.contains(where: { $0.held == nil }) {
            key = "starting"
        } else {
            key = nil
        }
        guard clock?.key != key else { return }
        clock = key.map { ($0, since) }
    }

    /// Messages not in the transcript yet, in order: being given to the
    /// AI, taken, then kept on the iPhone. What waits in the Mac's queue
    /// shows in its list over the box.
    var outgoing: [Outgoing] {
        let entries = transcript.entries
        let queued = goingNow.map { Outgoing(id: $0.id, text: $0.text, chips: $0.refs, state: .sent) }
        let queuedIds = Set(queue.map(\.id))
        let taken = accepted.filter { entries[$0.id] == nil && !queuedIds.contains($0.id) }.map {
            Outgoing(id: $0.id, text: $0.text, chips: $0.refs ?? [], state: .sent)
        }
        let kept = pending.messages.filter { !restoring.contains($0.id) && !queuedIds.contains($0.id) }.map {
            Outgoing(id: $0.id, text: $0.text, chips: $0.refs ?? [], state: .pending)
        }
        return queued + taken + kept
    }

    /// A reply runs, or one is starting: the box's button is Stop when empty.
    var working: Bool { clock != nil }

    // MARK: - The box

    /// Reads the draft until it comes: a second, then longer, between tries.
    private func load() async {
        var wait = 1.0
        while !loaded, !Task.isCancelled {
            do {
                let draft: Draft = try await door.read("chat/draft", for: person)
                // Only the box's first read sets it: never over words typed since.
                guard !loaded, !Task.isCancelled else { return }
                kept = draft
                text = draft.text
                chips = draft.refs.map(Self.boxed)
                loaded = true
                notice = nil
                await deliver()
                return
            } catch .unpaired {
                unpaired()
                return
            } catch {
                if error == .unreachable { lost() } else { notice = error.shown }
            }
            try? await Task.sleep(for: .seconds(wait))
            wait = min(wait * 2, 10)
        }
    }

    /// A chip as the box keeps it: what it points at, and its names.
    private static func boxed(_ chip: Chip) -> Chip {
        Chip(ref: chip.ref, label: chip.label, detail: chip.detail)
    }

    /// The person typed: kept on the Mac once they pause.
    func typed(_ text: String) {
        guard loaded, text != self.text else { return }
        self.text = text
        notice = nil
        said = nil
        pause?.cancel()
        pause = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            save()
        }
    }

    /// Keeps the box as the draft, after the saves before it; Retry too.
    /// A chat whose pairing ended never saves: not even one waiting its turn.
    func save(keepingNotice: Bool = false) {
        guard !ended else { return }
        pause?.cancel()
        let before = saves
        saves = Task {
            await before?.value
            guard !ended else { return }
            await keep(keepingNotice: keepingNotice)
        }
    }

    private func keep(keepingNotice: Bool) async {
        guard loaded, !ended, text.count <= Self.maxText, chips.count <= Self.maxChips else { return }
        let text = text
        let refs = chips.map(\.ref)
        // The refused messages whose words this save holds: only these leave the outbox when it is kept.
        let restored = restoring
        if !failed, let kept, kept.text == text, kept.refs.map(\.ref) == refs, restoring.isEmpty { return }
        do {
            let draft = try await door.save(draft: text, refs: refs, for: person)
            guard !ended else { return }
            kept = draft
            // The Mac's names for the chips still in the box.
            let named = Dictionary(draft.refs.map { ($0.ref.key, $0) }, uniquingKeysWith: { $1 })
            chips = chips.map { chip in named[chip.ref.key].map { Chip(ref: chip.ref, label: $0.label, detail: $0.detail) } ?? chip }
            failed = false
            if !keepingNotice { notice = nil }
            if !restored.isEmpty, draft.text == text {
                pending.remove(restored)
                restoring.subtract(restored)
            }
        } catch .unpaired {
            unpaired()
        } catch {
            failed = true
            if error == .unreachable { lost() } else { notice = error.shown }
        }
    }

    /// The box has words or chips, within what can be kept.
    var hasText: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !chips.isEmpty)
            && text.count <= Self.maxText && chips.count <= Self.maxChips
    }

    /// Send: kept on the iPhone first, then sent; the box empties at once.
    func send() {
        guard loaded, hasText else { return }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // While a reply runs: as the Mac's setting says.
        let kind = transcript.running == nil ? nil : whileReplying
        do {
            try pending.add(words, refs: chips, kind: kind)
        } catch {
            notice = "Rufi couldn't keep that. Try again."
            return
        }
        text = ""
        chips = []
        said = nil
        notice = nil
        sends += 1
        save()
        settle()
        Task { await deliver() }
    }

    /// Sends what waits on the iPhone, in order. One the Mac took shows as
    /// sent until the chat has it; one it refused comes back into the box,
    /// with its words.
    func deliver() async {
        guard loaded, !delivering, !ended else { return }
        delivering = true
        defer { delivering = false }
        do {
            let back = try await pending.send(for: pairing, skipping: restoring) { message throws(Door.Problem) in
                do throws(Door.Problem) {
                    try await door.send(message, for: person)
                } catch {
                    if error == .unreachable { lost() }
                    throw error
                }
                accepted.append(message)
            }
            for (message, refused) in back { giveBack(message, refused: refused) }
        } catch {
            unpaired()
        }
        settle()
    }

    /// A message the Mac refused: its words and chips back in the box, with
    /// the Mac's line; it stays on the iPhone until the draft holds it.
    private func giveBack(_ message: PendingMessage, refused: String) {
        guard restoring.insert(message.id).inserted else { return }
        text = text.isEmpty ? message.text : text + "\n\n" + message.text
        merge(message.refs ?? [])
        said = refused
        save(keepingNotice: true)
    }

    /// Stop: the reply ends with "Stopped."
    func stop() async {
        do {
            try await door.stop(for: person)
        } catch .unpaired {
            unpaired()
        } catch {
            if error == .unreachable { lost() } else { notice = error.shown }
        }
    }

    /// The model or the effort, from the next reply.
    func choose(_ field: String, _ value: String) async {
        do {
            try await door.choose(field, value, for: person)
        } catch .unpaired {
            unpaired()
        } catch {
            if error == .unreachable { lost() } else { notice = error.shown }
        }
    }

    /// Words and chips from a page or an add, after what is typed; a chip
    /// already there stays, but a document to read again replaces it. Kept
    /// at once. Refused, with the box's line, until its draft is read.
    @discardableResult
    func append(_ words: String = "", _ added: [Chip]) -> Bool {
        guard loaded else {
            notice = "The chat box is still loading. Add this again in a moment."
            return false
        }
        if !words.isEmpty {
            let typed = text.replacing(/\s+$/, with: "")
            text = typed.isEmpty ? words : typed + "\n\n" + words
        }
        merge(added)
        asked += 1
        save()
        return true
    }

    private func merge(_ added: [Chip]) {
        for chip in added {
            if let at = chips.firstIndex(where: { $0.ref.key == chip.ref.key }) {
                if chip.ref.type == "document", chip.ref.readAgain == true { chips[at] = chip }
            } else {
                chips.append(chip)
            }
        }
    }

    /// Files added from the paperclip: their chips go in the box; a file
    /// already added says so.
    func added(_ answer: Added) {
        let names = answer.already.map(\.name)
        guard append("", (answer.added + answer.already.map(\.documentId)).map { Chip(type: "document", id: $0, label: "") })
        else { return }
        if !names.isEmpty {
            notice = "\(names.joined(separator: ", ")) \(names.count == 1 ? "was" : "were") already added: the chip is the document you have."
        }
    }

    /// Takes a chip out. A file added from the box and never sent leaves Rufi
    /// first; one already sent stays in Rufi.
    func remove(_ chip: Chip) async {
        guard loaded else { return }
        if chip.ref.type == "document" {
            do {
                try await door.unsent(chip.ref.id, for: person)
            } catch .unpaired {
                unpaired()
                return
            } catch {
                if error == .unreachable { lost() } else { notice = error.shown }
                return
            }
        }
        chips.removeAll { $0.ref.key == chip.ref.key }
        save()
    }

    /// The box's line, the first that applies.
    var line: String? {
        if text.count > Self.maxText {
            return "Too long to keep or send: at most 10,000 characters, and this is \(text.count.formatted(.number.locale(Locale(identifier: "en"))))."
        }
        if chips.count > Self.maxChips {
            return "Too many added to keep or send: at most 100, and this has \(chips.count). Take some out."
        }
        return notice ?? said ?? (failed ? "Not saved" : nil)
    }

    /// The line is "Not saved": Retry keeps the box again.
    var retry: Bool { line == "Not saved" }
}

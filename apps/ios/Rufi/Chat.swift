import Foundation

// The chat as the routes under /api/people/<person>/chat answer it
// (@rufi/contracts: Page, Entry, Turn, StreamLine, Draft, Queue), and the
// transcript the stream builds from them, as apps/web/src/transcript-state.ts
// holds it. Only the fields the iPhone shows; a literal set decodes as a String.

/// What a chip points at: a document, a draft item, a saved record or a report.
nonisolated struct Pointer: Codable, Equatable, Hashable, Sendable {
    let type: String
    let id: String
    /// A record's kind.
    var kind: String?
    /// Retry: Send reads again the pages its reading couldn't read.
    var readAgain: Bool?

    /// One chip per thing: a record's kind is part of it.
    var key: String { type == "record" ? "record:\(kind ?? ""):\(id)" : "\(type):\(id)" }
}

/// A chip as the Mac names it: what it points at, its name, and where it is from.
nonisolated struct Chip: Codable, Equatable, Sendable {
    let ref: Pointer
    let label: String
    let detail: String
    /// Its document was deleted after it was sent.
    var deleted: Bool?
}

extension Chip {
    /// A chip a page puts in the box: the Mac names it when the box is kept.
    init(type: String, id: String, readAgain: Bool = false, label: String) {
        self.init(ref: Pointer(type: type, id: id, readAgain: readAgain ? true : nil), label: label, detail: "")
    }

    /// A saved record's chip: its kind is part of what it points at.
    init(record kind: String, id: String, label: String) {
        self.init(ref: Pointer(type: "record", id: id, kind: kind), label: label, detail: "")
    }
}

/// The box's text and chips as the Mac keeps them; the last save wins.
nonisolated struct Draft: Decodable, Equatable, Sendable {
    let text: String
    let refs: [Chip]
}

/// The chat's model and effort, and how much of the AI's memory it uses.
nonisolated struct ChatInfo: Decodable, Equatable, Sendable {
    struct Context: Decodable, Equatable, Sendable {
        let tokens: Int
        let window: Int
    }

    let model: String?
    let effort: String
    let context: Context?
}

/// One item of the transcript, in order by `seq`.
nonisolated struct Entry: Decodable, Equatable, Identifiable, Sendable {
    struct Link: Decodable, Equatable, Sendable {
        let document: String
        /// open or retry.
        let action: String
    }

    struct From: Decodable, Equatable, Sendable {
        let title: String
        let about: String
    }

    let id: String
    let seq: Double
    let turnId: String?
    /// message, steer, activity, reply, reasoning, receipt, event, brief or agent.
    let kind: String
    let text: String
    let activity: String?
    let detail: String?
    /// running, done, failed or stopped.
    let status: String?
    let createdAt: String
    let updatedAt: String
    let refs: [Chip]?
    let link: Link?
    let agent: String?
    let from: From?

    /// Part of its reply's Activity: thinking, notes and steps; not a
    /// compaction, or a picture the reply shows.
    var inActivity: Bool {
        kind == "reasoning"
            || (kind == "activity" && activity != "compaction" && !(activity == "picture" && status == "done" && detail != nil))
    }

    /// Shown in its Activity: a thinking step with words, or any other.
    var shows: Bool {
        kind != "reasoning" || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// One reply the AI ran: how it went, and how it ended.
nonisolated struct Turn: Decodable, Equatable, Identifiable, Sendable {
    struct RanOn: Decodable, Equatable, Sendable {
        let model: String
        let effort: String?
    }

    let id: String
    let model: String
    let effort: String?
    let before: RanOn?
    /// running, completed, interrupted or failed.
    let status: String
    let endReason: String?
    let endText: String?
    let resetsAt: String?
    let startedAt: String
    let endedAt: String?
    let stepsGone: Bool?

    var running: Bool { status == "running" }
    /// It ended without completing: it says how.
    var cut: Bool { status != "running" && status != "completed" }
    /// It ran on another model or effort than the reply before it.
    var modelChanged: Bool {
        guard let before else { return false }
        return before.model != model || (before.effort != nil && effort != nil && before.effort != effort)
    }
}

/// A page of the transcript, each of its turns whole.
nonisolated struct ChatPage: Decodable, Equatable, Sendable {
    let revision: Int
    let chat: ChatInfo
    let entries: [Entry]
    let turns: [Turn]
    /// The next older page holds the entries before this seq; none: the chat's start.
    let before: Int?
}

/// One line of the chat's stream.
nonisolated enum StreamLine: Decodable, Equatable, Sendable {
    case snapshot(ChatPage)
    case update(revision: Int, entries: [Entry], turns: [Turn], chat: ChatInfo?)
    /// The queue, the documents, the sub-agents or the dose log changed.
    case queue, documents, agents, doses, ping
    /// A line this app doesn't know: a newer Mac's.
    case other

    private enum Keys: String, CodingKey { case type, revision, entries, turns, chat }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "snapshot": self = .snapshot(try ChatPage(from: decoder))
        case "update":
            self = .update(revision: try container.decode(Int.self, forKey: .revision),
                           entries: try container.decode([Entry].self, forKey: .entries),
                           turns: try container.decode([Turn].self, forKey: .turns),
                           chat: try container.decodeIfPresent(ChatInfo.self, forKey: .chat))
        case "queue": self = .queue
        case "documents": self = .documents
        case "agents": self = .agents
        case "doses": self = .doses
        case "ping": self = .ping
        default: self = .other
        }
    }
}

/// One row of what waits to go to the AI.
nonisolated struct QueueItem: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    /// person or rufi.
    let origin: String
    let text: String
    /// waiting or handing_over.
    let state: String
    /// Why it doesn't go by itself: signed_out, restored, failed, stopped
    /// or open_failed; none: it goes in turn.
    let held: String?
    let heldText: String?
    /// Which open_failed hold it is: the person's choice names it.
    let holdId: String?
    let refs: [Chip]
}

nonisolated struct Queue: Decodable, Equatable, Sendable {
    let items: [QueueItem]
}

/// A sub-agent of the chat, as its line shows it.
nonisolated struct SubAgent: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    /// The name the agent that started it gave it.
    let title: String
    /// idle, running, continuing, done, stopped or failed.
    let status: String
    /// Its latest result's start: its last answer, or why it stopped or failed.
    let result: String?
    /// The agent that started it; none: Rufi AI's own.
    let parent: String?
    /// When its turn now began, while it works.
    let since: String?
    let model: String
    let effort: String

    /// At work: before its first turn, running, or going on after a restart.
    var working: Bool { status == "idle" || status == "running" || status == "continuing" }
}

nonisolated struct SubAgents: Decodable, Equatable, Sendable {
    let agents: [SubAgent]
}

/// A sub-agent's latest lines, and whether it has earlier ones.
nonisolated struct AgentLog: Decodable, Equatable, Sendable {
    /// One line of its Activity: a message it took (`from` whom), its
    /// answer (reply), a note or step (activity), its thinking, a question
    /// it asked, how a turn ended (end), or another model (model).
    struct Line: Decodable, Equatable, Identifiable, Sendable {
        struct Changed: Decodable, Equatable, Sendable {
            let from: Turn.RanOn
            let to: Turn.RanOn
        }

        let id: String
        let kind: String
        let changed: Changed?
        let text: String
        let from: String?
        let activity: String?
        let detail: String?
        let status: String?
        let updatedAt: String
        /// The sub-agent this step started.
        let agent: String?
    }

    let lines: [Line]
    let earlier: Bool
}

/// The transcript: the latest page and the older pages read since. Each
/// entry and turn keeps the chat's revision it was read at, so a read that
/// comes late never replaces a newer one.
nonisolated struct Transcript: Equatable, Sendable {
    private(set) var chat: ChatInfo?
    private(set) var entries: [String: Entry] = [:]
    /// Entry ids, in order.
    private(set) var order: [String] = []
    private(set) var turns: [String: Turn] = [:]
    private var seen: [String: Int] = [:]
    /// The next older page holds the entries before this seq; none: the start.
    private(set) var before: Int?
    /// One more with each snapshot: an older page asked for before it is dropped.
    private(set) var window = 0

    /// A stream line: a snapshot replaces it all; an update replaces
    /// entries and turns by id.
    mutating func apply(_ line: StreamLine) {
        switch line {
        case let .snapshot(page):
            chat = page.chat
            entries = Dictionary(page.entries.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
            order = Self.ordered(Array(entries.values))
            turns = Dictionary(page.turns.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
            seen = Dictionary((page.entries.map(\.id) + page.turns.map(\.id)).map { ($0, page.revision) },
                              uniquingKeysWith: { $1 })
            before = page.before
            window += 1
        case let .update(revision, entries, turns, chat):
            merge(entries, turns, revision)
            if let chat { self.chat = chat }
        default:
            break
        }
    }

    /// An older page asked for in `window`; after a reconnect it changes nothing.
    mutating func addOlder(_ page: ChatPage, window: Int) {
        guard window == self.window else { return }
        merge(page.entries, page.turns, page.revision)
        before = page.before
    }

    private mutating func merge(_ entries: [Entry], _ turns: [Turn], _ revision: Int) {
        let known = seen
        let fresh = { (id: String) in (known[id] ?? -1) <= revision }
        var added = false
        for entry in entries where fresh(entry.id) {
            if self.entries[entry.id] == nil { added = true }
            self.entries[entry.id] = entry
            seen[entry.id] = revision
        }
        for turn in turns where fresh(turn.id) {
            self.turns[turn.id] = turn
            seen[turn.id] = revision
        }
        if added { order = Self.ordered(Array(self.entries.values)) }
    }

    private static func ordered(_ entries: [Entry]) -> [String] {
        entries.sorted { $0.seq < $1.seq }.map(\.id)
    }

    /// The reply running now.
    var running: Turn? { turns.values.first(where: \.running) }

    /// One line the transcript shows.
    enum Line: Hashable, Sendable {
        /// A day's line, before an entry.
        case day(String)
        /// The model or effort changed for a turn.
        case model(String)
        case compacting(String)
        case compacted(String)
        case entry(String)
        /// A turn's Activity.
        case activity(String)
        /// How a turn ended.
        case ending(String)
    }

    /// What it shows, in order: a turn's Activity takes the place of its
    /// first step while it runs, or comes after its last line before it has
    /// a step (its working line), and sits under its answer once it ended.
    func lines(calendar: Calendar = .current) -> [Line] {
        var first: [String: String] = [:]
        var last: [String: String] = [:]
        var lastReply: [String: String] = [:]
        var firstStep: [String: String] = [:]
        for id in order {
            guard let entry = entries[id], let turn = entry.turnId else { continue }
            if first[turn] == nil { first[turn] = id }
            last[turn] = id
            if entry.kind == "reply" { lastReply[turn] = id }
            if entry.inActivity, firstStep[turn] == nil { firstStep[turn] = id }
        }
        var before: [String: [Line]] = [:]
        // "": before them all.
        var after: [String: [Line]] = [:]
        for turn in turns.values.sorted(by: { $0.startedAt < $1.startedAt }) {
            guard let opens = first[turn.id], let closes = last[turn.id] else {
                // Nothing of it was stored: its lines go where it started.
                let at = order.last { (entries[$0]?.createdAt ?? "") <= turn.startedAt } ?? ""
                if turn.modelChanged { after[at, default: []].append(.model(turn.id)) }
                if turn.running { after[at, default: []].append(.activity(turn.id)) }
                if turn.cut { after[at, default: []].append(.ending(turn.id)) }
                continue
            }
            if turn.modelChanged { before[opens, default: []].append(.model(turn.id)) }
            let step = firstStep[turn.id]
            if !turn.running, let answer = lastReply[turn.id] {
                if step != nil || turn.stepsGone == true { after[answer, default: []].append(.activity(turn.id)) }
            } else if let step {
                before[step, default: []].append(.activity(turn.id))
            } else if turn.running {
                after[closes, default: []].append(.activity(turn.id))
            }
            if turn.cut { after[closes, default: []].append(.ending(turn.id)) }
        }
        var shown = after[""] ?? []
        var day: DateComponents?
        for id in order {
            guard let entry = entries[id] else { continue }
            shown += before[id] ?? []
            // A step of a turn shows in its Activity.
            if !(entry.inActivity && entry.turnId.flatMap { turns[$0] } != nil) {
                let today = Words.instant(entry.createdAt).map { calendar.dateComponents([.year, .month, .day], from: $0) }
                if today != day { shown.append(.day(id)) }
                day = today
                if entry.activity == "compaction" {
                    // One cut (a Stop, a crash) shows nothing.
                    if entry.status == "running" { shown.append(.compacting(id)) }
                    if entry.status == "done" { shown.append(.compacted(id)) }
                } else {
                    shown.append(.entry(id))
                }
            }
            shown += after[id] ?? []
        }
        return shown
    }

    /// A turn's steps its Activity shows, in order.
    func steps(of turn: String) -> [Entry] {
        order.compactMap { entries[$0] }.filter { $0.turnId == turn && $0.inActivity && $0.shows }
    }

    /// A reply still coming: its turn runs, and it isn't whole yet.
    func streaming(_ entry: Entry) -> Bool {
        entry.status != "done" && entry.turnId.flatMap { turns[$0] }?.running == true
    }
}

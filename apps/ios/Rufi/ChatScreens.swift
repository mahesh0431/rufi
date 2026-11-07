import SwiftUI

/// The chat with Rufi, as the Mac's draws it: the transcript, the stream
/// keeping it current, and the box. On its own page, or as a sheet over
/// another page, where a link closes it and Back opens it again.
struct ChatView: View {
    let shell: Shell
    let chat: ChatModel
    /// Shown as a sheet over a page.
    var sheet = false
    @State private var position = ScrollPosition(edge: .bottom)
    /// A step opened: its details.
    @State private var opened: Entry?

    var body: some View {
        let transcript = chat.transcript
        let lines = transcript.lines()
        let outgoing = chat.outgoing
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if transcript.before != nil { earlier }
                ForEach(lines, id: \.self) { line in
                    LineView(line: line, shell: shell, chat: chat, open: { opened = $0 })
                }
                ForEach(outgoing) { message in
                    MessageBubble(text: message.text, chips: message.chips, caption: caption(message.state))
                }
                if chat.clock?.key == "starting" { ThinkingLine(since: chat.clock?.since ?? .now) }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollPosition($position)
        .scrollDismissesKeyboard(.interactively)
        .overlay {
            switch chat.status {
            case .missing:
                ContentUnavailableView("There is no chat here.", systemImage: "bubble.left.and.exclamationmark.bubble.right")
            case .open where lines.isEmpty && outgoing.isEmpty && chat.clock == nil:
                Image("Dog").resizable().scaledToFit().frame(width: 96).accessibilityLabel("Rufi")
            case .loading where lines.isEmpty:
                if shell.away {
                    Image("Resting").resizable().scaledToFit().frame(width: 72).accessibilityLabel("Rufi, resting")
                }
            default:
                EmptyView()
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ChatBoxView(shell: shell, chat: chat)
        }
        .onChange(of: chat.sends) { position.scrollTo(edge: .bottom) }
        .environment(\.openURL, OpenURLAction { url in
            switch ReplyLink.of(url, person: shell.pairing.person.id) {
            case .web: return .systemAction
            case let .page(path):
                Task { await shell.follow(path, fromSheet: sheet) }
                return .handled
            case .nothing: return .discarded
            }
        })
        .sheet(item: $opened) { StepDetails(entry: $0, shell: shell) }
        .background(shell.theme.page)
    }

    /// Above the oldest entry read: the page before it loads as it shows.
    private var earlier: some View {
        Group {
            switch chat.older {
            case .failed:
                HStack(spacing: 8) {
                    Text("Rufi couldn't load earlier messages.")
                    Button("Retry", systemImage: "arrow.clockwise") { Task { await chat.loadOlder() } }
                }
            default:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Loading earlier messages…")
                }
                .onAppear { Task { await chat.loadOlder() } }
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
    }

    private func caption(_ state: ChatModel.Outgoing.State) -> MessageBubble.Caption? {
        switch state {
        case .pending: shell.away ? .pending : nil
        case .sent: nil
        case let .waiting(held): .waiting(held.map { $0.isEmpty ? "Not sent" : $0 } ?? "Waiting")
        }
    }
}

/// One line of the transcript.
private struct LineView: View {
    let line: Transcript.Line
    let shell: Shell
    let chat: ChatModel
    let open: (Entry) -> Void

    var body: some View {
        let transcript = chat.transcript
        switch line {
        case let .day(id):
            if let entry = transcript.entries[id] { DayLine(words: Words.dayLine(entry.createdAt)) }
        case let .model(id):
            if let turn = transcript.turns[id] { QuietLine(words: Words.modelChanged(turn)) }
        case .compacting:
            QuietLine(words: "Compacting chat history…")
        case .compacted:
            QuietLine(words: "Chat history compacted")
        case let .entry(id):
            if let entry = transcript.entries[id] { EntryView(entry: entry, shell: shell, chat: chat, open: open) }
        case let .activity(id):
            if let turn = transcript.turns[id] {
                ActivityView(turn: turn, steps: transcript.steps(of: id), since: chat.clock?.key == id ? chat.clock?.since : nil,
                             shown: chat.activity, open: open)
            }
        case let .ending(id):
            if let turn = transcript.turns[id] {
                Text(Words.ending(turn)).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

/// One entry, by its kind.
private struct EntryView: View {
    let entry: Entry
    let shell: Shell
    let chat: ChatModel
    let open: (Entry) -> Void

    var body: some View {
        switch entry.kind {
        case "message", "steer":
            MessageBubble(text: entry.text, chips: entry.refs ?? [], caption: nil)
        case "receipt":
            ReceiptView(text: entry.text)
        case "event":
            RufiLine(symbol: "bell", text: entry.text) {
                if let link = entry.link {
                    if link.action == "retry" {
                        Button("Retry", systemImage: "arrow.clockwise") {
                            Task { await shell.ask([Chip(type: "document", id: link.document, readAgain: true, label: "")]) }
                        }
                    } else {
                        Button("Open", systemImage: "arrow.up.right") {
                            Task { await shell.follow(shell.path("documents/\(link.document)"), fromSheet: false) }
                        }
                    }
                }
            }
        case "brief":
            RufiLine(symbol: "doc.text", text: entry.text) {
                Button("Open", systemImage: "arrow.up.right") {
                    Task { await shell.follow(shell.path("briefs/\(entry.id)"), fromSheet: false) }
                }
                .accessibilityLabel("Open \(entry.text)")
            }
        case "agent":
            AgentBubble(entry: entry)
        case "reply":
            ReplyView(entry: entry, streaming: chat.transcript.streaming(entry), chat: chat, origin: shell.pairing.origin)
        default:
            // A picture the AI made: its file is on the Mac only.
            if !(entry.activity == "picture" && entry.status == "done" && entry.detail != nil) {
                StepView(entry: entry, open: open)
            }
        }
    }
}

/// The person's message: their words as written, its chips above them.
struct MessageBubble: View {
    enum Caption: Equatable {
        case pending
        case waiting(String)
    }

    let text: String
    let chips: [Chip]
    let caption: Caption?
    @Environment(Theme.self) private var theme

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            VStack(alignment: .leading, spacing: 6) {
                if !chips.isEmpty {
                    FlowChips(chips: chips)
                }
                if !text.isEmpty { Text(text).textSelection(.enabled) }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(theme.accentSoft, in: .rect(cornerRadius: 16))
            switch caption {
            case .pending: Label("Pending", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
            case let .waiting(words): Text(words).font(.caption).foregroundStyle(.secondary)
            case nil: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }
}

/// A message's chips, as many to a line as fit.
private struct FlowChips: View {
    let chips: [Chip]

    var body: some View {
        // Wraps like words: one HStack per line would need measuring.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { ForEach(chips.indices, id: \.self) { ChipLabel(chip: chips[$0]) } }
            VStack(alignment: .leading, spacing: 6) { ForEach(chips.indices, id: \.self) { ChipLabel(chip: chips[$0]) } }
        }
    }
}

/// A chip: what it points at, its name, and when its document is gone.
struct ChipLabel: View {
    let chip: Chip

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: Self.symbol(chip.ref.type)).font(.footnote).foregroundStyle(.secondary)
            Text(chip.label.isEmpty ? "Adding…" : chip.label).font(.footnote).lineLimit(1)
                .frame(maxWidth: 220, alignment: .leading).fixedSize(horizontal: true, vertical: false)
            if chip.deleted == true {
                Text("· document deleted").font(.footnote).foregroundStyle(.secondary)
            } else if chip.ref.readAgain == true {
                Text("· read again").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 8))
        .opacity(chip.deleted == true ? 0.6 : 1)
    }

    static func symbol(_ type: String) -> String {
        switch type {
        case "document": "doc.text"
        case "draft_item": "flask"
        case "record": "waveform.path.ecg"
        default: "tablecells"
        }
    }
}

/// What Rufi saved, as it says it: a long list folds under its first line.
private struct ReceiptView: View {
    let text: String
    @State private var unfolded = false
    @Environment(Theme.self) private var theme

    var body: some View {
        let parts = text.components(separatedBy: "\n\n")
        let head = parts.first ?? ""
        let list = parts.dropFirst().joined(separator: "\n\n")
        let long = list.split(separator: "\n").count > 5
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                RufiMarkdown(text: long ? head : text)
                if long {
                    Button(head.firstMatch(of: /^\*\*(Set aside|Dismissed)\*\*/) != nil ? "Show the items" : "Show what was saved",
                           systemImage: unfolded ? "chevron.down" : "chevron.right") { unfolded.toggle() }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if unfolded { RufiMarkdown(text: list) }
                }
            }
        }
        // Rufi's own lines: their names aren't links.
        .environment(\.openURL, OpenURLAction { _ in .discarded })
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.side, in: .rect(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color(.separator), lineWidth: 0.5) }
    }
}

/// Rufi's own line, an event's or a visit brief's: never the person's words.
private struct RufiLine<Action: View>: View {
    let symbol: String
    let text: String
    @ViewBuilder let action: Action
    @Environment(Theme.self) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Rufi").font(.caption).foregroundStyle(.secondary)
                Text(text)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            action.buttonStyle(.bordered).controlSize(.small)
        }
        .padding(12)
        .background(theme.side, in: .rect(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color(.separator), lineWidth: 0.5) }
    }
}

/// A message from an agent Rufi AI started: its name, and its words.
private struct AgentBubble: View {
    let entry: Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                Text(entry.from?.title ?? "Agent")
                if let about = entry.from?.about, about == "stopped" || about == "failed" { Text("· \(about)") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if !entry.text.isEmpty { RufiMarkdown(text: entry.text).lineLimit(4) }
        }
        .environment(\.openURL, OpenURLAction { _ in .discarded })
        .padding(12)
        .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(Color(.separator), lineWidth: 0.5) }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }
}

/// A day's line: "Today", "Thu 8 Oct".
private struct DayLine: View {
    let words: String

    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Color(.separator)).frame(height: 0.5)
            Text(words).font(.caption).foregroundStyle(.secondary).fixedSize()
            Rectangle().fill(Color(.separator)).frame(height: 0.5)
        }
    }
}

private struct QuietLine: View {
    let words: String

    var body: some View {
        Text(words).font(.caption).italic().foregroundStyle(.secondary).frame(maxWidth: .infinity)
    }
}

/// The dog thinking, and for how long: "Thinking · 0:12".
private struct ThinkingLine: View {
    let since: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 8) {
                Image("Dog").resizable().scaledToFit().frame(width: 20, height: 20)
                let seconds = context.date.timeIntervalSince(since)
                Text(seconds >= 1 ? "Thinking · \(Words.clock(seconds))" : "Thinking")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
    }
}

/// A reply's Activity: its thinking, notes and steps, folded as the Mac's
/// setting says (open while it works, unless hidden), or as tapped until
/// the reply ends.
private struct ActivityView: View {
    let turn: Turn
    let steps: [Entry]
    /// When its working clock started, when it is the one working.
    let since: Date?
    /// The Mac's setting: working, shown or hidden.
    let shown: String
    let open: (Entry) -> Void
    /// Tapped, while the reply ran as it does now.
    @State private var tapped: (running: Bool, open: Bool)?

    var body: some View {
        let running = turn.running
        let unfolded = tapped.flatMap { $0.running == running ? $0.open : nil }
            ?? (running ? shown != "hidden" : shown == "shown")
        if running, steps.isEmpty {
            ThinkingLine(since: since ?? Words.instant(turn.startedAt) ?? .now)
        } else if steps.isEmpty {
            if turn.stepsGone == true {
                Text("Activity is gone with the AI's working state.").font(.subheadline).foregroundStyle(.secondary)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    tapped = (running, !unfolded)
                } label: {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        HStack(spacing: 8) {
                            if running {
                                Image("Dog").resizable().scaledToFit().frame(width: 20, height: 20)
                            } else {
                                Image(systemName: "chevron.right").rotationEffect(.degrees(unfolded ? 90 : 0))
                                    .font(.caption.weight(.semibold))
                            }
                            Text(label(running: running, open: unfolded, now: context.date)).lineLimit(1)
                            if running, !unfolded, let newest = steps.last {
                                Text(newest.kind == "reasoning" ? Words.heading(newest.text) : Words.step(newest))
                                    .lineLimit(1).truncationMode(.middle)
                                    .font(newest.activity == "note" || newest.kind == "reasoning" ? .subheadline : .footnote.monospaced())
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                if unfolded {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(steps) { StepView(entry: $0, open: open) }
                    }
                    .padding(.leading, 12)
                }
            }
        }
    }

    private func label(running: Bool, open: Bool, now: Date) -> String {
        guard running else { return Words.activity(turn, steps: steps) }
        let start = since ?? Words.instant(turn.startedAt) ?? now
        return [open ? "Activity · working" : "Working", Words.steps(steps.count), Words.clock(now.timeIntervalSince(start))]
            .joined(separator: " · ")
    }
}

/// One step: the AI's thinking (its heading, opened: its summary), its
/// note, or what it did, which opens its details.
private struct StepView: View {
    let entry: Entry
    let open: (Entry) -> Void
    @State private var unfolded = false

    var body: some View {
        if entry.kind == "reasoning" {
            VStack(alignment: .leading, spacing: 4) {
                Button { unfolded.toggle() } label: {
                    HStack(spacing: 6) {
                        if entry.status == "running" { ProgressView().controlSize(.mini) } else { Image(systemName: "brain") }
                        Text(Words.heading(entry.text)).lineLimit(1)
                        Image(systemName: "chevron.right").font(.caption2).rotationEffect(.degrees(unfolded ? 90 : 0))
                    }
                }
                .buttonStyle(.plain)
                if unfolded { RufiMarkdown(text: entry.text, muted: true) }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        } else if entry.activity == "note" {
            RufiMarkdown(text: entry.text, muted: true).padding(.leading, 19)
        } else {
            Button { open(entry) } label: {
                HStack(spacing: 6) {
                    sign
                    Text(Words.step(entry)).lineLimit(1).truncationMode(.middle).font(.footnote.monospaced())
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(entry.status ?? "done"): \(entry.text)")
        }
    }

    @ViewBuilder private var sign: some View {
        switch entry.status {
        case "running": ProgressView().controlSize(.mini)
        case "failed": Image(systemName: "xmark").font(.caption)
        case "stopped": Image(systemName: "square.fill").font(.system(size: 9))
        default: Image(systemName: "checkmark").font(.caption)
        }
    }
}

/// A step's details, as the agent gave them; read when opened.
private struct StepDetails: View {
    let entry: Entry
    let shell: Shell
    @State private var details: Any??
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let details {
                        if let item = details as? [String: Any] {
                            ForEach(Self.blocks(item), id: \.label) { DetailBlock(label: $0.label, text: $0.text) }
                            if let facts = Self.facts(item) { Text(facts).font(.footnote).foregroundStyle(.secondary) }
                        } else {
                            Text("Rufi kept no details for this step.").foregroundStyle(.secondary)
                        }
                    } else if let problem {
                        HStack {
                            Text(problem)
                            Button("Retry", systemImage: "arrow.clockwise") { Task { await read() } }
                        }
                        .foregroundStyle(.secondary)
                    } else {
                        ProgressView("Loading…").frame(maxWidth: .infinity)
                    }
                }
                .padding()
            }
            .navigationTitle(Words.step(entry))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done", systemImage: "checkmark") { dismiss() } }
            }
            .task(id: entry.updatedAt) { await read() }
        }
        .presentationDetents([.medium, .large])
    }

    private func read() async {
        problem = nil
        struct Answer: Decodable { let details: JSON }
        do {
            let answer: Answer = try await shell.read("chat/entries/\(entry.id)")
            details = .some(answer.details.any)
        } catch {
            problem = error.shown ?? "Can't reach Rufi"
        }
    }

    /// The blocks a step's details show, as the Mac's do.
    static func blocks(_ item: [String: Any]) -> [(label: String, text: String)] {
        switch item["type"] as? String {
        case "commandExecution":
            return [("Command", item["command"] as? String ?? ""), ("Output", item["aggregatedOutput"] as? String ?? "")]
                .filter { !$0.1.isEmpty }
        case "mcpToolCall":
            let parts = ((item["result"] as? [String: Any])?["content"] as? [[String: Any]] ?? [])
                .filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }
            return [("Arguments", pretty(item["arguments"])), ("Result", parts.joined(separator: "\n\n")),
                    ("Error", (item["error"] as? [String: Any])?["message"] as? String ?? "")]
                .filter { !$0.1.isEmpty }
        default:
            return [("As the agent reported it", pretty(item))]
        }
    }

    /// A command's folder, exit code and time; a tool's time.
    static func facts(_ item: [String: Any]) -> String? {
        let took = (item["durationMs"] as? NSNumber).map { "Took \(Words.took($0.doubleValue / 1000))" }
        let facts: [String?] = switch item["type"] as? String {
        case "commandExecution":
            [(item["cwd"] as? String).map { "Folder: \($0)" }, (item["exitCode"] as? NSNumber).map { "Exit code: \($0)" }, took]
        case "mcpToolCall": [took]
        default: []
        }
        let shown = facts.compactMap { $0 }
        return shown.isEmpty ? nil : shown.joined(separator: " · ")
    }

    private static func pretty(_ value: Any?) -> String {
        guard let value, JSONSerialization.isValidJSONObject(value) || value is String || value is NSNumber else { return "" }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
        else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// A block of a step's details: a label, and the text in a box; a long one
/// shows its first 12 lines until Show all.
private struct DetailBlock: View {
    let label: String
    let text: String
    @State private var all = false
    @Environment(Theme.self) private var theme

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption.weight(.medium))
            ScrollView(.horizontal) {
                Text(all || lines.count <= 12 ? text : lines.prefix(12).joined(separator: "\n"))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(8)
            }
            .background(theme.side, in: .rect(cornerRadius: 8))
            if lines.count > 12 {
                Button(all ? "Show less" : "Show all \(lines.count) lines") { all.toggle() }.font(.caption)
            }
        }
    }
}

/// JSON as it came, for a step's details: the agent's own shape.
nonisolated enum JSON: Decodable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

    init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([JSON].self) { self = .array(array) }
        else { self = .object(try value.decode([String: JSON].self)) }
    }

    /// As JSONSerialization gives it; none for null.
    var any: Any? {
        switch self {
        case .null: nil
        case let .bool(value): value
        case let .number(value): NSNumber(value: value)
        case let .string(value): value
        case let .array(values): values.map { $0.any ?? NSNull() }
        case let .object(values): values.mapValues { $0.any ?? NSNull() }
        }
    }
}

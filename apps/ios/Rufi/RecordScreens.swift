import SwiftUI

// The pages the iPhone draws itself (NativePage): Overview, the simple
// record pages, a row opened, and Follow-ups. Each reads its route with the
// key and keeps its last read while Rufi can't be reached; one never read
// shows the dog, resting. Their words are the Mac's (Words).

/// A page drawn here, in the theme.
struct NativePageView: View {
    let shell: Shell
    let screen: Screen
    let page: NativePage

    var body: some View {
        Group {
            switch page {
            case .overview: OverviewView(shell: shell)
            case let .list(kind): RecordListView(shell: shell, kind: kind)
            case let .row(kind, id): RowView(shell: shell, screen: screen, kind: kind, id: id)
            case .followUps: FollowUpsView(shell: shell)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(shell.theme.page)
    }
}

/// Reads `path` for a page, again when Rufi is back and on a pull; the last
/// read stays while Rufi can't be reached.
struct Reading<Answer: Decodable & Sendable, Content: View>: View {
    let shell: Shell
    let path: String
    @ViewBuilder let content: (Answer, Date) -> Content
    @State private var answer: Answer?
    @State private var at = Date.now
    @State private var problem: String?

    var body: some View {
        Group {
            if let answer {
                content(answer, at)
            } else if let problem {
                ContentUnavailableView("Can't Show This", systemImage: "exclamationmark.triangle",
                                       description: Text(problem))
            } else if shell.away {
                Resting()
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: shell.fresh) { await read() }
        .refreshable { await read() }
    }

    private func read() async {
        do {
            let read: Answer = try await shell.read(path)
            answer = read
            at = .now
            problem = nil
        } catch {
            problem = error.shown ?? problem
        }
    }
}

extension Door.Problem {
    /// What a page says when its read was refused; none when Rufi is out of
    /// reach (the line says it) or the iPhone was unpaired.
    var shown: String? {
        switch self {
        case .unreachable, .unpaired: nil
        case .codeExpired, .mismatch: "Update Rufi on your iPhone (or on your Mac) so they match."
        case let .refused(words): words
        }
    }
}

/// The dog, resting: a page never read while Rufi can't be reached.
struct Resting: View {
    var body: some View {
        Image("Resting").resizable().scaledToFit().frame(width: 72)
            .accessibilityLabel("Rufi, resting")
    }
}

/// The chat's box on a page drawn here: one line that opens the chat.
struct AskBar: View {
    let name: String
    let theme: Theme
    let ask: () -> Void

    var body: some View {
        Button(action: ask) {
            HStack(spacing: 8) {
                Text("Ask or tell Rufi about \(name)…")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "arrow.up")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(theme.onAccent)
                    .frame(width: 32, height: 32)
                    .background(theme.accent, in: .circle)
            }
            .padding(.leading, 14)
            .padding(.trailing, 5)
            .padding(.vertical, 5)
            .background(theme.surface, in: .rect(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(Color(.separator), lineWidth: 0.5) }
            .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .padding(.bottom, 2)
        .accessibilityLabel("Chat with Rufi")
    }
}

/// A row that opens another page, as iOS draws one.
struct Opens<Label: View>: View {
    let open: () -> Void
    @ViewBuilder let label: Label

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                label.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// A row's words: its title and status, its detail and date.
struct RowCells: View {
    let cells: Words.Cells

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(cells.title).fontWeight(.semibold)
                Spacer(minLength: 8)
                if !cells.status.isEmpty {
                    Text(cells.status).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            let under = [cells.detail, cells.date].filter { !$0.isEmpty }.joined(separator: " · ")
            if !under.isEmpty {
                Text(under).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Opens the chat, where changes start.
struct AskRufiButton: View {
    let shell: Shell

    var body: some View {
        Button("Ask Rufi", systemImage: "message") { Task { await shell.choose(.chat) } }
            .buttonStyle(.bordered)
    }
}

// MARK: Overview

/// The home: what needs the person, their record as one row per page with
/// something in it, and the latest saves, each opening to its receipt.
struct OverviewView: View {
    let shell: Shell

    var body: some View {
        Reading(shell: shell, path: "overview") { (read: OverviewRead, at: Date) in
            OverviewList(shell: shell, overview: read.overview, at: at)
        }
    }
}

/// The overview route's answer.
nonisolated struct OverviewRead: Decodable, Sendable {
    let overview: Overview
}

private struct OverviewList: View {
    let shell: Shell
    let overview: Overview
    let at: Date
    // The greeting and date as the page opened.
    @State private var now = Date.now

    private var person: String { shell.pairing.person.id }
    private var surface: Color { shell.theme.surface }

    var body: some View {
        let shown = overview.tiles.filter(Words.hasTile)
        let empty = overview.tiles.filter { !Words.hasTile($0) }
        List {
            Section {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Words.today(now)).foregroundStyle(.secondary)
                    Text("\(Words.greeting(now)), \(shell.pairing.person.name)")
                        .font(.title2.bold())
                }
                .listRowBackground(Color.clear)
                .listRowInsets(.init(top: 0, leading: 4, bottom: 0, trailing: 4))
            }
            if !overview.needsYou.documents.isEmpty || !overview.needsYou.followUps.isEmpty {
                Section("Needs you") {
                    ForEach(overview.needsYou.documents) { document in
                        Opens { go("/people/\(person)/documents/\(document.id)") } label: {
                            needs(document.name, Words.waiting(document))
                        }
                    }
                    ForEach(overview.needsYou.followUps, id: \.followUp.id) { need in
                        Opens { go("/people/\(person)/follow-ups?open=\(need.followUp.id)") } label: {
                            needs(need.followUp.title ?? "", Words.need(need, now: at))
                        }
                    }
                }
                .listRowBackground(surface)
            }
            Section {
                ForEach(shown, id: \.kind) { tile in
                    Opens { go(Place(rawValue: tile.kind)?.path(person) ?? "/") } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(Words.titles[tile.kind] ?? tile.kind).fontWeight(.semibold)
                                Spacer()
                                Text(tile.count, format: .number).monospacedDigit().foregroundStyle(.secondary)
                            }
                            ForEach(Words.tileLines(tile), id: \.self) { line in
                                Text(line).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .listRowBackground(surface)
            } header: {
                Text("Health record")
            } footer: {
                if !empty.isEmpty {
                    Text("Nothing yet: \(empty.map { Words.titles[$0.kind] ?? $0.kind }.joined(separator: ", "))")
                }
            }
            if !overview.recent.isEmpty {
                Section("Recent changes") {
                    ForEach(overview.recent) { change in
                        DisclosureGroup {
                            Text(receipt(change.receipt)).font(.subheadline)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Words.summary(change.receipt)).lineLimit(2)
                                Text(Words.savedAt(change.at, now: now)).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .listRowBackground(surface)
            }
        }
    }

    private func needs(_ name: String, _ words: String) -> some View {
        Text("\(Text(name).fontWeight(.semibold)) \(Text("· \(words)").foregroundStyle(.secondary))")
            .padding(.vertical, 2)
    }

    private func go(_ path: String) {
        Task { await shell.go(path) }
    }

    /// A receipt as Rufi wrote it, its Markdown as a line each.
    private func receipt(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

// MARK: Record pages

/// A record page: its kind's rows, newest first, read on as it scrolls.
struct RecordListView: View {
    let shell: Shell
    let kind: String
    @State private var groups: [RecordGroup]?
    @State private var next: String?
    @State private var problem: String?
    @State private var reading = false

    var body: some View {
        Group {
            if let groups {
                if groups.isEmpty {
                    ContentUnavailableView {
                        Text("Nothing here yet.")
                    } actions: {
                        AskRufiButton(shell: shell)
                    }
                } else {
                    List {
                        Section {
                            ForEach(groups.flatMap(\.rows.rows)) { row in
                                RowLine(shell: shell, row: row)
                            }
                            if next != nil {
                                ProgressView().frame(maxWidth: .infinity)
                                    .task { await more() }
                            }
                        }
                        .listRowBackground(shell.theme.surface)
                    }
                }
            } else if let problem {
                ContentUnavailableView("Can't Show This", systemImage: "exclamationmark.triangle",
                                       description: Text(problem))
            } else if shell.away {
                Resting()
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: shell.fresh) { await first() }
        .refreshable { await first() }
    }

    /// The first page again: what is newest now.
    private func first() async {
        do {
            let page: RecordPage = try await shell.read("record/\(kind)")
            groups = page.groups
            next = page.next
            problem = nil
        } catch {
            problem = error.shown ?? problem
        }
    }

    /// The page after the last read; out of reach, it waits for the next scroll.
    private func more() async {
        guard let after = next, !reading else { return }
        reading = true
        defer { reading = false }
        guard let page: RecordPage = try? await shell.read("record/\(kind)", query: ["after": after]),
              next == after else { return }
        groups = (groups ?? []) + page.groups
        next = page.next
    }
}

/// One row on a record page, which opens it.
struct RowLine: View {
    let shell: Shell
    let row: RecordRow

    var body: some View {
        if row.problem != nil {
            Text("Can't show this row.").foregroundStyle(.secondary)
        } else {
            Opens {
                Task { await shell.go("/people/\(shell.pairing.person.id)/record/\(row.kind)?open=\(row.id)") }
            } label: {
                RowCells(cells: Words.cells(row))
            }
        }
    }
}

/// A row opened: what it says, where it came from and every save to it.
struct RowView: View {
    let shell: Shell
    let screen: Screen
    let kind: String
    let id: String

    var body: some View {
        Reading(shell: shell, path: "record/\(kind)/\(id)") { (detail: RecordDetail, at: Date) in
            RowDetailList(shell: shell, detail: detail, now: at)
                .onAppear { shell.titled(screen, detail.row.problem == nil ? Words.cells(detail.row).title : "") }
                .onChange(of: detail.row) { _, row in shell.titled(screen, Words.cells(row).title) }
        }
    }
}

private struct RowDetailList: View {
    let shell: Shell
    let detail: RecordDetail
    let now: Date

    private var person: String { shell.pairing.person.id }
    private var surface: Color { shell.theme.surface }

    var body: some View {
        let row = detail.row
        List {
            Section {
                if row.problem != nil {
                    Text("Can't show this row.").foregroundStyle(.secondary)
                } else {
                    RowCells(cells: Words.cells(row))
                    if let details = row.details { Text(details) }
                    if row.kind == "follow_up" { followUp(row) }
                }
            } footer: {
                if detail.removed { Text("Removed from your health record.") }
            }
            .listRowBackground(surface)
            Section("Sources") {
                if detail.sources.isEmpty {
                    Text("None kept: saved before Rufi kept sources.").foregroundStyle(.secondary)
                }
                ForEach(Array(detail.sources.enumerated()), id: \.offset) { _, source in
                    SourceLine(shell: shell, source: source)
                }
            }
            .listRowBackground(surface)
            Section("History") {
                if detail.history.isEmpty {
                    Text("No saves yet: it came before Rufi kept them.").foregroundStyle(.secondary)
                }
                ForEach(Array(detail.history.enumerated()), id: \.offset) { _, change in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Words.change(change))
                        ForEach(change.fields, id: \.field) { field in
                            Text("\(field.field) \(Words.value(field.before)) → \(Words.value(field.after))")
                                .font(.subheadline)
                        }
                        Text(Words.time(change.at)).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            }
            .listRowBackground(surface)
        }
    }

    /// A follow-up's due, its outcome when closed, and what it is about.
    @ViewBuilder
    private func followUp(_ row: RecordRow) -> some View {
        let closed = row.status == "done" || row.status == "dropped"
        if closed, let outcome = row.outcome { Text("Outcome: \(outcome)") }
        if let about = row.about { AboutLine(shell: shell, about: about) }
    }
}

/// Where a record came from, opening it when it's still there.
struct SourceLine: View {
    let shell: Shell
    let source: RecordSource

    private var person: String { shell.pairing.person.id }

    var body: some View {
        switch source.type {
        case "document":
            let place = "\(source.file ?? "") · page \(source.page ?? 0)"
            if source.deleted == true {
                Text("Document deleted (\(source.file ?? ""), page \(source.page ?? 0))").foregroundStyle(.secondary)
            } else {
                Opens { go("/people/\(person)/documents/\(source.document ?? "")") } label: { Text(place) }
            }
        case "visit":
            if source.removed == true {
                Text("Visit removed (\(source.label ?? ""))").foregroundStyle(.secondary)
            } else {
                Opens { go("/people/\(person)/visits/\(source.visit ?? "")") } label: {
                    Text("Visit · \(source.label ?? "")")
                }
            }
        default:
            VStack(alignment: .leading, spacing: 2) {
                Text("You said: “\(source.text ?? "")”")
                if let at = source.at { Text(Words.time(at)).font(.subheadline).foregroundStyle(.secondary) }
            }
        }
    }

    private func go(_ path: String) {
        Task { await shell.go(path) }
    }
}

/// The record a follow-up is about, by its label and date, opening on its page.
struct AboutLine: View {
    let shell: Shell
    let about: RecordRow.About
    @State private var detail: RecordDetail?
    @State private var failed = false

    var body: some View {
        Group {
            if let detail, detail.row.problem == nil, let page = Words.page(of: detail.row) {
                let cells = Words.cells(detail.row)
                let label = [cells.title, cells.date].filter { !$0.isEmpty }.joined(separator: " · ")
                if detail.removed {
                    Text("About: \(label) (removed from your health record)")
                } else {
                    Opens {
                        Task { await shell.go("/people/\(shell.pairing.person.id)/record/\(page)?open=\(about.id)") }
                    } label: {
                        Text("About: \(label)")
                    }
                }
            } else if failed || detail != nil {
                Text("About: a record Rufi can't show").foregroundStyle(.secondary)
            }
        }
        .task(id: shell.fresh) {
            do throws(Door.Problem) {
                let read: RecordDetail = try await shell.read("record/\(about.kind)/\(about.id)")
                detail = read
            } catch {
                if error.shown != nil { failed = true }
            }
        }
    }
}

// MARK: Follow-ups

/// The person's follow-ups in the Mac's groups: what to do, and when.
struct FollowUpsView: View {
    let shell: Shell

    var body: some View {
        Reading(shell: shell, path: "follow-ups") { (read: FollowUps, at: Date) in
            if read.groups.isEmpty {
                ContentUnavailableView {
                    Text("Nothing to come back to yet. When a report or you mention a recheck, Rufi offers to add it here.")
                } actions: {
                    AskRufiButton(shell: shell)
                }
            } else {
                List {
                    ForEach(read.groups, id: \.group) { group in
                        Section {
                            ForEach(group.rows.rows) { row in
                                FollowUpLine(shell: shell, group: group.group, row: row, now: at)
                            }
                        } header: {
                            Text(heading(group))
                        }
                        .listRowBackground(shell.theme.surface)
                    }
                }
            }
        }
    }

    private func heading(_ group: FollowUps.Group) -> String {
        let title = Words.headings[group.group] ?? group.group
        let count = group.rows.rows.count
        return group.group == "coming_up" ? "\(title) next 30 days · \(count)" : "\(title) \(count)"
    }
}

/// One follow-up: what, and when; its outcome when closed.
struct FollowUpLine: View {
    let shell: Shell
    let group: String
    let row: RecordRow
    let now: Date

    var body: some View {
        if row.problem != nil || row.kind != "follow_up" {
            Text("Can't show this row.").foregroundStyle(.secondary)
        } else {
            Opens {
                Task { await shell.go("/people/\(shell.pairing.person.id)/follow-ups?open=\(row.id)") }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title ?? "").fontWeight(.semibold)
                    if group == "done" || group == "dropped", let outcome = row.outcome {
                        Text("Outcome: \(outcome)").font(.subheadline)
                    }
                    Text(Words.whenDue(group, row.due, now: now)).font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
    }
}

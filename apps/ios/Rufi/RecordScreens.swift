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
            case .labResults: LabResultsView(shell: shell)
            case let .test(id): TestView(shell: shell, screen: screen, id: id)
            case let .visit(id): VisitView(shell: shell, screen: screen, id: id)
            case let .row(kind, id): RowView(shell: shell, screen: screen, kind: kind, id: id)
            case .followUps: FollowUpsView(shell: shell)
            }
        }
        // Inset grouped, as This iPhone's sheets: the sidebar's colour
        // behind, the rows on the surface's.
        .listStyle(.insetGrouped)
        .themed(shell.theme)
    }
}

/// Reads `path` for a page, again when Rufi is back and on a pull; the last
/// read stays while Rufi can't be reached.
struct Reading<Answer: Decodable & Sendable, Content: View>: View {
    let shell: Shell
    let path: String
    @ViewBuilder let content: (Answer, Date) -> Content
    @State private var read: Kept?
    @State private var problem: String?

    /// A read and when it came.
    private struct Kept: Sendable {
        let answer: Answer
        let at: Date
    }

    var body: some View {
        Group {
            if let shown = read ?? shell.kept[path] as? Kept {
                content(shown.answer, shown.at)
            } else {
                Waiting(shell: shell, problem: problem)
            }
        }
        .task(id: shell.fresh) { await read() }
        .refreshable { await read() }
    }

    private func read() async {
        do {
            let answer: Answer = try await shell.read(path)
            read = Kept(answer: answer, at: .now)
            shell.kept[path] = read
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

/// A page not read yet: why it can't be shown, the dog resting while Rufi
/// can't be reached, or a spinner. Over an empty list, so pulling down
/// reads again.
struct Waiting: View {
    let shell: Shell
    let problem: String?

    var body: some View {
        List {}.overlay {
            if let problem {
                ContentUnavailableView("Can't Show This", systemImage: "exclamationmark.triangle",
                                       description: Text(problem))
            } else if shell.away {
                Resting()
            } else {
                ProgressView()
            }
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
                        RecentLine(change: change, now: now)
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
}

/// One of the latest saves: its first change and when, opening in place to
/// its receipt. Its chevron is every row's, turned down while open.
private struct RecentLine: View {
    let change: Overview.Change
    let now: Date
    @State private var open = false

    var body: some View {
        Button {
            withAnimation(.snappy) { open.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Words.summary(change.receipt)).lineLimit(2)
                        Text(Words.savedAt(change.at, now: now)).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                if open { Text(receipt).font(.subheadline) }
            }
            .padding(.vertical, 2)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint(open ? "Hides what was saved" : "Shows what was saved")
    }

    private var receipt: AttributedString { Words.markdown(change.receipt) }
}

// MARK: Record pages

/// A record page: its kind's rows, newest first, read on as it scrolls.
struct RecordListView: View {
    let shell: Shell
    let kind: String
    @State private var read: RecordPage?
    @State private var problem: String?
    @State private var reading = false
    /// On Medicines: today's doses.
    @State private var today: Today?

    private var path: String { "record/\(kind)" }
    /// Every row read so far, and where to read on.
    private var shown: RecordPage? { read ?? shell.kept[path] as? RecordPage }

    var body: some View {
        Group {
            if let groups = shown?.groups {
                let next = shown?.next
                if groups.isEmpty {
                    // Over an empty list, so pulling down reads again.
                    List {}.overlay {
                        ContentUnavailableView {
                            Text("Nothing here yet.")
                        } actions: {
                            AskRufiButton(shell: shell)
                        }
                    }
                } else {
                    List {
                        if kind == "medicine_use", let today = today ?? shell.kept["today"] as? Today {
                            TodaySection(shell: shell, today: today) { self.today = await TodaySection.read(shell) }
                        }
                        if kind == "measurement" {
                            // By the day they were taken, newest first.
                            ForEach(groups) { group in
                                let day = Words.day(group)
                                Section {
                                    ForEach(group.rows.rows) { RowLine(shell: shell, row: $0, day: group.date) }
                                } header: {
                                    Text("\(day.name) · \(day.detail)")
                                }
                                .listRowBackground(shell.theme.surface)
                            }
                        } else {
                            Section {
                                ForEach(groups.flatMap(\.rows.rows)) { RowLine(shell: shell, row: $0) }
                            }
                            .listRowBackground(shell.theme.surface)
                        }
                        if next != nil {
                            ProgressView().frame(maxWidth: .infinity)
                                .listRowBackground(Color.clear)
                                .task { await more() }
                        }
                    }
                }
            } else {
                Waiting(shell: shell, problem: problem)
            }
        }
        .task(id: shell.fresh) { await first() }
        .refreshable { await first() }
        // A dose log the outbox sent later (Rufi reached again): Today says so.
        .onChange(of: shell.outbox.logs.count) { old, new in
            if new < old { Task { await readToday() } }
        }
    }

    private func readToday() async {
        if kind == "medicine_use" { today = await TodaySection.read(shell) }
    }

    /// The first page again: what is newest now.
    private func first() async {
        await readToday()
        do {
            let page: RecordPage = try await shell.read(path)
            keep(page)
            problem = nil
        } catch {
            problem = error.shown ?? problem
        }
    }

    /// The page after the last read; out of reach, it waits for the next scroll.
    private func more() async {
        guard let after = shown?.next, !reading else { return }
        reading = true
        defer { reading = false }
        guard let page: RecordPage = try? await shell.read(path, query: ["after": after]),
              let before = shown, before.next == after else { return }
        keep(RecordPage(groups: before.groups + page.groups, next: page.next))
    }

    private func keep(_ page: RecordPage) {
        read = page
        shell.kept[path] = page
    }
}

/// One row on a record page, which opens it.
struct RowLine: View {
    let shell: Shell
    let row: RecordRow
    /// A measurement's day, which its row doesn't say again.
    var day: String??

    var body: some View {
        if row.problem != nil {
            Text("Can't show this row.").foregroundStyle(.secondary)
        } else if let address = Words.address(of: row, person: shell.pairing.person.id) {
            Opens {
                Task { await shell.go(address) }
            } label: {
                RowCells(cells: cells)
            }
        } else {
            RowCells(cells: cells)
        }
    }

    private var cells: Words.Cells {
        var cells = Words.cells(row)
        if row.kind == "result" {
            // A measurement: its name and value apart, its date only where its day's doesn't say it.
            cells.title = [row.test, row.replaces == nil ? nil : "(amended)"].compactMap { $0 }.joined(separator: " ")
            cells.status = [Words.value(of: row), cells.status].filter { !$0.isEmpty }.joined(separator: " · ")
            if let day { cells.date = Words.measured(row, on: day) }
        }
        return cells
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
    /// A medicine's doses.
    @State private var doses: MedicineDoses.Read?

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
                    if row.kind == "result" {
                        let line = Words.entered(row, at: detail.entered)
                        if !line.isEmpty { Text(line).font(.subheadline).foregroundStyle(.secondary) }
                    }
                }
            } footer: {
                if detail.removed { Text("Removed from your health record.") }
            }
            .listRowBackground(surface)
            if row.kind == "medicine_use", row.problem == nil {
                MedicineTiming(row: row, now: now).listRowBackground(surface)
                if let doses = doses ?? shell.kept["doses:\(row.id)"] as? MedicineDoses.Read,
                   row.times != nil || !doses.doses.doses.isEmpty {
                    MedicineDoses(doses: doses).listRowBackground(surface)
                }
            }
            if row.kind == "result", let test = row.in_test {
                Section {
                    Opens { Task { await shell.go("/people/\(person)/tests/\(test)") } } label: {
                        Text("\(row.test ?? "This test") over time")
                    }
                }
                .listRowBackground(surface)
            }
            DetailSections(shell: shell, detail: detail)
        }
        .task(id: shell.fresh) {
            if detail.row.kind == "medicine_use" { doses = await MedicineDoses.read(shell, medicine: detail.row.id) }
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

/// A record's sources, its history, and the versions an amendment links.
struct DetailSections: View {
    let shell: Shell
    let detail: RecordDetail

    private var surface: Color { shell.theme.surface }

    var body: some View {
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
            if let earlier = detail.replaces {
                Section("Replaces") {
                    Text("\(version(earlier)) \(Text("(the earlier version, kept)").foregroundStyle(.secondary))")
                }
                .listRowBackground(surface)
            }
            if let newer = detail.replacedBy {
                Section("Replaced by") { Text(version(newer)) }
                    .listRowBackground(surface)
            }
    }

    private func version(_ row: RecordRow) -> String {
        row.problem == nil ? Words.cells(row).title : "Can't show this row."
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
    @State private var read: About?
    @State private var failed = false

    /// The record named, and the one it is now: itself, or what amended it.
    struct About: Sendable {
        let named: RecordRow
        let now: RecordDetail
    }

    private var key: String { "about:\(about.kind)/\(about.id)" }

    var body: some View {
        let shown = read ?? shell.kept[key] as? About
        Group {
            if let shown, shown.now.row.problem == nil,
               let address = Words.address(of: shown.now.row, person: shell.pairing.person.id) {
                let label = Words.about(shown.named, now: shown.now.row)
                if shown.now.removed {
                    Text("About: \(label) (removed from your health record)")
                } else {
                    Opens { Task { await shell.go(address) } } label: { Text("About: \(label)") }
                }
            } else {
                // While it reads, the row's place is held, so its read runs.
                Text(failed || shown != nil ? "About: a record Rufi can't show" : "About:")
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: shell.fresh) {
            do throws(Door.Problem) {
                let named: RecordDetail = try await shell.read("record/\(about.kind)/\(about.id)")
                // Each amendment in turn, to the current one.
                var now = named
                for _ in 0..<10 {
                    guard let newer = now.replacedBy, newer.problem == nil else { break }
                    now = try await shell.read("record/\(newer.kind)/\(newer.id)")
                }
                let answer = About(named: named.row, now: now)
                read = answer
                shell.kept[key] = answer
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
                List {}.overlay {
                    ContentUnavailableView {
                        Text("Nothing to come back to yet. When a report or you mention a recheck, Rufi offers to add it here.")
                    } actions: {
                        AskRufiButton(shell: shell)
                    }
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

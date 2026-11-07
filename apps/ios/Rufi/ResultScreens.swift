import SwiftUI

// Lab results, a test's page and a visit's page, drawn here (NativePage).
// No chart: each value is a row, newest first, as the Mac lists them.

/// Lab results: each test once, by section, with its latest value as printed.
struct LabResultsView: View {
    let shell: Shell

    var body: some View {
        Reading(shell: shell, path: "lab-results") { (read: LabResults, _: Date) in
            if read.sections.isEmpty {
                List {}.overlay {
                    ContentUnavailableView {
                        Text("Nothing here yet.")
                    } actions: {
                        AskRufiButton(shell: shell)
                    }
                }
            } else {
                List {
                    ForEach(Array(read.sections.enumerated()), id: \.offset) { _, section in
                        Section(section.section ?? "Other tests") {
                            ForEach(section.tests, id: \.test.id) { TestLine(shell: shell, test: $0) }
                        }
                        .listRowBackground(shell.theme.surface)
                    }
                }
            }
        }
    }
}

/// A test on Lab results: its name and how many values, its latest value,
/// range, lab note and date. It opens the test's page.
private struct TestLine: View {
    let shell: Shell
    let test: LabResults.Test

    var body: some View {
        let latest = test.latest
        if test.test.problem != nil || latest.problem != nil {
            Text("Can't show this row.").foregroundStyle(.secondary)
        } else {
            Opens { Task { await shell.go("/people/\(shell.pairing.person.id)/tests/\(test.test.id)") } } label: {
                let cells = Words.cells(latest)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(test.test.name ?? "").fontWeight(.semibold)
                        Spacer(minLength: 8)
                        Text(Words.value(of: latest) + (latest.replaces == nil ? "" : " (amended)")).monospacedDigit()
                    }
                    let under = [Words.plural(test.count, "value", "values"), cells.detail, cells.status, cells.date]
                        .filter { !$0.isEmpty }.joined(separator: " · ")
                    Text(under).font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
    }
}

/// A test's page: its values, newest first, each opening as a row; then the
/// test's own sources and history.
struct TestView: View {
    let shell: Shell
    let screen: Screen
    let id: String

    var body: some View {
        Reading(shell: shell, path: "tests/\(id)") { (page: TestPage, at: Date) in
            if page.test.problem != nil || page.test.kind != "test" {
                List {}.overlay { Text("Can't show this test.").foregroundStyle(.secondary) }
            } else {
                List {
                    Section {
                        if page.values.isEmpty {
                            Text("No values in your health record now.").foregroundStyle(.secondary)
                        }
                        ForEach(page.values, id: \.row.id) { ValueLine(shell: shell, value: $0, unit: page.test.unit) }
                    } header: {
                        // "Thyroid · mIU/L · 1 value"
                        Text([page.test.section ?? "Other tests", page.test.unit,
                              Words.plural(page.values.count, "value", "values")]
                            .compactMap { $0 }.joined(separator: " · "))
                    }
                    .listRowBackground(shell.theme.surface)
                    TestDetail(shell: shell, id: id, page: at)
                }
                .onAppear { shell.titled(screen, page.test.name ?? "") }
            }
        }
    }
}

/// One value on a test's page: its date, value, where it came from, range
/// and lab note. It opens as a row.
private struct ValueLine: View {
    let shell: Shell
    let value: TestPage.Value
    let unit: String?

    var body: some View {
        let row = value.row
        if row.problem != nil || row.kind != "result" {
            Text("Can't show this row.").foregroundStyle(.secondary)
        } else if let address = Words.address(of: row, person: shell.pairing.person.id) {
            Opens { Task { await shell.go(address) } } label: {
                let cells = Words.cells(row)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(Words.printed(row.measured) ?? "No date").fontWeight(.semibold)
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 0) {
                            Text(Words.value(of: row)).monospacedDigit()
                            if let converted = Words.converted(row, unit: unit) {
                                Text(converted).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    let source = value.report.map { $0.issuer ?? "A report" } ?? "Typed in the chat"
                    let under = [row.replaces == nil ? nil : "amended", source, cells.detail, cells.status]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                    Text(under).font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
    }
}

/// The test's own sources and history, under its values.
private struct TestDetail: View {
    let shell: Shell
    let id: String
    /// When the page was read: this reads with it, on a pull too.
    let page: Date
    @State private var read: RecordDetail?

    private var key: String { "record/test/\(id)" }

    var body: some View {
        let detail = read ?? shell.kept[key] as? RecordDetail
        Group {
            if let detail {
                DetailSections(shell: shell, detail: detail)
            } else {
                // Its place held while it reads, so the read runs.
                Section("This test") { ProgressView().frame(maxWidth: .infinity) }
                    .listRowBackground(Color.clear)
            }
        }
        .task(id: page) {
            if let answer: RecordDetail = try? await shell.read(key) {
                read = answer
                shell.kept[key] = answer
            }
        }
    }
}

/// A visit's page: when and where, the doctor's words, what was saved from
/// it, and its own sources and history.
struct VisitView: View {
    let shell: Shell
    let screen: Screen
    let id: String

    var body: some View {
        Reading(shell: shell, path: "record/visit/\(id)") { (detail: RecordDetail, _: Date) in
            let row = detail.row
            if row.problem != nil || row.kind != "visit" {
                List {}.overlay { Text("Can't show this visit.").foregroundStyle(.secondary) }
            } else {
                List {
                    Section {
                        RowCells(cells: Words.Cells(title: Words.cells(row).title, detail: Words.visitWhen(row)))
                    } footer: {
                        if detail.removed { Text("Removed from your health record.") }
                    }
                    .listRowBackground(shell.theme.surface)
                    Section("The doctor's words") {
                        Text(Words.markdown(row.as_written ?? ""))
                    }
                    .listRowBackground(shell.theme.surface)
                    Section("From this visit") {
                        let saved = detail.fromVisit?.rows ?? []
                        if saved.isEmpty {
                            Text("Nothing saved from this visit yet.").foregroundStyle(.secondary)
                        }
                        ForEach(saved) { SavedLine(shell: shell, row: $0) }
                    }
                    .listRowBackground(shell.theme.surface)
                    DetailSections(shell: shell, detail: detail)
                }
                .onAppear { shell.titled(screen, Words.cells(row).title) }
            }
        }
    }
}

/// A record saved from a visit: what it is, its name and status; it opens
/// on its page.
private struct SavedLine: View {
    let shell: Shell
    let row: RecordRow

    var body: some View {
        if row.problem != nil {
            Text("Can't show this row.").foregroundStyle(.secondary)
        } else {
            let cells = Words.cells(row)
            let label = VStack(alignment: .leading, spacing: 2) {
                Text(Words.noun(row)).font(.subheadline).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline) {
                    Text(cells.title).fontWeight(.semibold)
                    Spacer(minLength: 8)
                    Text(cells.status).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            if let address = Words.address(of: row, person: shell.pairing.person.id) {
                Opens { Task { await shell.go(address) } } label: { label }
            } else {
                label
            }
        }
    }
}

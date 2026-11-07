import SwiftUI

// Documents and a document's page, drawn here (NativePage). As on the Mac,
// what a page asks of Rufi goes through the chat: adding puts the files'
// chips in the box, and Retry, Ask Rufi and Save in chat put their chip
// there too (Shell.ask); the chat then opens on them. A fix to a read item
// starts in the chat as well: Ask Rufi on the item.

/// Documents: newest first, each with its status; the Kind filter and Add.
struct DocumentsView: View {
    let shell: Shell
    /// The Kind filter: none for all kinds.
    @State private var kind: String?
    @State private var adding: AddFrom?
    @State private var reading: DocumentSummary?

    var body: some View {
        Reading(shell: shell, path: "documents", again: { $0.documents.contains { $0.status == "reading" } }) {
            (list: DocumentList, _: Date) in
            if list.documents.isEmpty {
                List {}.overlay {
                    ContentUnavailableView {
                        Label("No documents yet", systemImage: "doc.text")
                    } description: {
                        Text("Add a lab report or another document as a PDF, or as photos (JPEG, PNG or HEIC). Rufi keeps each original exactly as it came.")
                    } actions: {
                        add.buttonStyle(.bordered)
                    }
                }
            } else {
                let shown = list.documents.filter { kind == nil || $0.kind == kind }
                List {
                    Section {
                        if shown.isEmpty {
                            let name = Words.kindFilters.first { $0.0 == kind }?.1 ?? ""
                            Text("No \(name.lowercased()) yet.").foregroundStyle(.secondary)
                        }
                        ForEach(shown) { document in
                            DocumentLine(shell: shell, document: document) { reading = document }
                        }
                    } footer: {
                        Text("Newest first. Two files with the same name are two documents when their content differs.")
                    }
                    .listRowBackground(shell.theme.surface)
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                filter
                add
            }
        }
        .addingDocuments(shell: shell, from: $adding)
        .sheet(item: $reading) { ReadingSheet(shell: shell, document: $0) }
    }

    private var filter: some View {
        Menu {
            Picker("Kind", selection: $kind) {
                Text("All kinds").tag(String?.none)
                ForEach(Words.kindFilters, id: \.0) { Text($0.1).tag(Optional($0.0)) }
            }
        } label: {
            Label("Kind", systemImage: kind == nil ? "line.3.horizontal.decrease.circle"
                : "line.3.horizontal.decrease.circle.fill")
        }
    }

    /// Add: as the chat box's paperclip, while the box can take files.
    private var add: some View {
        Menu {
            AddFrom.choices { adding = $0 }
        } label: {
            Label("Add", systemImage: "plus")
        }
        .menuOrder(.fixed)
        .disabled(!shell.chat.loaded)
    }
}

/// A document on the list: its name, what more there is, its kind, date and
/// when it was added, and its status. It opens its page; Retry, View reading
/// and Ask Rufi are in its menu.
private struct DocumentLine: View {
    let shell: Shell
    let document: DocumentSummary
    let viewReading: () -> Void

    var body: some View {
        let (name, more) = Words.describe(document)
        Opens { Task { await shell.go("/people/\(shell.pairing.person.id)/documents/\(document.id)") } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: document.files.first?.mediaType == "application/pdf" ? "doc.text" : "photo")
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).fontWeight(.semibold)
                if !more.isEmpty { Text(more).font(.subheadline).foregroundStyle(.secondary) }
                Text([document.kind.flatMap { Words.kinds[$0] }, document.date.map(Words.printed),
                      "Added \(Words.printedDay(document.addedAt))"].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(Words.status(of: document)).font(.subheadline.weight(.medium))
            }
            }
            .padding(.vertical, 2)
        }
        .contextMenu {
            if Words.canRetry(document) {
                Button("Retry", systemImage: "arrow.clockwise") { Task { await retry(shell, document) } }
            }
            if document.reading != nil { Button("View reading", systemImage: "text.viewfinder", action: viewReading) }
            if document.status != "reading" {
                Button("Ask Rufi", systemImage: "message") {
                    Task { await shell.ask([Chip(type: "document", id: document.id, label: name)]) }
                }
            }
        }
    }
}

/// Retry: the document's chip, to read again, in the chat's box; nothing is
/// read until the person sends.
private func retry(_ shell: Shell, _ document: DocumentSummary) async {
    await shell.ask([Chip(type: "document", id: document.id, readAgain: true, label: "")])
}

/// A document's page: what it is, its pages, and what the reader read from
/// them, by page; View original, View reading, Retry and Delete.
struct DocumentView: View {
    let shell: Shell
    let screen: Screen
    let id: String

    /// The document as the list has it, and its pages and items.
    nonisolated struct Read: Decodable, Sendable {
        let document: DocumentSummary?
        let items: DocumentItems
    }

    var body: some View {
        Reading(shell: shell, path: "documents/\(id)", again: { $0.document?.status == "reading" }, load: { shell async throws(Door.Problem) -> Read in
            let list: DocumentList = try await shell.read("documents")
            let items: DocumentItems = try await shell.read("documents/\(id)/items")
            return Read(document: list.documents.first { $0.id == id }, items: items)
        }) { (read: Read, _: Date) in
            if let document = read.document {
                DocumentPage(shell: shell, screen: screen, document: document, items: read.items)
            } else {
                List {}.overlay {
                    Text("There is no such document. It may have been deleted.").foregroundStyle(.secondary).padding()
                }
            }
        }
    }
}

private struct DocumentPage: View {
    let shell: Shell
    let screen: Screen
    let document: DocumentSummary
    let items: DocumentItems
    /// The page shown, by its position: an item tapped shows its own.
    @State private var shown: Int?
    @State private var lookOnly = false
    @State private var viewing = false
    @State private var deleting = false

    private var surface: Color { shell.theme.surface }

    var body: some View {
        let name = Words.describe(document).name
        ScrollViewReader { scroll in
            List {
                about
                actions
                page.id("page")
                read { position in
                    shown = position
                    withAnimation { scroll.scrollTo("page", anchor: .top) }
                }
                save(name)
                Section {
                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = true }
                        .foregroundStyle(.red)
                }
                .listRowBackground(surface)
            }
        }
        .onAppear { shell.titled(screen, name) }
        .onChange(of: name) { _, now in shell.titled(screen, now) }
        .sheet(isPresented: $viewing) { ReadingSheet(shell: shell, document: document) }
        .sheet(isPresented: $deleting) { DeleteSheet(shell: shell, document: document) }
    }

    /// What it is, how far it was read, and whether anything was saved.
    private var about: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(Words.about(document, pages: items.pages.count)).font(.subheadline).foregroundStyle(.secondary)
                if document.status == "failed" { Text("Failed · \(document.reading?.error ?? "it stopped")") }
                if document.notSorted { Text("Not sorted yet") }
                Text(Words.settled(items) ?? "What the reader read, not saved. These become part of your health record only when you save them in the chat.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(items.savedAs, id: \.id) { visit in
                Opens { Task { await shell.go("/people/\(shell.pairing.person.id)/visits/\(visit.id)") } } label: {
                    LabeledContent("Saved as", value: "Visit · \(visit.label)")
                }
            }
        }
        .listRowBackground(surface)
    }

    private var actions: some View {
        Section {
            Button("View original", systemImage: "doc") {
                Task { await shell.show(document.id, document.files.map { (id: $0.id, name: $0.name) }) }
            }
            if document.reading != nil { Button("View reading", systemImage: "text.viewfinder") { viewing = true } }
            if Words.canRetry(document) {
                Button("Retry", systemImage: "arrow.clockwise") { Task { await retry(shell, document) } }
            }
        }
        .listRowBackground(surface)
    }

    /// The page shown, as Rufi AI saw it, with the arrows to the others.
    @ViewBuilder
    private var page: some View {
        let pages = items.pages
        if !pages.isEmpty {
            let at = pages.firstIndex { $0.position == (shown ?? items.items.first?.page ?? 1) } ?? 0
            let page = pages[at]
            Section {
                PageImage(shell: shell, document: document.id, position: page.position,
                          label: "Page \(at + 1) of \(pages.count)")
                    .listRowInsets(EdgeInsets())
            } header: {
                HStack {
                    Button("Previous page", systemImage: "chevron.left") { shown = pages[at - 1].position }
                        .disabled(at == 0)
                    Spacer()
                    VStack(spacing: 0) {
                        Text("Page \(at + 1) of \(pages.count)").fontWeight(.semibold)
                        if let place = document.place {
                            Text("(page \(page.position) of \(place.of) in the file)").font(.caption)
                        }
                    }
                    Spacer()
                    Button("Next page", systemImage: "chevron.right") { shown = pages[at + 1].position }
                        .disabled(at == pages.count - 1)
                }
                .labelStyle(.iconOnly)
                .textCase(nil)
            } footer: {
                Text(Words.page(page, items: items.items.count { $0.page == page.position }))
            }
            .listRowBackground(surface)
        }
    }

    /// What the reader read, by page: each item, and Ask Rufi on one not saved.
    @ViewBuilder
    private func read(_ show: @escaping (Int) -> Void) -> some View {
        let marked = items.items.filter { !$0.unsure.isEmpty }
        if document.status == "reading" {
            Section { Text("The reader is reading this document. Its items show here when it's done.") }
                .listRowBackground(surface)
        } else if document.status == "not_read" {
            Section { Text("This document isn't read yet.") }.listRowBackground(surface)
        } else {
            Section {
                Toggle("Worth a look only (\(marked.count))", isOn: $lookOnly)
            } footer: {
                Text(Words.counts(items))
            }
            .listRowBackground(surface)
            let pages = lookOnly ? items.pages.filter { page in marked.contains { $0.page == page.position } } : items.pages
            if pages.isEmpty {
                Section { Text(lookOnly ? "Nothing is worth a look." : "No items were read.").foregroundStyle(.secondary) }
                    .listRowBackground(surface)
            }
            ForEach(pages, id: \.position) { page in
                Section {
                    ForEach(items.items.filter { $0.page == page.position && (!lookOnly || !$0.unsure.isEmpty) }) { item in
                        DraftLine(item: item) { show(item.page) } ask: {
                            let label = [item.fields.test_name, item.fields.value_text, item.fields.unit ?? ""]
                                .filter { !$0.isEmpty }.joined(separator: " ")
                            Task { await shell.ask([Chip(type: "draft_item", id: item.id, label: label)]) }
                        }
                    }
                } header: {
                    HStack {
                        Text("Page \(page.position) · \(Words.page(page, items: items.items.count { $0.page == page.position }))")
                        if page.state == "not_looked_at" || page.state == "unreadable", document.status != "reading" {
                            Spacer()
                            Button("Retry", systemImage: "arrow.clockwise") { Task { await retry(shell, document) } }
                                .textCase(nil)
                        }
                    }
                }
                .listRowBackground(surface)
            }
        }
    }

    /// What waits to be saved, and Save in chat.
    private func save(_ name: String) -> some View {
        Section {
            if let left = Words.left(items) {
                Text("Not saved yet: \(left).")
                let count = Words.toSave(items)
                Button("Save in chat", systemImage: "message") {
                    let text = count == 1 ? "Save this result." : "Save these \(count) results."
                    Task { await shell.ask([Chip(type: "document", id: document.id, label: name)], text: text) }
                }
                .disabled(count == 0)
            } else {
                Text("Nothing here waits to be saved.").foregroundStyle(.secondary)
            }
        }
        .listRowBackground(surface)
    }
}

/// A page as Rufi AI saw it, read with the key and kept in memory while
/// Rufi is open.
private struct PageImage: View {
    let shell: Shell
    let document: String
    let position: Int
    let label: String
    @State private var read: (key: String, data: Data)?
    @State private var problem: String?

    private var key: String { "page:\(document):\(position)" }

    var body: some View {
        Group {
            if let data = read?.key == key ? read?.data : shell.kept[key] as? Data, let image = UIImage(data: data) {
                // Room for the items under it; View original shows it whole.
                Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 420).accessibilityLabel(label)
            } else if let problem {
                Text(problem).foregroundStyle(.secondary).padding()
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 240)
            }
        }
        .frame(maxWidth: .infinity)
        .task(id: key) {
            problem = nil
            guard shell.kept[key] == nil else { return }
            do throws(Door.Problem) {
                let data = try await shell.page(of: document, at: position)
                read = (key, data)
                shell.kept[key] = data
                problem = nil
            } catch {
                problem = error.shown
            }
        }
    }
}

/// One item the reader read: its test, value and range, its marks, why it is
/// worth a look, the words it came from, and what a fix changed.
private struct DraftLine: View {
    let item: DraftItem
    let select: () -> Void
    let ask: () -> Void

    var body: some View {
        let fields = item.fields
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(fields.test_name).fontWeight(.semibold)
                        + Text(fields.context_text.map { " · \($0)" } ?? "").foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Text([fields.value_text, fields.unit].compactMap { $0 }.joined(separator: " ")).monospacedDigit()
                }
                if let range = fields.reference_range { Text("Range \(range)").font(.subheadline).foregroundStyle(.secondary) }
                let marks = Words.marks(item)
                if !marks.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(marks, id: \.self) { mark in
                            Text(mark).font(.caption)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .overlay { Capsule().strokeBorder(.secondary, lineWidth: 0.5) }
                        }
                    }
                }
                Group {
                    if item.outOfDate {
                        Text("Out of date: this page was read again")
                    } else {
                        ForEach(item.unsure, id: \.self) { Text("Worth a look: \($0)").foregroundStyle(.secondary) }
                        if let quote = item.quote { Text("From the page: “\(quote)”").foregroundStyle(.secondary) }
                    }
                    if let drafted = Words.drafted(item) { Text(drafted).foregroundStyle(.secondary) }
                }
                .font(.footnote)
            }
            .opacity(item.status == "pending" ? 1 : 0.6)
            if item.status == "pending" {
                Button("Ask Rufi about this", systemImage: "message", action: ask)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
        .contentShape(.rect)
        .onTapGesture(perform: select)
    }
}

/// View reading: the reader's work on each page, as it read it, its note,
/// and the AI's use.
struct ReadingSheet: View {
    let shell: Shell
    let document: DocumentSummary
    @Environment(\.dismiss) private var dismiss

    nonisolated struct Read: Decodable, Sendable {
        let reading: ReadingView
        let items: DocumentItems
    }

    var body: some View {
        NavigationStack {
            Reading(shell: shell, path: "documents/\(document.id)/reading", again: { $0.reading.status == "reading" },
                    load: { shell async throws(Door.Problem) -> Read in
                        let reading: ReadingView = try await shell.read("documents/\(document.id)/reading")
                        let items: DocumentItems = try await shell.read("documents/\(document.id)/items")
                        return Read(reading: reading, items: items)
                    }) { (read: Read, _: Date) in
                pages(read.reading, read.items)
            }
            .navigationTitle(Words.describe(document).name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
            .listStyle(.insetGrouped)
            .themed(shell.theme)
        }
    }

    private func pages(_ reading: ReadingView, _ items: DocumentItems) -> some View {
        let surface = shell.theme.surface
        let canRetry = document.status != "reading" && (reading.status == "failed" || (reading.status == "done"
            && reading.pages.contains { $0.state == "unreadable" || $0.state == "not_looked_at" }))
        return List {
            Section {
                Text(Words.status(of: reading, document: document)).fontWeight(.semibold)
                if reading.status == "failed" { Text(reading.error ?? "it stopped") }
                Text(Words.settled(items) ?? "What the reader read, not saved: these become part of your health record only when you save them in the chat.")
                    .font(.footnote).foregroundStyle(.secondary)
                if canRetry { Button("Retry", systemImage: "arrow.clockwise") { again() } }
            }
            .listRowBackground(surface)
            if let note = reading.note {
                Section("The reader's note") { Text(note) }.listRowBackground(surface)
            }
            ForEach(reading.pages, id: \.position) { page in
                Section {
                    if let copy = page.copy, !copy.isEmpty {
                        Text(copy).font(.footnote.monospaced()).textSelection(.enabled)
                    }
                    if let why = page.why { Text(why) }
                } header: {
                    HStack {
                        Text("Page \(page.position) · \(Words.outcome(page.state))")
                        if document.status != "reading", page.state == "unreadable" || page.state == "not_looked_at" {
                            Spacer()
                            Button("Retry", systemImage: "arrow.clockwise") { again() }.textCase(nil)
                        }
                    }
                }
                .listRowBackground(surface)
            }
            if let usage = reading.usage {
                Section("AI usage") {
                    LabeledContent("Model", value: (reading.model ?? "—") + (reading.effort.map { " · \($0) effort" } ?? ""))
                    LabeledContent("Pages looked at", value: String(usage.looks))
                    LabeledContent("Tokens", value: "\(usage.totalTokens.formatted(.number.locale(Locale(identifier: "en_US")))) (\(usage.cachedInputTokens.formatted(.number.locale(Locale(identifier: "en_US")))) cached)")
                }
                .listRowBackground(surface)
            }
        }
    }

    /// Retry: closes, and the chip goes in the chat's box.
    private func again() {
        dismiss()
        Task { await retry(shell, document) }
    }
}

/// Delete: what it would do, then the delete made on that preview. With
/// saved records from it, the person chooses whether they stay or go.
struct DeleteSheet: View {
    let shell: Shell
    let document: DocumentSummary
    @Environment(\.dismiss) private var dismiss
    @State private var preview: DeletePreview?
    @State private var changed = false
    @State private var problem: String?
    /// The delete running: the choice it was made with.
    @State private var deleting: Words.DeleteChoice?

    var body: some View {
        NavigationStack {
            List {
                if changed {
                    Section { Text("Something changed since you opened this. Nothing was deleted. Here is how it is now.") }
                }
                if let preview {
                    what(preview)
                    Section {
                        ForEach(Words.deleteChoices(preview), id: \.title) { choice in
                            Button(deleting == choice ? "Deleting…" : choice.title, systemImage: choice.symbol, role: .destructive) {
                                Task { await delete(choice, on: preview) }
                            }
                            .foregroundStyle(.red)
                            .disabled(deleting != nil)
                        }
                    }
                } else if problem == nil {
                    ProgressView().frame(maxWidth: .infinity)
                }
                if let problem { Section { Text(problem).foregroundStyle(.secondary) } }
            }
            .listRowBackground(shell.theme.surface)
            .navigationTitle("Delete \(preview?.name ?? Words.describe(document).name)?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
            }
            .listStyle(.insetGrouped)
            .themed(shell.theme)
        }
        .task { await read() }
    }

    /// What goes and what stays, as the Mac's preview says it.
    @ViewBuilder
    private func what(_ preview: DeletePreview) -> some View {
        let part = preview.others > 0 ? preview.place : nil
        if preview.saved.isEmpty {
            Section("Goes from Rufi") {
                Text(part.map { "Its part of the file: \($0)" } ?? "The file: \(Words.files(in: preview))")
                if preview.unsaved > 0 {
                    Text("What the reader read: \(Words.plural(preview.unsaved, "unsaved item", "unsaved items"))")
                }
                if preview.readings > 0 { Text("The reading under way stops") }
            }
            Section("Stays") {
                if preview.others > 0 { Text("The file: \(Words.othersUse(preview.others))") }
                Text("Your health record and its history")
                Text("The chat. Where it points at this document, it says \"document deleted\".")
            }
        } else {
            Section {
                ForEach(preview.saved, id: \.id) { saved in
                    LabeledContent {
                        Text(saved.date ?? "")
                    } label: {
                        Text(saved.label) + Text(saved.replaced ? " · replaced" : "").foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text(Words.savedFrom(preview.saved)).textCase(nil)
            } footer: {
                if preview.saved.contains(where: { $0.kind == "visit" }) {
                    Text("Medicines or follow-ups saved from a visit here aren't listed; Rufi AI goes through them with you.")
                }
            }
            Section {
                if let part {
                    Text("Its part of the file: \(part)")
                    Text("The file stays: \(Words.othersUse(preview.others))")
                }
                Text("**Delete file**: the results stay in your health record. Where they came from says \"document deleted\".")
                Text("**Delete file and results**: the chat opens, and the AI goes through the results with you. It removes each one only when you say yes.")
            }
        }
        Section {
            Text("Rufi can't reach copies outside it. Its backups keep this document until they age out, in about 5 weeks. Backups from before an update keep it until you remove them. Exports you saved, Time Machine, and what the AI already read keep theirs.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func read() async {
        do throws(Door.Problem) {
            preview = try await shell.read("documents/\(document.id)/delete")
        } catch {
            problem = error.shown
        }
    }

    private func delete(_ choice: Words.DeleteChoice, on shown: DeletePreview) async {
        deleting = choice
        defer { deleting = nil }
        var body = ["version": shown.version]
        if let saved = choice.saved { body["saved"] = saved }
        do throws(Door.Problem) {
            let _: Deleted = try await shell.post("documents/\(document.id)/delete", body: body)
        } catch {
            // A preview that changed meanwhile refuses the delete: it shows as it is now.
            if case .refused = error, let now: DeletePreview = try? await shell.read("documents/\(document.id)/delete"),
               now.version != shown.version {
                preview = now
                changed = true
                problem = nil
            } else {
                problem = error.shown
            }
            return
        }
        dismiss()
        // The results to remove: the AI goes through them in the chat.
        await shell.choose(choice.saved == "remove" ? .chat : .documents)
    }

    private struct Deleted: Decodable {
        let deleted: Bool
    }
}

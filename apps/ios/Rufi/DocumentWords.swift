import Foundation

// The Mac's words for Documents and a document's page, ported from
// documents.tsx, document-page.tsx, reading.tsx and delete-document.tsx.

extension Words {
    static let kinds = ["lab_report": "Lab report", "prescription": "Prescription", "letter": "Letter", "other": "Other"]
    /// The Kind filter: its choices, in order.
    static let kindFilters = [("lab_report", "Lab reports"), ("prescription", "Prescriptions"), ("letter", "Letters"),
                              ("other", "Other")]

    /// An instant's day on this iPhone: "4 Oct 2026".
    static func printedDay(_ iso: String, calendar: Calendar = .current) -> String {
        guard let at = instant(iso) else { return iso }
        let parts = calendar.dateComponents([.year, .month, .day], from: at)
        return "\(parts.day ?? 0) \(months[(parts.month ?? 1) - 1]) \(parts.year ?? 0)"
    }

    /// Positions, consecutive ones joined: [1, 2, 3, 5] → "1–3, 5".
    static func ranges(_ positions: [Int]) -> String {
        var runs: [(Int, Int)] = []
        for position in positions.sorted() {
            if let last = runs.last, position == last.1 + 1 { runs[runs.count - 1].1 = position } else { runs.append((position, position)) }
        }
        return runs.map { $0 == $1 ? String($0) : "\($0)–\($1)" }.joined(separator: ", ")
    }

    /// Its pages in what was added: "pages 3–4 of 5".
    static func place(_ place: DocumentSummary.Place) -> String {
        "\(place.pages.count == 1 ? "page" : "pages") \(ranges(place.pages)) of \(place.of)"
    }

    /// A document's name, and what more there is: its place, a PDF's pages,
    /// or the other photos.
    static func describe(_ document: DocumentSummary) -> (name: String, more: String) {
        let first = document.files.first
        let photos = document.files.count
        let more = if let place = document.place {
            Words.place(place)
        } else if first?.mediaType == "application/pdf" {
            plural(first?.pages ?? 0, "page", "pages")
        } else if photos > 1 {
            "+ \(photos - 1) more \(photos == 2 ? "photo" : "photos")"
        } else {
            ""
        }
        return (first?.name ?? "Document", more)
    }

    /// A document's status on the list: "Not saved · 2 results".
    static func status(of document: DocumentSummary) -> String {
        let results = { (count: Int) in plural(count, "result", "results") }
        if document.status == "reading", document.reader != nil { return "Reading" }
        guard document.status != "not_read", let reading = document.reading else { return "Not read yet" }
        let read = "read \(reading.saved) of \(reading.of)"
        if document.status == "reading" { return "Reading · \(read)" }
        if document.status == "failed" { return "Failed · \(read)" }
        if document.notSorted { return "Not sorted yet" }
        if reading.hasPending { return reading.results > 0 ? "Not saved · \(results(reading.results))" : "Not saved" }
        if reading.canRetry { return "To check" }
        if reading.itemsSaved > 0 { return "Saved · \(results(reading.itemsSaved))" }
        if reading.itemsSetAside > 0 { return "Set aside · \(results(reading.itemsSetAside))" }
        return "Nothing to save"
    }

    /// Retry would read something: not read yet, or a reading that can.
    static func canRetry(_ document: DocumentSummary) -> Bool {
        document.status != "reading" && (document.status == "not_read" || document.reading?.canRetry == true)
    }

    /// Under a document's name: "Lab report · 2 pages · Sunrise Labs · 12 Aug 2026 · added 13 Aug 2026".
    static func about(_ document: DocumentSummary, pages: Int, calendar: Calendar = .current) -> String {
        ([document.kind.flatMap { kinds[$0] }, document.place.map(place) ?? plural(pages, "page", "pages"),
          document.lab, document.date.map(printed)] + ["added \(printedDay(document.addedAt, calendar: calendar))"])
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// Once nothing waits: whether anything was saved; none while something waits.
    static func settled(_ items: DocumentItems) -> String? {
        let states = items.items.map(\.status)
        if states.isEmpty || states.contains("pending") { return nil }
        return states.contains("saved") ? "These results were saved to your health record."
            : "Nothing from this document was saved to your health record."
    }

    /// What waits to be saved: "2 results · 1 earlier"; none when nothing waits.
    static func left(_ items: DocumentItems) -> String? {
        let pending = items.items.filter { $0.status == "pending" && !$0.outOfDate }
        guard !pending.isEmpty else { return nil }
        let earlier = pending.filter { $0.fields.column == "earlier" }.count
        return ([plural(pending.count - earlier, "result", "results")] + (earlier > 0 ? ["\(earlier) earlier"] : []))
            .joined(separator: " · ")
    }

    /// Over the items: what was saved and set aside once nothing waits; else
    /// what waits, how much is worth a look, and what she fixed.
    static func counts(_ items: DocumentItems) -> String {
        if settled(items) != nil {
            let saved = items.items.count { $0.status == "saved" }
            let aside = items.items.count { $0.status == "dismissed" }
            return ((saved > 0 ? ["\(saved) saved"] : []) + (aside > 0 ? ["\(aside) set aside"] : [])).joined(separator: " · ")
        }
        let pending = items.items.filter { $0.status == "pending" && !$0.outOfDate }
        let results = pending.filter { $0.fields.column != "earlier" }
        let earlier = pending.count - results.count
        let fixed = pending.count { drafted($0) != nil }
        return ([plural(results.count, "result", "results")] + (earlier > 0 ? ["\(earlier) earlier"] : [])
            + ["\(results.count { !$0.unsure.isEmpty }) worth a look"] + (fixed > 0 ? ["\(fixed) fixed by you"] : []))
            .joined(separator: " · ")
    }

    /// A delete's buttons: with saved records from it, whether they stay
    /// (`keep`) or go (`remove`); without, one Delete.
    struct DeleteChoice: Equatable {
        let title: String
        let symbol: String
        let saved: String?
    }

    static func deleteChoices(_ preview: DeletePreview) -> [DeleteChoice] {
        preview.saved.isEmpty ? [DeleteChoice(title: "Delete", symbol: "trash", saved: nil)] : [
            DeleteChoice(title: "Delete file", symbol: "xmark.bin", saved: "keep"),
            DeleteChoice(title: "Delete file and results", symbol: "trash", saved: "remove"),
        ]
    }

    /// The pending current results Save in chat saves.
    static func toSave(_ items: DocumentItems) -> Int {
        items.items.filter { $0.status == "pending" && !$0.outOfDate && $0.fields.column != "earlier" }.count
    }

    /// A page's band: "read · 3 items", "couldn't be read: too dark".
    static func page(_ page: DocumentItems.Page, items: Int) -> String {
        let words = switch page.state {
        case nil: "not read yet"
        case "read": "read · \(plural(items, "item", "items"))"
        case "unreadable": page.why.map { "couldn't be read: \($0)" } ?? "couldn't be read"
        case "nothing_here": "nothing here"
        case "not_looked_at": "not looked at"
        case let other?: other
        }
        guard let incomplete = page.incomplete else { return words }
        return "\(words) · may be incomplete: the reader counted \(plural(incomplete.rows_seen, "row", "rows")) and read \(incomplete.items)"
    }

    /// The fields a fix changed, as drafted: "Drafted: value 13.2".
    static func drafted(_ item: DraftItem) -> String? {
        let fields: [(String, (DraftItem.Fields) -> String?)] = [
            ("test", \.test_name), ("value", \.value_text), ("unit", \.unit), ("range", \.reference_range),
            ("flag", \.flag_text), ("context", \.context_text),
        ]
        let fixed = fields.filter { $0.1(item.fields) != $0.1(item.original) }
        guard !fixed.isEmpty else { return nil }
        let words = fixed.map { "\($0.0) \($0.1(item.original) ?? "(empty)")" }.joined(separator: " · ")
        return "\(item.quote == nil ? "The reader read" : "Drafted"): \(words)"
    }

    /// An item's marks, in order: its flag, earlier, fixed by you, saved or set aside.
    static func marks(_ item: DraftItem) -> [String] {
        [item.fields.flag_text, item.fields.column == "earlier" ? "earlier" : nil,
         drafted(item) == nil ? nil : "fixed by you",
         item.status == "saved" ? "saved" : item.status == "dismissed" ? "set aside" : nil].compactMap { $0 }
    }

    /// View reading's status: "reading · read 1 of 2", "read", "failed · read 1 of 2".
    static func status(of reading: ReadingView, document: DocumentSummary?) -> String {
        if document?.status == "reading", document?.reader != nil { return "reading" }
        return switch reading.status {
        case "reading": "reading · read \(reading.saved) of \(reading.of)"
        case "failed": "failed · read \(reading.saved) of \(reading.of)"
        case "done": "read"
        default: "not read yet"
        }
    }

    /// A page's line in View reading: "read · 1 item · Sunrise Labs ·
    /// Collected 1 Sep 2026"; an older reader's page not finished, "read so far".
    static func summary(_ page: ReadingView.Page) -> String {
        let entry = page.entry
        let outcome = page.state != nil || entry == nil ? outcome(page.state) : "\(outcome(entry?.outcome)) so far"
        let items = entry.flatMap { $0.outcome == "read" ? plural($0.items.count, "item", "items") : nil }
        let dated = entry?.facts?.dates?.first.map { "\($0.label) \($0.date)" }
        return [outcome, items, entry?.facts?.issuer, dated].compactMap { $0 }.joined(separator: " · ")
    }

    /// A page's rows in View reading, as the Mac shows them: none for a
    /// copied page (its copy shows); a page read, its draft items now; an
    /// older reader's page not finished, its entry's items.
    struct ReadRow: Equatable {
        let name: String
        let value: String
        let range: String?
        let marks: [String]
        /// Why it may be wrong.
        let why: String?
    }

    static func rows(_ page: ReadingView.Page, drafts: [DraftItem]) -> [ReadRow] {
        guard page.copy == nil else { return [] }
        let row = { (name: String, column: String?, value: String, unit: String?, range: String?, flag: String?,
                     fixed: Bool, why: String) in
            ReadRow(name: name + (column == "earlier" ? " (earlier)" : ""),
                    value: [value, unit].compactMap { $0 }.joined(separator: " "), range: range,
                    marks: [flag, fixed ? "fixed by you" : nil, why.isEmpty ? nil : "unsure"].compactMap { $0 },
                    why: why.isEmpty ? nil : why)
        }
        if page.state == "read" {
            return drafts.filter { $0.page == page.position }.map { item in
                let fields = item.fields
                return row(fields.test_name, fields.column, fields.value_text, fields.unit, fields.reference_range,
                           fields.flag_text, drafted(item) != nil, item.unsure.joined(separator: " "))
            }
        }
        return (page.entry?.items ?? []).enumerated().map { index, item in
            let why = [item.unsure, page.checks?.items.first { $0.item == index + 1 }?.why].compactMap { $0 }
                .joined(separator: " ")
            return row(item.test_name, item.column, item.value_text, item.unit, item.reference_range, item.flag_text,
                       false, why)
        }
    }

    /// A page in View reading: "read", "nothing here".
    static func outcome(_ state: String?) -> String {
        switch state {
        case "read": "read"
        case "nothing_here": "nothing here"
        case "unreadable": "couldn't be read"
        case "not_looked_at": "not looked at"
        default: "not read yet"
        }
    }

    /// A document's files in its delete preview: "1 PDF, 2 pages", "2 photos".
    static func files(in preview: DeletePreview) -> String {
        let pages = preview.files.reduce(0) { $0 + $1.pages }
        let pdfs = preview.files.filter { $0.name.lowercased().hasSuffix(".pdf") }.count
        let photos = preview.files.count - pdfs
        return ((pdfs > 0 ? [plural(pdfs, "PDF", "PDFs")] : []) + (photos > 0 ? [plural(photos, "photo", "photos")] : [])
            + (pdfs > 0 ? [plural(pages, "page", "pages")] : [])).joined(separator: ", ")
    }

    /// The other documents that keep its file: "1 other document uses it".
    static func othersUse(_ others: Int) -> String {
        others == 1 ? "1 other document uses it" : "\(others) other documents use it"
    }

    /// The saved records a delete asks about: "5 records in your health record come from it:".
    static func savedFrom(_ saved: [DeletePreview.Saved]) -> String {
        let noun = saved.allSatisfy { $0.kind == "result" } ? "result" : "record"
        return saved.count == 1 ? "1 \(noun) in your health record comes from it:"
            : "\(saved.count) \(noun)s in your health record come from it:"
    }
}

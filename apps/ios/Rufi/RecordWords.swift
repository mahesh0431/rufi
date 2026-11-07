import Foundation

// The record's words on the iPhone, the same as the Mac's pages say them
// (apps/web/src/dates.ts, record.tsx, overview.tsx, follow-ups.tsx): worked
// out from the saved record, never by the AI. Keep the two in step.
nonisolated enum Words {
    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// The pages by their title.
    static let titles: [String: String] = [
        "lab_result": "Lab results", "measurement": "Measurements", "medicine_use": "Medicines",
        "visit": "Visits", "condition": "Conditions", "allergy": "Allergies",
        "symptom": "Symptoms", "care_event": "Care events",
    ]

    static let status: [String: String] = [
        "current": "Taking now", "paused": "Paused", "stopped": "Stopped", "completed": "Completed",
        "ongoing": "Ongoing", "resolved": "Resolved", "active": "Active", "inactive": "Inactive",
        "planned": "Planned", "done": "Done", "not_done": "Not done", "open": "Open", "dropped": "Dropped",
    ]

    static let actions: [String: String] = [
        "add": "Added", "change": "Changed", "remove": "Removed", "restore": "Put back",
        "link": "Another source added", "unlink": "A source taken off",
    ]

    /// The follow-ups page's groups.
    static let headings: [String: String] = [
        "overdue": "Overdue", "due": "Due now", "coming_up": "Coming up", "later": "Later",
        "next_visit": "At the next visit", "no_date": "No date", "done": "Done", "dropped": "Dropped",
    ]

    // MARK: Dates

    /// "2026-08-12" → "12 Aug 2026"; "2026-08" → "Aug 2026"; "2026" →
    /// "2026"; "2026-05-20T08:30" → "20 May 2026 08:30", the time as stored.
    /// Text that isn't a date is shown as it is.
    static func printed(_ value: String) -> String {
        let pattern = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}:\d{2}))?)?)?$/
        guard let match = value.wholeMatch(of: pattern) else { return value }
        let year = String(match.1)
        guard let month = match.2 else { return year }
        guard let number = Int(month), (1...12).contains(number) else { return value }
        let name = months[number - 1]
        guard let day = match.3 else { return "\(name) \(year)" }
        let date = "\(Int(day) ?? 0) \(name) \(year)"
        return match.4.map { "\(date) \($0)" } ?? date
    }

    static func printed(_ when: Dated?) -> String? {
        when.map { printed($0.date) }
    }

    /// From one date to another, as known.
    static func span(_ from: Dated?, _ to: Dated?) -> String? {
        switch (printed(from), printed(to)) {
        case let (from?, to?): "\(from) to \(to)"
        case let (from?, nil): "since \(from)"
        case let (nil, to?): "until \(to)"
        case (nil, nil): nil
        }
    }

    /// An ISO time.
    static func instant(_ iso: String) -> Date? {
        (try? Date(iso, strategy: .iso8601))
            ?? (try? Date(iso, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
    }

    /// "at 18:30 on 4 Oct 2026", in this phone's time zone.
    static func time(_ iso: String, calendar: Calendar = .current) -> String {
        guard let at = instant(iso) else { return iso }
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: at)
        return "at \(clock(parts)) on \(parts.day ?? 0) \(months[(parts.month ?? 1) - 1]) \(parts.year ?? 0)"
    }

    /// When a save was: "Today 01:45", "Yesterday 18:02", else "18:31 on 3 Sep 2026".
    static func savedAt(_ iso: String, now: Date, calendar: Calendar = .current) -> String {
        guard let at = instant(iso) else { return iso }
        let parts = calendar.dateComponents([.hour, .minute], from: at)
        if calendar.isDate(at, inSameDayAs: now) { return "Today \(clock(parts))" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(at, inSameDayAs: yesterday) {
            return "Yesterday \(clock(parts))"
        }
        return String(time(iso, calendar: calendar).dropFirst(3))
    }

    /// "Saturday 7 November" for today's greeting.
    static func today(_ now: Date, calendar: Calendar = .current) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .omitted, locale: Locale(identifier: "en_GB"), calendar: calendar)
        style.timeZone = calendar.timeZone
        return now.formatted(style.weekday(.wide).day().month(.wide))
    }

    /// Good morning, afternoon or evening, by the hour.
    static func greeting(_ now: Date, calendar: Calendar = .current) -> String {
        let hour = calendar.component(.hour, from: now)
        return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
    }

    private static func clock(_ parts: DateComponents) -> String {
        String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    // MARK: Rows

    /// What a row says: its title, a detail, its status and its date.
    struct Cells: Equatable {
        var title: String
        var detail = ""
        var status = ""
        var date = ""
    }

    /// A row's cells, the Mac's `cellsOf` for the kinds the phone draws.
    static func cells(_ row: RecordRow) -> Cells {
        let state = status[row.status ?? ""] ?? ""
        let joined = { (parts: [String?]) in parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }
        switch row.kind {
        case "condition":
            return Cells(title: row.name ?? "", detail: row.certainty == "unknown" ? "" : row.certainty ?? "",
                         status: state, date: printed(row.recognised) ?? "")
        case "allergy":
            return Cells(title: row.substance ?? "", detail: row.reaction ?? "", status: state,
                         date: printed(row.reacted) ?? "")
        case "symptom":
            return Cells(title: row.name ?? "", detail: joined([row.severity, row.location]), status: state,
                         date: span(row.onset, row.ended) ?? "")
        case "care_event":
            return Cells(title: row.name ?? "", detail: joined([row.type, row.provider]), status: state,
                         date: printed(row.date) ?? "")
        case "none_known":
            return Cells(title: "No known allergies", date: row.asserted.map { "as of \(printed($0))" } ?? "")
        case "follow_up":
            let date: String = switch row.due {
            case .nextVisit: "at the next visit"
            case .date(let when): printed(when.date)
            case nil: ""
            }
            return Cells(title: row.title ?? "", status: state, date: date)
        case "result":
            return Cells(title: [row.test, row.value, row.unit].compactMap { $0 }.joined(separator: " "),
                         date: printed(row.measured) ?? "")
        case "medicine_use":
            return Cells(title: [row.name, row.strength].compactMap { $0 }.joined(separator: " "),
                         detail: joined([row.amount, row.directions, row.times?.joined(separator: ", ")]),
                         status: state, date: span(row.started, row.ended) ?? "")
        case "visit":
            let title = joined([row.doctor, row.place])
            let date = row.ended.map { "\(printed(row.date) ?? "?") to \(printed($0.date))" } ?? printed(row.date) ?? ""
            return Cells(title: title.isEmpty ? row.reason ?? "Visit" : title,
                         detail: joined([row.reason, row.cited.map { plural($0, "record", "records") + " from it" }]),
                         status: row.setting ?? "", date: date)
        default:
            return Cells(title: row.name ?? row.title ?? "")
        }
    }

    /// The page a row is on: a result on its category's.
    static func page(of row: RecordRow) -> String? {
        if row.kind == "result" { return row.category == "measurement" ? "measurement" : "lab_result" }
        if row.kind == "none_known" { return "allergy" }
        return titles[row.kind] == nil ? nil : row.kind
    }

    /// Where a row opens: on its page, by its id, with its kind when the
    /// page's is another ("No known allergies" on Allergies).
    static func address(of row: RecordRow, person: String) -> String? {
        guard let page = page(of: row) else { return nil }
        return "/people/\(person)/record/\(page)?open=\(row.id)" + (row.kind == page ? "" : "&kind=\(row.kind)")
    }

    /// What a follow-up is about, by the record it names, and what that was
    /// amended to: "TSH 2.1 mIU/L · 12 Aug 2026 · amended to 4.6 mIU/L".
    static func about(_ named: RecordRow, now current: RecordRow) -> String {
        let cells = cells(named)
        let label = [cells.title, cells.date].filter { !$0.isEmpty }.joined(separator: " · ")
        guard current.id != named.id else { return label }
        let value = [current.value, current.unit].compactMap { $0 }.joined(separator: " ")
        return "\(label) · amended to \(value.isEmpty ? Words.cells(current).title : value)"
    }

    /// A field's value in a change, as a person reads it.
    static func value(_ value: JSONValue?) -> String {
        switch value {
        case nil, .null: "not known"
        case .object(let fields):
            if case .string(let date)? = fields["date"] {
                printed(date)
            } else if fields["kind"] != nil {
                "another record"
            } else {
                fields.keys.sorted().joined(separator: ", ")
            }
        case .string("next_visit"): "the next visit"
        case .string(let words): words
        case .bool(let yes): yes ? "yes" : "no"
        case .number(let number): number.rounded() == number ? String(Int(number)) : String(number)
        case .array(let items): items.map { Self.value($0) }.joined(separator: ", ")
        }
    }

    /// One save in a row's history: "Added, from a document".
    static func change(_ change: RecordChange) -> String {
        let action = actions[change.action] ?? change.action
        guard change.action == "add" else { return action }
        return action + (change.fromMessage ? ", from your message" : change.fromVisit ? ", from a visit" : ", from a document")
    }

    // MARK: Overview

    /// What a tile says under its title, from what the core counted.
    static func tileLines(_ tile: Tile) -> [String] {
        if let noneKnown = tile.noneKnown {
            return ["None known" + (noneKnown.isEmpty ? "" : " (as of \(printed(noneKnown)))")]
                + (tile.count > 0 ? ["\(tile.count) inactive"] : [])
        }
        let names = tile.names.joined(separator: ", ")
        let named = names.isEmpty ? "" : ": \(names)"
        let latest = tile.latest
        let latestLine = latest.map { latest in
            ["Latest: \(latest.label)", latest.date.map(printed)].compactMap { $0 }.joined(separator: " · ")
        }
        switch tile.kind {
        case "measurement", "visit", "symptom", "care_event":
            return latestLine.map { [$0] } ?? []
        case "lab_result":
            guard let latest else { return [] }
            return [["Latest: \(latest.label)", latest.date.map(printed), latest.results.map { plural($0, "result", "results") }]
                .compactMap { $0 }.joined(separator: " · ")]
                + ((latest.flagged ?? 0) > 0 ? ["\(latest.flagged ?? 0) with a lab note"] : [])
        case "medicine_use":
            let now = tile.now ?? 0
            return ["\(now) taking now\(named)"] + (tile.count > now ? ["\(tile.count - now) in history"] : [])
        case "condition":
            return ["\(tile.now ?? 0) ongoing\(named)"]
        case "allergy":
            return ["\(tile.now ?? 0) active\(named)"]
        default:
            return []
        }
    }

    /// A page gets its tile when it has something in it; "none known" is something.
    static func hasTile(_ tile: Tile) -> Bool {
        tile.count > 0 || tile.noneKnown != nil
    }

    /// A document waiting in Needs you: what's left to do with it.
    static func waiting(_ document: Overview.Waiting) -> String {
        switch document.state {
        case "failed": return "couldn't finish reading"
        case "unread_pages": return "couldn't be read · try a clearer scan"
        default:
            return ["\(plural(document.results, "result", "results")) read, not saved",
                    document.toCheck > 0 ? "\(document.toCheck) to check" : nil]
                .compactMap { $0 }.joined(separator: " · ")
        }
    }

    /// A follow-up in Needs you: "overdue, was due Feb 2020".
    static func need(_ need: Overview.Need, now: Date, calendar: Calendar = .current) -> String {
        let words = whenDue(need.state, need.followUp.due, now: now, calendar: calendar)
            .replacingOccurrences(of: " · ", with: ", ")
        return (need.state == "coming_up" ? "coming up, " : "") + words.prefix(1).lowercased() + words.dropFirst()
    }

    /// A receipt's first line as plain words, and how many more.
    static func summary(_ receipt: String) -> String {
        let plain = { (line: String) -> String in
            var words = line.hasPrefix("- ") ? String(line.dropFirst(2)) : line
            words = words.replacing(/\\(.)|\*/) { String($0.output.1 ?? "") }
            return words
        }
        let lines = receipt.split(separator: "\n").map(String.init)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && plain($0) != "Saved" }
        guard let first = lines.first else { return "Saved" }
        if !first.hasPrefix("- ") || lines.count == 1 { return plain(first) }
        return "\(plain(first)) · and \(lines.count - 1) more"
    }

    // MARK: Follow-ups

    /// When a follow-up is due, from where it stands: "Overdue · was due
    /// Sep 2026", "Due this month", "Due today at 16:00", "Due 3 Nov 2026".
    static func whenDue(_ group: String, _ due: Due?, now: Date, calendar: Calendar = .current) -> String {
        guard let due else { return "No date" }
        guard case .date(let when) = due else { return "At the next visit" }
        let date = when.date
        switch group {
        case "overdue": return "Overdue · was due \(dueDate(date, now: now, calendar: calendar))"
        case "due":
            if date.count == 4 { return "Due this year" }
            if date.count == 7 { return "Due this month" }
            return "Due \(dueDate(date, now: now, calendar: calendar))"
        case "done", "dropped": return "Was due \(dueDate(date, now: now, calendar: calendar))"
        default: return date.count == 4 ? "Due in \(date)" : "Due \(dueDate(date, now: now, calendar: calendar))"
        }
    }

    /// A due with today and tomorrow as words.
    static func dueDate(_ date: String, now: Date, calendar: Calendar = .current) -> String {
        let time = date.firstMatch(of: /T(\d{2}:\d{2})$/).map { String($0.1) }
        let day = String(date.prefix(10))
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        let named = day == dayOf(now, calendar) ? "today" : day == dayOf(tomorrow, calendar) ? "tomorrow" : printed(day)
        return time.map { "\(named) at \($0)" } ?? named
    }

    private static func dayOf(_ at: Date, _ calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: at)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    static func plural(_ count: Int, _ one: String, _ many: String) -> String {
        "\(count) \(count == 1 ? one : many)"
    }
}

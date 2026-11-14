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

    /// A record's date as a time on a chart: the start of its period, in
    /// this iPhone's time zone, as the Mac's charts place it ("2025-03" at
    /// 1 March 2025, 00:00). Its numbers are always Gregorian: the phone's
    /// own calendar, Buddhist or any other, gives only its time zone. Nil
    /// for other words.
    static func placed(_ value: String, calendar phone: Calendar = .current) -> Date? {
        let calendar = Calendar.phone(in: phone.timeZone)
        let pattern = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}))?)?)?$/
        guard let match = value.wholeMatch(of: pattern) else { return nil }
        let part = { (digits: Substring?, start: Int) in digits.flatMap { Int($0) } ?? start }
        let month = part(match.2, 1)
        guard (1...12).contains(month) else { return nil }
        return calendar.date(from: DateComponents(year: Int(match.1), month: month, day: part(match.3, 1),
                                                  hour: part(match.4, 0), minute: part(match.5, 0)))
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
                         detail: row.range ?? "", status: joined([row.flag, row.context]),
                         date: printed(row.measured) ?? "")
        case "test":
            return Cells(title: row.name ?? "", detail: joined([row.section, row.unit]))
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
        if row.kind == "visit" { return "/people/\(person)/visits/\(row.id)" }
        if row.kind == "follow_up" { return "/people/\(person)/follow-ups?open=\(row.id)" }
        if row.kind == "test" { return "/people/\(person)/tests/\(row.id)" }
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

    // MARK: Results

    /// A result's value as printed: "6.8 %".
    static func value(of row: RecordRow) -> String {
        [row.value, row.unit].compactMap { $0 }.joined(separator: " ")
    }

    /// A result's value in its test's unit, when that isn't what was
    /// printed: "= 97 µmol/L".
    static func converted(_ row: RecordRow, unit: String?) -> String? {
        guard let first = row.test_number,
              first != row.number || row.test_second_number != row.second_number else { return nil }
        let numbers = [first, row.test_second_number].compactMap { $0 }.map(number).joined(separator: "/")
        return "= " + [(row.comparator ?? "") + numbers, unit].compactMap { $0 }.joined(separator: " ")
    }

    /// A day of measurements: "20 Sep 2026" and "2 measurements".
    static func day(_ group: RecordGroup) -> (name: String, detail: String) {
        (group.date.map(printed) ?? "No date", plural(group.rows.rows.count, "measurement", "measurements"))
    }

    /// A measurement's own date, only where its day's doesn't say it: on the
    /// same day only its time.
    static func measured(_ row: RecordRow, on day: String?) -> String {
        guard let measured = row.measured?.date, measured != day else { return "" }
        if let day, measured.hasPrefix(day + "T") { return String(measured.dropFirst(11)) }
        return printed(measured)
    }

    /// "Measured 12 Aug 2026 · entered in Rufi at 09:01 on 13 Aug 2026".
    static func entered(_ row: RecordRow, at entered: String?) -> String {
        [row.measured.map { "Measured \(printed($0.date))" }, entered.map { "entered in Rufi \(time($0))" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private static func number(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(value)
    }

    // MARK: Medicines

    /// "until 6 Nov, 08:00"; this year's year left out.
    static func until(_ until: Dated?, now: Date, calendar: Calendar = .current) -> String? {
        guard let until else { return nil }
        let parts = until.date.split(separator: "T", maxSplits: 1).map(String.init)
        let printed = printed(parts[0]).replacingOccurrences(of: " \(calendar.component(.year, from: now))", with: "")
        return "until \(printed)" + (parts.count > 1 ? ", \(parts[1])" : "")
    }

    /// A day of the Mac's ('YYYY-MM-DD') as Today's heading says it: "Sunday 8 November".
    static func day(of day: String) -> String {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        guard let at = try? Date(day + "T12:00:00Z", strategy: .iso8601) else { return day }
        return today(at, calendar: utc)
    }

    /// The day `count` days before `day`, both 'YYYY-MM-DD'.
    static func days(before day: String, _ count: Int) -> String? {
        guard let at = try? Date(day + "T12:00:00Z", strategy: .iso8601) else { return nil }
        return String(at.addingTimeInterval(TimeInterval(-count * 86_400)).ISO8601Format().prefix(10))
    }

    /// A log waiting on the iPhone: "Taken 08:12", "Skipped", "Undone".
    static func unsent(_ log: UnsentLog, calendar: Calendar = .current) -> String {
        switch log.state {
        case .taken: log.takenAt.map { "Taken \(clock($0, calendar: calendar))" } ?? "Taken"
        case .skipped: "Skipped"
        case .cleared: "Undone"
        }
    }

    /// Where a dose was logged: "Mac", "iPhone" or "Rufi AI".
    static func loggedWhere(_ by: String) -> String {
        by == "mac" ? "Mac" : by == "rufi_ai" ? "Rufi AI" : by.hasPrefix("app:") ? "iPhone" : by
    }

    /// An instant's local time: "21:02".
    static func clock(_ iso: String, calendar: Calendar = .current) -> String {
        guard let at = instant(iso) else { return iso }
        return clock(calendar.dateComponents([.hour, .minute], from: at))
    }

    /// A dose logged, on Today: "Taken 08:12 · iPhone", "Skipped · Mac".
    static func logged(_ logged: DoseLogged, calendar: Calendar = .current) -> String {
        let what = logged.state == "skipped" ? "Skipped" : logged.takenAt.map { "Taken \(clock($0, calendar: calendar))" } ?? "Taken"
        return "\(what) · \(loggedWhere(logged.by))"
    }

    /// One log in a medicine's doses: "08:00 taken 08:12 (iPhone, arrived 19:02)".
    static func dose(_ log: Doses.Log, calendar: Calendar = .current) -> String {
        let what = switch log.state {
        case "taken": log.takenAt.map { "taken \(clock($0, calendar: calendar))" } ?? "taken"
        case "skipped": "skipped"
        case "cleared": "undone"
        default: log.state
        }
        let place = log.by == "rufi_ai" ? "told Rufi AI" : loggedWhere(log.by)
        var late = ""
        if let logged = instant(log.loggedAt), let received = instant(log.receivedAt),
           received.timeIntervalSince(logged) >= 5 * 60 {
            late = ", arrived \(clock(log.receivedAt, calendar: calendar))"
        }
        return "\(log.doseAt.dropFirst(11)) \(what) (\(place)\(late))"
    }

    /// A day of doses: "Today", "Yesterday", "Wed 4 Nov", with its year when
    /// it isn't this one. `day` and `today` are 'YYYY-MM-DD'.
    static func doseDay(_ day: String, today: String) -> String {
        let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        guard let at = try? Date(day + "T00:00:00Z", strategy: .iso8601),
              let now = try? Date(today + "T00:00:00Z", strategy: .iso8601) else { return day }
        if day == today { return "Today" }
        if utc.date(byAdding: .day, value: -1, to: now) == at { return "Yesterday" }
        let parts = utc.dateComponents([.year, .month, .day, .weekday], from: at)
        let words = "\(weekdays[(parts.weekday ?? 1) - 1]) \(parts.day ?? 0) \(months[(parts.month ?? 1) - 1])"
        return day.prefix(4) == today.prefix(4) ? words : "\(words) \(parts.year ?? 0)"
    }

    // MARK: Visits

    /// Rufi's or a doctor's Markdown as lines: bold and italics kept, a
    /// list's lines with their bullet. Until the chat brings a Markdown view.
    static func markdown(_ text: String) -> AttributedString {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.hasPrefix("- ") ? "• " + $0.dropFirst(2) : String($0) }
            .joined(separator: "\n")
        return (try? AttributedString(markdown: lines, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(lines)
    }

    /// A visit's setting and date: "clinic · 5 Oct 2026".
    static func visitWhen(_ row: RecordRow) -> String {
        joined([row.setting, cells(row).date])
    }

    /// What a record is, by its kind: "Lab result", "Medicine".
    static func noun(_ row: RecordRow) -> String {
        if row.kind == "result" { return row.category == "measurement" ? "Measurement" : "Lab result" }
        return [
            "test": "Test", "medicine_use": "Medicine", "visit": "Visit", "condition": "Condition",
            "allergy": "Allergy", "symptom": "Symptom", "care_event": "Care event", "none_known": "Statement",
            "follow_up": "Follow-up", "profile": "Profile",
        ][row.kind] ?? "Record"
    }

    private static func joined(_ parts: [String?]) -> String {
        parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
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

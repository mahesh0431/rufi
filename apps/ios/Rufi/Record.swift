import Foundation

// What the record's routes answer, as the iPhone reads them: the shapes of
// packages/contracts/src/record.ts, only the fields the native screens show.
// A row is one bag of optional fields, read by its kind, so a kind or a
// field this build doesn't know never stops a page; a literal set (a status,
// a certainty) is kept as the words it came as. The routes' real answers are
// in RufiTests/Fixtures (`pnpm ios:fixtures`).

/// A date at the precision known ("2026", "2026-05", "2026-05-20",
/// "2026-05-20T08:30"), with the words it was said or printed in.
nonisolated struct Dated: Decodable, Equatable, Sendable {
    let date: String
    let words: String?
}

/// When a follow-up is due: a date, or at the next visit.
nonisolated enum Due: Decodable, Equatable, Sendable {
    case date(Dated)
    case nextVisit

    init(from decoder: any Decoder) throws {
        if let words = try? decoder.singleValueContainer().decode(String.self), words == "next_visit" {
            self = .nextVisit
        } else {
            self = .date(try Dated(from: decoder))
        }
    }
}

/// One stored record as the screens show it, or a row that doesn't fit its
/// shape (`problem`).
nonisolated struct RecordRow: Decodable, Equatable, Identifiable, Sendable {
    struct About: Decodable, Equatable, Sendable {
        let kind: String
        let id: String
    }

    let kind: String
    let id: String
    /// Why the row can't be shown; only on a row that doesn't fit.
    var problem: String?

    // Conditions, symptoms, care events.
    var name: String?
    var status: String?
    var certainty: String?
    var recognised: Dated?
    var resolved: Dated?
    var onset: Dated?
    var ended: Dated?
    var severity: String?
    var location: String?
    var details: String?
    var type: String?
    var date: Dated?
    var provider: String?
    // Allergies and "none known".
    var substance: String?
    var reaction: String?
    var reacted: Dated?
    var asserted: String?
    // Follow-ups.
    var title: String?
    var due: Due?
    var outcome: String?
    var about: About?
    // A result, as a follow-up names what it is about.
    var test: String?
    var value: String?
    var unit: String?
    var category: String?
    var measured: Dated?
    var replaces: String?
    // A visit and a medicine, as a follow-up names what it is about.
    var doctor: String?
    var place: String?
    var reason: String?
    var setting: String?
    var cited: Int?
    var strength: String?
    var amount: String?
    var directions: String?
    var times: [String]?
    var started: Dated?

    /// A row that couldn't be read at all, as one that doesn't fit.
    static func unreadable(_ problem: String) -> RecordRow {
        RecordRow(kind: "", id: UUID().uuidString, problem: problem)
    }
}

/// A list of rows where one that can't be read doesn't stop the others.
nonisolated struct Rows: Decodable, Equatable, Sendable {
    let rows: [RecordRow]

    init(from decoder: any Decoder) throws {
        var list = try decoder.unkeyedContainer()
        var rows: [RecordRow] = []
        while !list.isAtEnd {
            if let row = try? list.decode(RecordRow.self) {
                rows.append(row)
            } else {
                _ = try? list.decode(Skipped.self)
                rows.append(.unreadable("This row can't be read."))
            }
        }
        self.rows = rows
    }

    private struct Skipped: Decodable {}
}

/// A page's group: a row, a report, a day.
nonisolated struct RecordGroup: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let type: String
    let date: String?
    let issuer: String?
    let rows: Rows
}

/// A page of a kind's groups, newest first; `next` reads on.
nonisolated struct RecordPage: Decodable, Equatable, Sendable {
    let groups: [RecordGroup]
    let next: String?
}

/// Where a record came from.
nonisolated struct RecordSource: Decodable, Equatable, Sendable {
    let type: String
    // A document's page.
    let document: String?
    let page: Int?
    let file: String?
    let deleted: Bool?
    // The person's message.
    let text: String?
    let at: String?
    // A visit.
    let visit: String?
    let label: String?
    let removed: Bool?
}

/// One change a save made to a record.
nonisolated struct RecordChange: Decodable, Equatable, Sendable {
    struct Field: Decodable, Equatable, Sendable {
        let field: String
        let before: JSONValue?
        let after: JSONValue?
    }

    let save: String
    let at: String
    let action: String
    let fields: [Field]
    let fromMessage: Bool
    let fromVisit: Bool
}

/// A row opened: its sources and its history.
nonisolated struct RecordDetail: Decodable, Equatable, Sendable {
    let row: RecordRow
    let removed: Bool
    let sources: [RecordSource]
    let history: [RecordChange]
    /// The result amended since: the one that replaces it.
    var replacedBy: RecordRow?
}

/// A page's tile on Overview.
nonisolated struct Tile: Decodable, Equatable, Sendable {
    struct Latest: Decodable, Equatable, Sendable {
        let label: String
        let date: String?
        let results: Int?
        let flagged: Int?
    }

    let kind: String
    let count: Int
    let now: Int?
    let names: [String]
    let latest: Latest?
    let noneKnown: String?
}

/// A person's Overview: what needs them, their record as tiles, the latest saves.
nonisolated struct Overview: Decodable, Equatable, Sendable {
    struct Waiting: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let name: String
        let state: String
        let results: Int
        let toCheck: Int
    }

    struct Need: Decodable, Equatable, Sendable {
        let state: String
        let followUp: RecordRow
    }

    struct NeedsYou: Decodable, Equatable, Sendable {
        let documents: [Waiting]
        let followUps: [Need]
    }

    struct Change: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let at: String
        let receipt: String
    }

    let person: String
    let needsYou: NeedsYou
    let tiles: [Tile]
    let recent: [Change]
    let openFollowUps: Int
}

/// The person's follow-ups in the page's groups, in its order.
nonisolated struct FollowUps: Decodable, Equatable, Sendable {
    struct Group: Decodable, Equatable, Sendable {
        let group: String
        let rows: Rows
    }

    let groups: [Group]
}

/// Any JSON value, as a history's before and after keep it.
nonisolated indirect enum JSONValue: Decodable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() {
            self = .null
        } else if let bool = try? value.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? value.decode(Double.self) {
            self = .number(number)
        } else if let string = try? value.decode(String.self) {
            self = .string(string)
        } else if let array = try? value.decode([JSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try value.decode([String: JSONValue].self))
        }
    }
}

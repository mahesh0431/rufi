import Foundation
import Testing
@testable import Rufi

/// The iPhone's own pages read what the Mac's routes answer (the fixtures,
/// written by the server's ios-fixtures test from a fictional record) and
/// say it in the Mac's words.
struct RecordTests {
    /// A fixture as the route answered it.
    private func read<Answer: Decodable>(_ name: String, as: Answer.Type = Answer.self) throws -> Answer {
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/\(name).json")
        return try JSONDecoder().decode(Answer.self, from: Data(contentsOf: file))
    }

    /// The fixtures' days in a fixed zone, so the words don't move with the Mac.
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        return calendar
    }()

    @Test func overviewSaysWhatNeedsAshaAndHerRecordAsTheMacDoes() throws {
        struct Read: Decodable { let overview: Overview }
        let overview = try read("overview", as: Read.self).overview
        let now = try Date("2026-11-07T18:00:00Z", strategy: .iso8601)

        let need = try #require(overview.needsYou.followUps.first)
        #expect(Words.need(need, now: now, calendar: calendar) == "overdue, was due Feb 2020")

        let tiles = Dictionary(uniqueKeysWithValues: overview.tiles.map { ($0.kind, $0) })
        #expect(Words.tileLines(try #require(tiles["lab_result"]))
            == ["Latest: Sunrise Labs · 1 Sep 2026 · 2 results", "1 with a lab note"])
        #expect(Words.tileLines(try #require(tiles["medicine_use"])) == ["2 taking now: Creatine 5 g, Metformin 500 mg"])
        #expect(Words.tileLines(try #require(tiles["condition"])) == ["2 ongoing: Thyroid trouble, Type 2 diabetes"])
        // "None known" is something: Allergies has its tile; Visits has nothing.
        #expect(Words.tileLines(try #require(tiles["allergy"])) == ["None known (as of 10 Oct 2026)", "1 inactive"])
        #expect(overview.tiles.filter { !Words.hasTile($0) }.map(\.kind) == ["visit"])

        let latest = try #require(overview.recent.first)
        #expect(Words.summary(latest.receipt) == "Changed condition Type 2 diabetes: status ongoing")
        #expect(Words.savedAt(latest.at, now: now, calendar: calendar) == "12:30 on 3 Oct 2026")
    }

    @Test func aConditionsRowsSayTheirStatusAndOneThatDoesntFitStaysAsCantShow() throws {
        let rows = try read("record-condition", as: RecordPage.self).groups.flatMap(\.rows.rows)
        let diabetes = try #require(rows.first { $0.id == "cond-a1" })
        #expect(Words.cells(diabetes) == Words.Cells(title: "Type 2 diabetes", detail: "diagnosed",
                                                    status: "Ongoing", date: "Mar 2024"))
        // "13/2025" isn't a date: the Mac says why, the page shows the others.
        #expect(rows.first { $0.id == "cond-a3" }?.problem != nil)
        #expect(rows.count == 3)

        let headache = try #require(read("record-symptom", as: RecordPage.self).groups.first?.rows.rows.first)
        #expect(Words.cells(headache) == Words.Cells(title: "Headache", detail: "mild · forehead",
                                                    status: "Ongoing", date: "since 28 Oct 2026"))
        let flu = try #require(read("record-care_event", as: RecordPage.self).groups.first?.rows.rows.first)
        #expect(Words.cells(flu).detail == "immunisation · Lakeview Family Clinic")
        let allergies = try read("record-allergy", as: RecordPage.self).groups.flatMap(\.rows.rows)
        #expect(allergies.map { Words.cells($0) } == [
            Words.Cells(title: "No known allergies", date: "as of 10 Oct 2026"),
            Words.Cells(title: "Penicillin", detail: "rash", status: "Inactive", date: "2019"),
        ])
    }

    @Test func everyRowTheRoutesAnswerIsReadableWithItsWords() throws {
        // A field renamed or retyped on the Mac turns a row unreadable or
        // blank here: only the one stored row that doesn't fit may be.
        for page in ["record-condition", "record-allergy", "record-symptom", "record-care_event"] {
            for row in try read(page, as: RecordPage.self).groups.flatMap(\.rows.rows) where row.id != "cond-a3" {
                #expect(row.problem == nil && !Words.cells(row).title.isEmpty, "\(page): \(row.id)")
            }
        }
    }

    @Test func noKnownAllergiesOpensOnAllergiesAsTheStatementItIs() throws {
        let statement = try #require(read("record-allergy", as: RecordPage.self).groups.first?.rows.rows.first)
        let address = try #require(Words.address(of: statement, person: "asha"))
        #expect(address == "/people/asha/record/allergy?open=nk-a1&kind=none_known")
        #expect(NativePage.of(address, person: "asha") == .row(kind: "none_known", id: "nk-a1"))
        #expect(try read("detail-none_known", as: RecordDetail.self).row.asserted == "2026-10-10")
    }

    @Test func aFollowUpAboutAnAmendedResultSaysWhatItWasAmendedToAndOpensTheCurrentOne() throws {
        // The lab amended TSH 2.1 to 4.6: the follow-up names the first.
        let named = try read("detail-result-amended", as: RecordDetail.self)
        #expect(named.replacedBy?.id == "res-a5")
        let current = try read("detail-result-current", as: RecordDetail.self)
        #expect(current.replacedBy == nil)
        #expect(Words.about(named.row, now: current.row) == "TSH 2.1 mIU/L · 12 Aug 2026 · amended to 4.6 mIU/L")
        #expect(Words.address(of: current.row, person: "asha") == "/people/asha/record/lab_result?open=res-a5&kind=result")
    }

    @Test func aRowOpenedSaysWhereItCameFromAndEverySave() throws {
        let detail = try read("detail-condition", as: RecordDetail.self)
        let source = try #require(detail.sources.first)
        #expect(source.type == "document" && source.file == "Sunrise Labs August.pdf" && source.page == 1)
        #expect(detail.history.map(Words.change) == ["Added, from a document", "Changed"])
        let field = try #require(detail.history.last?.fields.first)
        #expect("\(field.field) \(Words.value(field.before)) → \(Words.value(field.after))" == "status unknown → ongoing")
        #expect(Words.time(detail.history[0].at, calendar: calendar) == "at 11:00 on 2 Oct 2026")
    }

    @Test func followUpsComeInTheMacsGroupsWithWhenEachIsDue() throws {
        let groups = try read("follow-ups", as: FollowUps.self).groups
        let now = try Date("2026-11-07T18:00:00Z", strategy: .iso8601)
        #expect(groups.map(\.group) == ["overdue", "later", "next_visit", "done"])
        let due = groups.flatMap { group in
            group.rows.rows.map { Words.whenDue(group.group, $0.due, now: now, calendar: calendar) }
        }
        #expect(due == ["Overdue · was due Feb 2020", "Due Mar 2099", "Due Jun 2099", "At the next visit", "Was due 1 Oct 2026"])
        #expect(groups.last?.rows.rows.first?.outcome == "Done at Sunrise Labs")
    }

    @Test func aRowThatCantBeReadDoesntStopTheOthers() throws {
        let page = try JSONDecoder().decode(RecordPage.self, from: Data("""
        {"groups": [{"id": "g", "type": "row", "rows": [
          {"kind": "condition"},
          {"kind": "condition", "id": "cond-1", "name": "Asthma", "status": "ongoing"}
        ]}], "next": null}
        """.utf8))
        let rows = page.groups[0].rows.rows
        #expect(rows.count == 2)
        #expect(rows[0].problem != nil)
        #expect(Words.cells(rows[1]).title == "Asthma")
    }

    @Test func datesAreAtTheirOwnPrecisionAndTodaysAndTomorrowsDuesSaySo() {
        #expect(Words.printed("2026-08-12") == "12 Aug 2026")
        #expect(Words.printed("2026-08") == "Aug 2026")
        #expect(Words.printed("2026") == "2026")
        #expect(Words.printed("2026-05-20T08:30") == "20 May 2026 08:30")
        #expect(Words.printed("next week") == "next week")
        let now = Date(timeIntervalSince1970: 1_794_074_400) // 7 Nov 2026, 18:00 in London
        #expect(Words.dueDate("2026-11-07T16:00", now: now, calendar: calendar) == "today at 16:00")
        #expect(Words.dueDate("2026-11-08", now: now, calendar: calendar) == "tomorrow")
        #expect(Words.summary("**Saved**\n\n- Added Metformin\n- Added Creatine") == "Added Metformin · and 1 more")
    }
}

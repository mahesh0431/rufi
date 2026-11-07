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
        // "None known" is something: Allergies has its tile.
        #expect(Words.tileLines(try #require(tiles["allergy"])) == ["None known (as of 10 Oct 2026)", "1 inactive"])
        #expect(overview.tiles.allSatisfy(Words.hasTile))

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
        for page in ["record-condition", "record-allergy", "record-symptom", "record-care_event",
                     "record-measurement", "record-medicine_use", "record-visit"] {
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

    @Test func labResultsAndATestsPageSayEachValueAsPrinted() throws {
        let sections = try read("lab-results", as: LabResults.self).sections
        #expect(sections.map(\.section) == ["Inflammation", "Sugar", "Thyroid", "Vitamins", nil])
        let tsh = try #require(sections.flatMap(\.tests).first { $0.test.id == "tst-tsh" })
        // The amended value is the latest; its first, 2.1, is no longer current.
        #expect(Words.value(of: tsh.latest) == "4.6 mIU/L" && tsh.latest.replaces == "res-a4" && tsh.count == 1)
        #expect(Words.cells(tsh.latest).status == "High")

        let page = try read("test-tsh", as: TestPage.self)
        let value = try #require(page.values.first)
        #expect(value.report?.issuer == "Sunrise Labs")
        #expect(Words.converted(value.row, unit: page.test.unit) == nil)
        #expect(Words.address(of: value.row, person: "asha") == "/people/asha/record/lab_result?open=res-a5&kind=result")
        #expect(try read("detail-test-tsh", as: RecordDetail.self).row.name == "TSH")
    }

    @Test func measurementsComeByDayAndARowSaysItsDateOnlyWhereItsDayDoesnt() throws {
        let day = try #require(read("record-measurement", as: RecordPage.self).groups.first)
        #expect(Words.day(day) == ("20 Sep 2026", "2 measurements"))
        let pressure = try #require(day.rows.rows.first)
        #expect(Words.value(of: pressure) == "128/84 mmHg")
        #expect(Words.measured(pressure, on: day.date) == "")
        #expect(Words.measured(pressure, on: "2026-09") == "20 Sep 2026")
    }

    @Test func aMedicinesTimingAndItsDosesAsTheMacSaysThem() throws {
        let metformin = try read("detail-medicine", as: RecordDetail.self).row
        #expect(metformin.times == ["08:00", "20:00"] && metformin.remind == true && metformin.until == nil)
        #expect(Words.cells(metformin) == Words.Cells(title: "Metformin 500 mg", detail: "1 tablet · twice a day · 08:00, 20:00",
                                                      status: "Taking now", date: "since Mar 2024"))
        // The doses' times are the phone's: these were logged in India.
        var india = Calendar(identifier: .gregorian)
        india.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        let doses = try read("doses", as: Doses.self).doses
        #expect(doses.map { Words.dose($0, calendar: india) } == [
            "08:00 taken 08:12 (iPhone)",
            "20:00 skipped (Mac)",
            "08:00 taken 08:05 (iPhone, arrived 19:02)",
            "20:00 taken 20:15 (told Rufi AI)",
            "20:00 undone (Mac)",
        ])
        #expect(Words.doseDay("2026-10-06", today: "2026-10-07") == "Yesterday")
        #expect(Words.doseDay("2026-10-05", today: "2026-10-07") == "Mon 5 Oct")
        #expect(Words.doseDay("2025-12-31", today: "2026-01-02") == "Wed 31 Dec 2025")
        #expect(Words.days(before: "2026-10-14", 13) == "2026-10-01")
        // Today read on the Mac's 8 Nov is over at its midnight, not the iPhone's.
        let today = Today(day: "2026-11-08", zone: "Asia/Kolkata", doses: [], upcoming: false)
        #expect(!today.isOver(at: try Date("2026-11-08T18:29:00Z", strategy: .iso8601)))
        #expect(today.isOver(at: try Date("2026-11-08T18:31:00Z", strategy: .iso8601)))
        let logged = DoseLogged(state: "taken", takenAt: doses[0].takenAt, loggedAt: doses[0].loggedAt, by: doses[0].by)
        #expect(Words.logged(logged, calendar: india) == "Taken 08:12 · iPhone")
    }

    @Test func aVisitsPageSaysWhenAndWhereAndWhatWasSavedFromIt() throws {
        let detail = try read("detail-visit", as: RecordDetail.self)
        #expect(Words.cells(detail.row).title == "Dr A. Fictional · Lakeview Family Clinic")
        #expect(Words.visitWhen(detail.row) == "clinic · 5 Oct 2026")
        #expect(detail.row.as_written?.hasPrefix("**Diabetes review**") == true)
        let saved = try #require(detail.fromVisit?.rows.first)
        #expect(Words.noun(saved) == "Care event" && Words.cells(saved).title == "Flu vaccine")
        #expect(Words.address(of: detail.row, person: "asha") == "/people/asha/visits/vis-a1")
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

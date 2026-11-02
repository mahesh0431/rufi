import Foundation
import Testing
@testable import Rufi

/// From the Mac's plan to the notices iOS rings: one per time, at the local
/// time wherever the phone is, saying as much as the person chose.
struct NoticesTests {
    static let india = Calendar.phone(in: TimeZone(identifier: "Asia/Kolkata")!)
    /// 2 Nov 2026, 13:10 in India.
    static let now = india.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 13, minute: 10))!

    static let amoxicillin = ReminderPlan.Medicine(id: "mu-amox", name: "Amoxicillin", strength: "500 mg", amount: "1 capsule")
    static let metformin = ReminderPlan.Medicine(id: "mu-met", name: "Metformin", strength: "500 mg", amount: "1 tablet")
    static let creatine = ReminderPlan.Medicine(id: "mu-cre", name: "Creatine", strength: nil, amount: nil)

    static func plan(_ show: ReminderPlan.Show, ring: ReminderPlan.Ring = .iphone,
                     _ doses: [ReminderPlan.Dose]) -> ReminderPlan {
        ReminderPlan(show: show, ring: ring, doses: doses)
    }

    static let evening = [
        ReminderPlan.Dose(at: "2026-11-02T08:00", medicines: [amoxicillin, metformin], logged: []),
        ReminderPlan.Dose(at: "2026-11-02T21:00", medicines: [amoxicillin, metformin], logged: []),
    ]

    @Test func oneNoticePerTimeWithEveryMedicineDueThenAndTimesAlreadyPastLeftOut() {
        let notices = Notices.of(Self.plan(.count, Self.evening), now: Self.now, calendar: Self.india)

        #expect(notices.map(\.id) == ["dose:2026-11-02T21:00"])
        #expect(notices.first?.medicines == ["mu-amox", "mu-met"])
    }

    @Test func theTriggerIsTheLocalDateAndTimeWithNoTimeZone() throws {
        let notice = try #require(Notices.of(Self.plan(.count, Self.evening), now: Self.now, calendar: Self.india).first)

        #expect(notice.at.year == 2026 && notice.at.month == 11 && notice.at.day == 2)
        #expect(notice.at.hour == 21 && notice.at.minute == 0)
        #expect(notice.at.timeZone == nil && notice.at.calendar == nil)
    }

    @Test(arguments: [
        (ReminderPlan.Show.time, "Medicines at 21:00", ""),
        (.count, "2 medicines at 21:00", ""),
        (.names, "21:00 · 2 medicines", "Amoxicillin 500 mg · 1 capsule\nMetformin 500 mg · 1 tablet"),
    ])
    func theTextIsAsMuchAsThePersonChose(show: ReminderPlan.Show, title: String, body: String) throws {
        let notice = try #require(Notices.of(Self.plan(show, Self.evening), now: Self.now, calendar: Self.india).first)

        #expect(notice.title == title)
        #expect(notice.body == body)
    }

    @Test func oneMedicineIsSaidSoAndANameWithoutStrengthOrAmountStandsAlone() throws {
        let doses = [ReminderPlan.Dose(at: "2026-11-02T21:00", medicines: [Self.creatine], logged: [])]

        let count = try #require(Notices.of(Self.plan(.count, doses), now: Self.now, calendar: Self.india).first)
        let names = try #require(Notices.of(Self.plan(.names, doses), now: Self.now, calendar: Self.india).first)

        #expect(count.title == "1 medicine at 21:00")
        #expect(names.title == "21:00 · 1 medicine")
        #expect(names.body == "Creatine")
    }

    @Test func aMedicineLoggedAlreadyIsLeftOutAndATimeAllLoggedRingsNot() {
        let doses = [
            ReminderPlan.Dose(at: "2026-11-02T21:00", medicines: [Self.amoxicillin, Self.metformin], logged: ["mu-amox"]),
            ReminderPlan.Dose(at: "2026-11-03T08:00", medicines: [Self.amoxicillin], logged: ["mu-amox"]),
        ]

        let notices = Notices.of(Self.plan(.names, doses), now: Self.now, calendar: Self.india)

        #expect(notices.map(\.id) == ["dose:2026-11-02T21:00"])
        #expect(notices.first?.title == "21:00 · 1 medicine")
        #expect(notices.first?.medicines == ["mu-met"])
    }

    @Test func onlyTheSoonest59TimesWhateverHowManyMedicines() {
        // A week of every hour, from 14:00 today.
        let doses = (0..<7 * 24).map { hour -> ReminderPlan.Dose in
            let at = Self.india.date(byAdding: .hour, value: 14 + hour, to: Self.india.startOfDay(for: Self.now))!
            return ReminderPlan.Dose(at: Notices.stamp(at, calendar: Self.india),
                                     medicines: [Self.amoxicillin, Self.metformin, Self.creatine], logged: [])
        }

        let notices = Notices.of(Self.plan(.count, doses), now: Self.now, calendar: Self.india)

        #expect(notices.count == 59)
        #expect(notices.first?.id == "dose:2026-11-02T14:00")
        #expect(notices.last?.id == "dose:2026-11-05T00:00")
    }

    @Test func remindersRingingOnTheMacOnlyMakeNoNotices() {
        #expect(Notices.of(Self.plan(.count, ring: .mac, Self.evening), now: Self.now, calendar: Self.india).isEmpty)
        #expect(!Notices.of(Self.plan(.count, ring: .both, Self.evening), now: Self.now, calendar: Self.india).isEmpty)
    }

    @Test func theRenewalRingsAMinuteAfterTheLastTime() throws {
        let last = try #require(Notices.of(Self.plan(.count, Self.evening), now: Self.now, calendar: Self.india).last)

        let renewal = Notices.renewal(after: last, calendar: Self.india)

        #expect(renewal.id == "renewal")
        #expect(renewal.title == "Open Rufi to keep your reminders coming")
        #expect(renewal.at.day == 2 && renewal.at.hour == 21 && renewal.at.minute == 1)
    }

    @Test func thePlanIsAskedFromYesterdayInThePhonesOwnTimeZone() {
        // 01:00 on 2 Nov in India: yesterday is 1 Nov there, 31 Oct in UTC.
        let early = Self.india.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 1))!

        #expect(Notices.firstDay(now: early, calendar: Self.india) == "2026-11-01")
    }
}

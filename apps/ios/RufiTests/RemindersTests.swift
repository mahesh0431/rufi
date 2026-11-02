import Foundation
import Testing
@testable import Rufi

/// A refresh asks the Mac for the plan and brings iOS's notices in line with
/// it by id, never clearing them first; an unpaired iPhone keeps none.
struct RemindersTests {
    typealias Dose = ReminderPlan.Dose
    static let calendar = NoticesTests.india
    static let now = NoticesTests.now
    static let amoxicillin = NoticesTests.amoxicillin
    static let metformin = NoticesTests.metformin

    /// iOS's notification center, as the app sees it.
    final class StandInCenter: NoticeCenter {
        var pending: [String: Notice] = [:]
        var delivered: [Notice] = []
        var added: [String] = []
        /// Ids iOS refuses to schedule.
        var refuses: Set<String> = []

        func add(_ notice: Notice) async throws {
            if refuses.contains(notice.id) { throw CocoaError(.featureUnsupported) }
            added.append(notice.id)
            pending[notice.id] = notice
        }

        func pendingIDs() async -> [String] { Array(pending.keys) }
        func removePending(_ ids: [String]) { for id in ids { pending[id] = nil } }
        func deliveredNotices() async -> [Notice] { delivered }
        func removeDelivered(_ ids: [String]) { delivered.removeAll { ids.contains($0.id) } }
    }

    static func reminders(_ center: StandInCenter, doses: [Dose], ring: ReminderPlan.Ring = .iphone,
                          unpaired: @escaping () -> Void = {}) -> Reminders {
        Reminders(center: center, calendar: calendar, now: { now },
                  plan: { _ throws(Door.Problem) in ReminderPlan(show: .count, ring: ring, doses: doses) },
                  unpaired: unpaired)
    }

    static func notice(_ at: String, _ medicines: [String] = ["mu-amox"]) -> Notice {
        Notice(id: "dose:\(at)", title: "", body: "", at: DateComponents(), medicines: medicines)
    }

    @Test func keepsTheSameIdsRemovesWhatTheMacNoLongerPlansAndMovesTheRenewal() async {
        let center = StandInCenter()
        for at in ["2026-11-02T21:00", "2026-11-03T13:00"] { center.pending["dose:\(at)"] = Self.notice(at) }
        center.pending["renewal"] = Self.notice("renewal")
        let reminders = Self.reminders(center, doses: [
            Dose(at: "2026-11-02T21:00", medicines: [Self.amoxicillin], logged: []),
            Dose(at: "2026-11-03T08:00", medicines: [Self.amoxicillin], logged: []),
        ])

        await reminders.refresh()

        #expect(Set(center.pending.keys) == ["dose:2026-11-02T21:00", "dose:2026-11-03T08:00", "renewal"])
        #expect(center.pending["renewal"]?.at.hour == 8 && center.pending["renewal"]?.at.minute == 1)
        #expect(reminders.until == Self.calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 8)))
    }

    @Test func setUntilIsTheLastTimeIOSAcceptedAndTheRenewalRingsAfterIt() async {
        let center = StandInCenter()
        center.refuses = ["dose:2026-11-03T08:00"]
        let reminders = Self.reminders(center, doses: [
            Dose(at: "2026-11-02T21:00", medicines: [Self.amoxicillin], logged: []),
            Dose(at: "2026-11-03T08:00", medicines: [Self.amoxicillin], logged: []),
            Dose(at: "2026-11-03T21:00", medicines: [Self.amoxicillin], logged: []),
        ])

        await reminders.refresh()

        #expect(Set(center.pending.keys) == ["dose:2026-11-02T21:00", "renewal"])
        #expect(center.pending["renewal"]?.at.day == 2 && center.pending["renewal"]?.at.minute == 1)
        #expect(reminders.until == Self.calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 21)))
    }

    @Test func aDeliveredNoticeGoesOnceAllItsMedicinesAreLoggedAndTheRenewalOnceRufiOpened() async {
        let center = StandInCenter()
        center.delivered = [
            Self.notice("2026-11-02T08:00", ["mu-amox", "mu-met"]),
            Self.notice("2026-11-02T13:00", ["mu-met"]),
            Notice(id: "renewal", title: "", body: "", at: DateComponents(), medicines: []),
        ]
        let reminders = Self.reminders(center, doses: [
            Dose(at: "2026-11-02T08:00", medicines: [Self.amoxicillin, Self.metformin], logged: ["mu-amox", "mu-met"]),
            Dose(at: "2026-11-02T13:00", medicines: [Self.metformin], logged: []),
        ])

        await reminders.refresh()

        #expect(center.delivered.map(\.id) == ["dose:2026-11-02T13:00"])
    }

    @Test func ringingOnTheMacRemovesThePhonesDoseNotices() async {
        let center = StandInCenter()
        center.pending["dose:2026-11-02T21:00"] = Self.notice("2026-11-02T21:00")
        center.pending["renewal"] = Self.notice("renewal")
        let reminders = Self.reminders(center, doses: [
            Dose(at: "2026-11-02T21:00", medicines: [Self.amoxicillin], logged: []),
        ], ring: .mac)

        await reminders.refresh()

        #expect(center.pending.isEmpty)
        #expect(reminders.until == nil)
    }

    @Test func theMacSayingUnpairedRemovesEveryPendingAndDeliveredNotice() async {
        let center = StandInCenter()
        center.pending["dose:2026-11-02T21:00"] = Self.notice("2026-11-02T21:00")
        center.delivered = [Self.notice("2026-11-02T08:00")]
        var told = false
        let reminders = Reminders(center: center, calendar: Self.calendar, now: { Self.now }) { _ throws(Door.Problem) in
            throw .unpaired
        } unpaired: { told = true }

        await reminders.refresh()

        #expect(center.pending.isEmpty && center.delivered.isEmpty)
        #expect(told)
    }

    @Test func theMacOutOfReachLeavesTheNoticesAsTheyAre() async {
        let center = StandInCenter()
        center.pending["dose:2026-11-02T21:00"] = Self.notice("2026-11-02T21:00")
        let reminders = Reminders(center: center, calendar: Self.calendar, now: { Self.now }) { _ throws(Door.Problem) in
            throw .unreachable
        } unpaired: {}

        await reminders.refresh()

        #expect(Array(center.pending.keys) == ["dose:2026-11-02T21:00"])
        #expect(reminders.until == Self.calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 21)))
    }
}

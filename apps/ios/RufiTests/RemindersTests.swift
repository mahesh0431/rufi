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

    /// iOS's notification center, as the app sees it: it keeps at most 64.
    final class StandInCenter: NoticeCenter {
        var pending: [String: Notice] = [:]
        var delivered: [Notice] = []
        var added: [String] = []
        /// Ids iOS refuses to schedule.
        var refuses: Set<String> = []
        /// Holds the next add until opened, then lets it finish.
        var gate: Gate?
        /// Runs as delivered notices are removed.
        var removing: (([String]) -> Void)?

        func add(_ notice: Notice) async throws {
            if let held = gate {
                gate = nil
                await held.hold()
            }
            if refuses.contains(notice.id) || (pending[notice.id] == nil && pending.count >= 64) {
                throw CocoaError(.featureUnsupported)
            }
            added.append(notice.id)
            pending[notice.id] = notice
        }

        func pendingIDs() async -> [String] { Array(pending.keys) }
        func removePending(_ ids: [String]) { for id in ids { pending[id] = nil } }
        func deliveredNotices() async -> [Notice] { delivered }
        func removeDelivered(_ ids: [String]) {
            removing?(ids)
            delivered.removeAll { ids.contains($0.id) }
        }
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

    /// 59 hourly doses from 14:00 today, at `minute` past each hour.
    static func full(at minute: Int) -> [Dose] {
        (0..<59).map { hour in
            let at = calendar.date(byAdding: .minute, value: (14 + hour) * 60 + minute, to: calendar.startOfDay(for: now))!
            return Dose(at: Notices.stamp(at, calendar: calendar), medicines: [amoxicillin], logged: [])
        }
    }

    @Test func aFullPlanWhoseTimesAllMoveStaysWithinIOSsLimitAndKeepsItsRenewal() async {
        let center = StandInCenter()
        await Self.reminders(center, doses: Self.full(at: 0)).refresh()
        #expect(center.pending.count == 60)

        let moved = Self.reminders(center, doses: Self.full(at: 30))
        await moved.refresh()

        #expect(Set(center.pending.keys) == Set(Self.full(at: 30).map { "dose:\($0.at)" } + ["renewal"]))
        #expect(center.pending["renewal"]?.at.day == 5 && center.pending["renewal"]?.at.minute == 31)
        #expect(moved.until == Self.calendar.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 0, minute: 30)))
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

    @Test func aDeliveredNoticeStaysOnlyWhileAMedicineInItIsStillDueThenAndNotLogged() async {
        let center = StandInCenter()
        center.delivered = [
            Self.notice("2026-11-02T08:00", ["mu-amox", "mu-met"]),
            // One of its medicines stopped since: the other is still due.
            Self.notice("2026-11-02T13:00", ["mu-met", "mu-cre"]),
            // Older than the plan, and a time the plan no longer has.
            Self.notice("2026-10-31T21:00"),
            Self.notice("2026-11-02T10:00", ["mu-cre"]),
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

    /// Holds the Mac's answer until opened.
    final class Gate {
        private var held: CheckedContinuation<Void, Never>?
        private var arrival: CheckedContinuation<Void, Never>?

        /// The add is under way: it waits here.
        func hold() async {
            await withCheckedContinuation { held in
                self.held = held
                arrival?.resume()
                arrival = nil
            }
        }

        /// Until the add is under way.
        func asked() async {
            if held != nil { return }
            await withCheckedContinuation { arrival = $0 }
        }

        func open() {
            held?.resume()
            held = nil
        }
    }

    @Test func unpairingWhileARefreshIsAddingLeavesNothingOnceTheAddFinishes() async {
        let center = StandInCenter()
        center.pending["dose:2026-11-02T21:00"] = Self.notice("2026-11-02T21:00")
        let gate = Gate()
        center.gate = gate
        let reminders = Self.reminders(center, doses: [
            Dose(at: "2026-11-02T21:00", medicines: [Self.amoxicillin], logged: []),
            Dose(at: "2026-11-03T08:00", medicines: [Self.amoxicillin], logged: []),
        ])
        let refreshing = Task { await reminders.refresh() }
        await gate.asked()

        let stopping = Task { await reminders.stop() }
        // The stop has begun before the add already sent finishes.
        await Task.yield()
        gate.open()
        await stopping.value
        await refreshing.value

        #expect(center.pending.isEmpty && center.delivered.isEmpty)
        await reminders.refresh()
        #expect(center.pending.isEmpty)
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

    @Test func takenOnANoticeWritesItsWholeGroupToTheOutboxBeforeTheNoticeGoes() throws {
        let center = StandInCenter()
        let notice = Self.notice("2026-11-02T21:00", ["mu-amox", "mu-met"])
        center.delivered = [notice]
        let file = OutboxTests.file()
        let outbox = Outbox(file: file)
        var kept: [UnsentLog] = []
        center.removing = { _ in kept = Outbox(file: file).logs }

        try Self.reminders(center, doses: []).log(.taken, notice: notice.id,
            medicines: [.init(id: "mu-amox", label: "Amoxicillin 500 mg"), .init(id: "mu-met", label: "Metformin 500 mg")],
            pairing: OutboxTests.pairing, into: outbox)

        #expect(kept.map(\.medicine) == ["mu-amox", "mu-met"])
        #expect(kept.allSatisfy { $0.doseAt == "2026-11-02T21:00" && $0.state == .taken && $0.made == .init(OutboxTests.pairing) })
        #expect(Set(kept.map(\.id)).count == 2)
        // 13:10 in India, as the Mac takes an instant.
        #expect(kept.first?.loggedAt == "2026-11-02T07:40:00.000Z")
        // Taken when tapped, so the Mac shows the time.
        #expect(kept.allSatisfy { $0.takenAt == "2026-11-02T07:40:00.000Z" })
        #expect(center.delivered.isEmpty)
    }
}

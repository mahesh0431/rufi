import Foundation
import UserNotifications

/// The Mac's reminder plan (`GET P/reminders/plan`): the doses with
/// reminders on, by local time, each with the medicines already logged.
nonisolated struct ReminderPlan: Decodable, Equatable, Sendable {
    /// What a notice says: the time, how many, or which ones.
    enum Show: String, Codable, Sendable { case time, count, names }
    /// Where the person's reminders ring.
    enum Ring: String, Codable, Sendable { case iphone, mac, both }

    struct Medicine: Decodable, Equatable, Sendable {
        let id: String
        let name: String
        let strength: String?
        let amount: String?
    }

    struct Dose: Decodable, Equatable, Sendable {
        /// The local date and time, 'YYYY-MM-DDTHH:MM'.
        let at: String
        let medicines: [Medicine]
        /// The medicines whose dose at this time is logged already.
        let logged: [String]
    }

    let show: Show
    let ring: Ring
    let doses: [Dose]
}

/// One notice Rufi asks iOS to ring: a dose time with its medicines, or the
/// renewal. Its id is stable, so a refresh replaces it rather than adding
/// another.
nonisolated struct Notice: Equatable, Sendable {
    let id: String
    let title: String
    let body: String
    /// The local date and time, with no time zone: 08:00 rings at 08:00
    /// wherever the phone is.
    let at: DateComponents
    /// The medicines it reminds of; none for the renewal.
    let medicines: [String]
    /// How each is named in a log: "Amoxicillin 500 mg".
    var labels: [String] = []
}

extension Calendar {
    /// The phone's own days and times: Gregorian, in `zone`.
    nonisolated static func phone(in zone: TimeZone = .current) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
}

/// From the plan to notices, as iOS will ring them.
nonisolated enum Notices {
    /// iOS keeps at most 64 of an app's notices: the soonest 59 times, and
    /// the renewal.
    static let times = 59
    static let renewal = "renewal"
    static let dose = "dose:"
    /// Days the plan covers, from yesterday: a notice delivered yesterday
    /// and logged since goes too.
    static let days = 8

    /// The dose notices to ring after `now`, soonest first.
    static func of(_ plan: ReminderPlan, now: Date, calendar: Calendar) -> [Notice] {
        guard plan.ring != .mac else { return [] }
        let due = plan.doses.compactMap { dose -> (Date, Notice)? in
            let medicines = dose.medicines.filter { !dose.logged.contains($0.id) }
            guard !medicines.isEmpty, let at = components(dose.at),
                  let date = calendar.date(from: at), date > now
            else { return nil }
            let time = String(dose.at.suffix(5))
            let what = "\(medicines.count) \(medicines.count == 1 ? "medicine" : "medicines")"
            let (title, body) = switch plan.show {
            case .time: ("Medicines at \(time)", "")
            case .count: ("\(what) at \(time)", "")
            case .names: ("\(time) · \(what)", medicines.map(label).joined(separator: "\n"))
            }
            return (date, Notice(id: Self.dose + dose.at, title: title, body: body, at: at,
                                 medicines: medicines.map(\.id),
                                 labels: medicines.map { [$0.name, $0.strength].compactMap(\.self).joined(separator: " ") }))
        }
        return due.sorted { $0.0 < $1.0 }.prefix(times).map(\.1)
    }

    /// The renewal, a minute after `last`: before the first dose not set.
    static func renewal(after last: Notice, calendar: Calendar) -> Notice {
        let then = calendar.date(from: last.at).map { $0.addingTimeInterval(60) } ?? .now
        return Notice(id: renewal, title: "Open Rufi to keep your reminders coming", body: "",
                      at: calendar.dateComponents([.year, .month, .day, .hour, .minute], from: then),
                      medicines: [])
    }

    /// The first day the plan is asked for: yesterday, on the phone.
    static func firstDay(now: Date, calendar: Calendar) -> String {
        String(stamp(calendar.date(byAdding: .day, value: -1, to: now) ?? now, calendar: calendar).prefix(10))
    }

    /// 'YYYY-MM-DDTHH:MM' for `date` on the phone.
    static func stamp(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(format: "%04d-%02d-%02dT%02d:%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }

    /// When a dose notice rings, from its id.
    static func date(of id: String, calendar: Calendar) -> Date? {
        guard id.hasPrefix(dose), let at = components(String(id.dropFirst(dose.count))) else { return nil }
        return calendar.date(from: at)
    }

    /// "Amoxicillin 500 mg · 1 capsule", as Today names it.
    private static func label(_ medicine: ReminderPlan.Medicine) -> String {
        [[medicine.name, medicine.strength].compactMap(\.self).joined(separator: " "), medicine.amount]
            .compactMap(\.self).joined(separator: " · ")
    }

    /// 'YYYY-MM-DDTHH:MM' as date components with no calendar or time zone.
    private static func components(_ at: String) -> DateComponents? {
        let parts = at.split(whereSeparator: { "-T:".contains($0) }).compactMap { Int($0) }
        guard parts.count == 5 else { return nil }
        return DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4])
    }
}

/// iOS's notification center, as Rufi uses it.
protocol NoticeCenter {
    /// Schedules `notice`, replacing a pending one with its id.
    func add(_ notice: Notice) async throws
    func pendingIDs() async -> [String]
    func removePending(_ ids: [String])
    /// Notices in Notification Center: their ids and medicines.
    func deliveredNotices() async -> [Notice]
    func removeDelivered(_ ids: [String])
}

/// Rufi's reminders on this iPhone: the Mac's plan, rung as Rufi's own
/// notices. A refresh asks for the plan in the phone's own calendar, then
/// adds or replaces each notice by its id, and only then removes the ones
/// the plan no longer has, so nothing is ever cleared first. One refresh at
/// a time; one asked meanwhile runs after it. Stopped (unpaired), nothing
/// more is added: the refresh in flight ends at its next step, and only then
/// is every notice removed.
@Observable
final class Reminders {
    /// The background refresh's task (Info.plist).
    static let task = "com.maheshpalavalli.rufi.refresh"

    /// The last dose time set on this iPhone; none when nothing is.
    private(set) var until: Date?
    /// Where the person's reminders ring, as the Mac last said.
    private(set) var ring: ReminderPlan.Ring?

    private let center: any NoticeCenter
    private let calendar: Calendar?
    private let now: () -> Date
    private let plan: (String) async throws(Door.Problem) -> ReminderPlan
    private let unpaired: () -> Void
    /// The refresh in flight, joined by a stop.
    private var running: Task<Void, Never>?
    private var again = false
    /// Unpaired: this pairing's reminders are over for good.
    private var stopped = false
    /// The Mac said this iPhone is unpaired, during the refresh.
    private var refused = false

    /// `plan` asks the Mac for the plan from a day; `unpaired` is told when
    /// the Mac says this iPhone is unpaired.
    init(center: any NoticeCenter = SystemCenter(), calendar: Calendar? = nil, now: @escaping () -> Date = { .now },
         plan: @escaping (String) async throws(Door.Problem) -> ReminderPlan,
         unpaired: @escaping () -> Void) {
        self.center = center
        self.calendar = calendar
        self.now = now
        self.plan = plan
        self.unpaired = unpaired
    }

    /// The phone's calendar now: it moves with the phone's time zone.
    private var phone: Calendar { calendar ?? .phone() }

    /// Brings the notices in line with the Mac's plan.
    func refresh() async {
        guard !stopped else { return }
        if let running {
            again = true
            await running.value
            return
        }
        let task = Task {
            repeat {
                again = false
                await once()
            } while again && !stopped
        }
        running = task
        await task.value
        running = nil
        if refused, !stopped {
            await stop()
            unpaired()
        }
    }

    /// Reads until when reminders are set, from iOS.
    func load() async {
        until = await center.pendingIDs().compactMap { Notices.date(of: $0, calendar: phone) }.max()
    }

    /// Unpaired: nothing more is added, and once the refresh in flight has
    /// ended, every Rufi notice goes, pending and delivered.
    func stop() async {
        stopped = true
        await running?.value
        center.removePending(await center.pendingIDs())
        center.removeDelivered(await center.deliveredNotices().map(\.id))
        until = nil
        ring = nil
    }

    /// A medicine on a notice, as its log names it.
    struct Logging: Equatable, Sendable {
        let id: String
        let label: String
    }

    /// Taken or Skipped on the notice `id`: one log per medicine, the whole
    /// group kept in the outbox before the notice goes. The outbox sends them.
    func log(_ state: UnsentLog.State, notice id: String, medicines: [Logging], pairing: Pairing,
             into outbox: Outbox) throws {
        guard !stopped, id.hasPrefix(Notices.dose), !medicines.isEmpty else { return }
        let at = String(id.dropFirst(Notices.dose.count))
        // As the Mac takes an instant: "2026-11-02T15:32:00.000Z".
        let instant = ISO8601DateFormatter()
        instant.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let loggedAt = instant.string(from: now())
        try outbox.add(medicines.map { medicine in
            UnsentLog(id: UUID().uuidString.lowercased(), made: .init(pairing), medicine: medicine.id,
                      label: medicine.label, doseAt: at, state: state, loggedAt: loggedAt,
                      // Taken when tapped, as on Today.
                      takenAt: state == .taken ? loggedAt : nil)
        })
        center.removeDelivered([id])
    }

    private func once() async {
        let calendar = phone
        let plan: ReminderPlan
        do {
            plan = try await self.plan(Notices.firstDay(now: now(), calendar: calendar))
        } catch .unpaired {
            refused = true
            return
        } catch {
            // The Mac out of reach: what is set keeps ringing.
            await load()
            return
        }
        // Stopped while asking: the answer is the old pairing's.
        guard !stopped else { return }
        ring = plan.ring
        let notices = Notices.of(plan, now: now(), calendar: calendar)
        // What the plan no longer has goes first, so iOS never holds more
        // than the plan's own 60.
        let planned = Set(notices.map(\.id) + [Notices.renewal])
        center.removePending(await center.pendingIDs().filter { !planned.contains($0) })
        var kept: Set<String> = []
        var last: Notice?
        for notice in notices {
            guard !stopped else { return }
            // The first iOS refuses ends what is set: until is the one before.
            do { try await center.add(notice) } catch { break }
            kept.insert(notice.id)
            last = notice
        }
        if let last, !stopped {
            let renewal = Notices.renewal(after: last, calendar: calendar)
            if (try? await center.add(renewal)) != nil { kept.insert(renewal.id) }
        }
        guard !stopped else { return }
        // After a refusal: nothing set beyond it, so the renewal comes first.
        center.removePending(await center.pendingIDs().filter { !kept.contains($0) })
        // Delivered: one stays while a medicine in it is still due then and
        // not logged. Logged, stopped, retimed, older than the plan, or the
        // renewal once Rufi refreshed: it goes. Notification Center isn't the log.
        var due: [String: Set<String>] = [:]
        for dose in plan.doses {
            due[Notices.dose + dose.at, default: []]
                .formUnion(dose.medicines.map(\.id).filter { !dose.logged.contains($0) })
        }
        center.removeDelivered(await center.deliveredNotices().filter { notice in
            due[notice.id].map { $0.isDisjoint(with: notice.medicines) } ?? true
        }.map(\.id))
        await load()
    }
}

/// iOS's own notification center. Every notice is Time Sensitive, in one
/// thread so iOS stacks them; a locked phone with previews hidden shows
/// "Medicine reminder".
struct SystemCenter: NoticeCenter {
    private var center: UNUserNotificationCenter { .current() }

    /// The categories Rufi's notices use; set at launch.
    static func register() {
        // Taken and Skipped need the iPhone unlocked, not Rufi's own lock.
        let actions = [
            UNNotificationAction(identifier: UnsentLog.State.taken.rawValue, title: "Taken",
                                 options: [.authenticationRequired], icon: .init(systemImageName: "checkmark")),
            UNNotificationAction(identifier: UnsentLog.State.skipped.rawValue, title: "Skipped",
                                 options: [.authenticationRequired], icon: .init(systemImageName: "xmark")),
        ]
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "dose", actions: actions, intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: "Medicine reminder", options: []),
        ])
    }

    func add(_ notice: Notice) async throws {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.threadIdentifier = "medicines"
        if notice.id != Notices.renewal { content.categoryIdentifier = "dose" }
        content.interruptionLevel = .timeSensitive
        content.sound = .default
        content.userInfo = ["medicines": notice.medicines, "labels": notice.labels]
        let trigger = UNCalendarNotificationTrigger(dateMatching: notice.at, repeats: false)
        try await center.add(UNNotificationRequest(identifier: notice.id, content: content, trigger: trigger))
    }

    func pendingIDs() async -> [String] {
        await center.pendingNotificationRequests().map(\.identifier)
    }

    func removePending(_ ids: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    func deliveredNotices() async -> [Notice] {
        await center.deliveredNotifications().map { delivered in
            Notice(id: delivered.request.identifier, title: "", body: "", at: DateComponents(),
                   medicines: delivered.request.content.userInfo["medicines"] as? [String] ?? [],
                   labels: delivered.request.content.userInfo["labels"] as? [String] ?? [])
        }
    }

    func removeDelivered(_ ids: [String]) {
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
}

extension Date {
    /// "Thu 5 Nov, 21:00", in the phone's own words.
    var reminderWords: String {
        formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    }
}

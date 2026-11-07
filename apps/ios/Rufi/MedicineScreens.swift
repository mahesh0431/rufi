import SwiftUI

// Medicines' Today, and a medicine's timing and doses, drawn here. A log
// made on Today goes through the outbox a reminder's Taken uses (ADR 0033):
// kept on the iPhone first, sent under its own id, stored once on the Mac.

/// Today on Medicines: each dose today, on the Mac's day, with Taken,
/// Skipped or Undo. A log not on the Mac yet shows Pending.
struct TodaySection: View {
    let shell: Shell
    let today: Today
    /// Reads Today again: a log was made.
    let reread: () async -> Void
    /// Why the last log couldn't be kept, in a few words.
    @State private var problem: String?

    var body: some View {
        if !today.doses.isEmpty || today.upcoming {
            Section {
                if today.doses.isEmpty {
                    Text("Nothing to take today.").foregroundStyle(.secondary)
                }
                ForEach(today.doses, id: \.self.key) { dose in
                    DoseLine(shell: shell, dose: dose, day: today.day) { state in
                        // Past the Mac's midnight, this page is yesterday's: not
                        // logged, so the person taps on today's.
                        if state != .cleared, today.isOver(at: .now) { return await reread() }
                        problem = await shell.log(state, medicine: dose.medicine, doseAt: "\(today.day)T\(dose.at)")
                        await reread()
                    }
                }
            } header: {
                Text("Today · \(Words.day(of: today.day))")
            } footer: {
                if let problem { Text(problem) }
            }
            .listRowBackground(shell.theme.surface)
        }
    }

    /// Reads Today for its page, kept for when the page opens again.
    static func read(_ shell: Shell) async -> Today? {
        let asked = Date.now
        guard let answer: Today = await shell.todayReads.read({ try? await shell.read("today") }) else { return nil }
        shell.outbox.forget(storedBefore: asked)
        shell.kept["today"] = answer
        return answer
    }
}

/// Reads that may overlap, each numbered as it starts: an answer from a
/// read older than one already answered is dropped, so an older Today never
/// replaces a newer one.
final class NewestRead {
    private var started = 0
    private var answered = 0

    func read<Answer>(_ asking: () async -> Answer?) async -> Answer? {
        started += 1
        let this = started
        guard let answer = await asking(), this > answered else { return nil }
        answered = this
        return answer
    }
}

extension Today {
    /// Whether the Mac's day has ended since Today was read.
    func isOver(at now: Date) -> Bool {
        var mac = Calendar(identifier: .gregorian)
        mac.timeZone = TimeZone(identifier: zone) ?? .current
        let at = mac.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", at.year ?? 0, at.month ?? 0, at.day ?? 0) != day
    }
}

extension Today.Dose {
    /// The dose: its medicine and its time today.
    var key: String { "\(medicine.id)@\(at)" }

    /// What Today shows for a dose.
    enum Shown: Equatable {
        /// Waiting on this iPhone.
        case pending(UnsentLog)
        case logged(DoseLogged)
        case open
    }

    /// What Today read on `day` shows for this dose under `pairing`: a log
    /// waiting on this iPhone, else one the Mac stored since Today was read,
    /// else Today's own; and why the Mac refused a log, if it did.
    func shown(day: String, pairing: Pairing, outbox: Outbox) -> (Shown, refused: String?) {
        let this = { (log: UnsentLog) in
            log.made.matches(pairing) && log.medicine == medicine.id && log.doseAt == "\(day)T\(at)"
        }
        let waiting = outbox.logs.last(where: this)
        if let waiting, waiting.refused == nil { return (.pending(waiting), nil) }
        let shown: Shown = if let sent = outbox.stored.last(where: { this($0.log) })?.log {
            sent.state == .cleared ? .open : .logged(DoseLogged(
                state: sent.state.rawValue, takenAt: sent.takenAt, loggedAt: sent.loggedAt, by: "app:\(sent.made.app)"))
        } else {
            logged.map(Shown.logged) ?? .open
        }
        return (shown, waiting?.refused)
    }
}

/// One dose today: its time and medicine, how to take it, and its log.
private struct DoseLine: View {
    let shell: Shell
    let dose: Today.Dose
    let day: String
    let log: (UnsentLog.State) async -> Void
    @State private var sending = false

    var body: some View {
        let medicine = dose.medicine
        let detail = [medicine.amount, medicine.directions, Words.until(medicine.until, now: .now)]
            .compactMap { $0 }.joined(separator: " · ")
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(dose.at).monospacedDigit().fontWeight(.semibold)
                Text([medicine.name, medicine.strength].compactMap { $0 }.joined(separator: " ")).fontWeight(.semibold)
            }
            .accessibilityElement(children: .combine)
            .accessibilityHint(dose.past ? "Earlier today" : "")
            if !detail.isEmpty { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
            state
        }
        .padding(.vertical, 2)
        .foregroundStyle(dose.past ? .secondary : .primary)
        // The separator starts at the row's edge, not at a button's label.
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
    }

    /// Waiting on the iPhone, logged, or not yet.
    @ViewBuilder
    private var state: some View {
        let (shown, refused) = dose.shown(day: day, pairing: shell.pairing, outbox: shell.outbox)
        if let refused { Text(refused).font(.subheadline).foregroundStyle(.secondary) }
        switch shown {
        case let .pending(waiting):
            Text("\(Words.unsent(waiting)) · Pending").font(.subheadline)
        case let .logged(logged):
            HStack {
                Text(Words.logged(logged)).font(.subheadline)
                Spacer()
                action("Undo", "arrow.uturn.backward", .cleared)
            }
        case .open:
            HStack {
                action("Taken", "checkmark", .taken)
                action("Skipped", "forward", .skipped)
            }
        }
    }

    private func action(_ title: String, _ symbol: String, _ state: UnsentLog.State) -> some View {
        Button(title, systemImage: symbol) {
            sending = true
            Task {
                await log(state)
                sending = false
            }
        }
        .buttonStyle(.bordered)
        .disabled(sending)
    }
}

/// An opened medicine's directions and timing.
struct MedicineTiming: View {
    let row: RecordRow
    let now: Date

    var body: some View {
        Section {
            LabeledContent("Directions", value: row.directions ?? "Not known")
            LabeledContent("Times", value: row.times?.joined(separator: ", ") ?? "Not set")
            LabeledContent("Days", value: row.days_words ?? row.days ?? (row.times != nil ? "Every day" : "Not set"))
            LabeledContent("Until", value: Words.until(row.until, now: now).map { String($0.dropFirst(6)) } ?? "No end set")
            LabeledContent("Reminders", value: row.remind == true ? "On" : "Off")
        }
    }
}

/// A medicine's doses in the last 14 days, on the Mac's days: each day's
/// logs as they were logged. A dose with no log has nothing.
struct MedicineDoses: View {
    let doses: Read

    /// The Mac's day, and the medicine's logs in the 14 days to it.
    struct Read: Sendable {
        let day: String
        let doses: Doses
    }

    var body: some View {
        Section("Doses · last 14 days") {
            let days = Dictionary(grouping: doses.doses.doses) { String($0.doseAt.prefix(10)) }
            if days.isEmpty {
                Text("No doses logged in the last 14 days.").foregroundStyle(.secondary)
            }
            ForEach(days.keys.sorted(by: >), id: \.self) { day in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(Words.doseDay(day, today: doses.day)).foregroundStyle(.secondary)
                        .frame(width: 96, alignment: .leading)
                    Text((days[day] ?? []).map { Words.dose($0) }.joined(separator: " · "))
                }
                .font(.subheadline)
            }
        }
    }

    /// Reads a medicine's doses on the Mac's last 14 days, kept for when it opens again.
    static func read(_ shell: Shell, medicine: String) async -> Read? {
        let key = "doses:\(medicine)"
        guard let today: Today = (try? await shell.read("today")) ?? shell.kept["today"] as? Today,
              let from = Words.days(before: today.day, 13),
              let doses: Doses = try? await shell.read(
                "doses", query: ["from": from, "to": today.day, "medicine": medicine]) else {
            return shell.kept[key] as? Read
        }
        let answer = Read(day: today.day, doses: doses)
        shell.kept[key] = answer
        return answer
    }
}

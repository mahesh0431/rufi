import SwiftUI

// Medicines' Today, and a medicine's timing and doses, drawn here. A log
// made on Today goes through the outbox a reminder's Taken uses (ADR 0033):
// kept on the iPhone first, sent under its own id, stored once on the Mac.

/// Today on Medicines: each dose today, on the Mac's day, with Taken,
/// Skipped or Undo. A log not on the Mac yet shows Pending.
struct TodaySection: View {
    let shell: Shell
    @State private var read: Today?
    /// Why the last log couldn't be kept, in a few words.
    @State private var problem: String?

    var body: some View {
        let today = read ?? shell.kept["today"] as? Today
        Group {
            if let today, !today.doses.isEmpty || today.upcoming {
                Section {
                    if today.doses.isEmpty {
                        Text("Nothing to take today.").foregroundStyle(.secondary)
                    }
                    ForEach(today.doses, id: \.self.key) { dose in
                        DoseLine(shell: shell, dose: dose, day: today.day) { state in
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
            } else if today == nil {
                // Its place held while it reads, so the read runs.
                Color.clear.frame(height: 0).listRowBackground(Color.clear)
            }
        }
        .task(id: shell.fresh) { await reread() }
        // A log the outbox sent: the Mac's answer shows.
        .onChange(of: shell.outbox.logs.count) { Task { await reread() } }
    }

    private func reread() async {
        if let answer: Today = try? await shell.read("today") {
            read = answer
            shell.kept["today"] = answer
        }
    }
}

extension Today.Dose {
    /// The dose: its medicine and its time today.
    var key: String { "\(medicine.id)@\(at)" }
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
    }

    /// Waiting on the iPhone, logged, or not yet.
    @ViewBuilder
    private var state: some View {
        let waiting = shell.outbox.logs.last { $0.medicine == dose.medicine.id && $0.doseAt == "\(day)T\(dose.at)" }
        if let waiting, waiting.refused == nil {
            Text("\(Words.unsent(waiting)) · Pending").font(.subheadline)
        } else {
            if let refused = waiting?.refused { Text(refused).font(.subheadline).foregroundStyle(.secondary) }
            if let logged = dose.logged {
                HStack {
                    Text(Words.logged(logged)).font(.subheadline)
                    Spacer()
                    action("Undo", "arrow.uturn.backward", .cleared)
                }
            } else {
                HStack {
                    action("Taken", "checkmark", .taken)
                    action("Skipped", "forward", .skipped)
                }
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
            LabeledContent("Reminders") {
                Label(row.remind == true ? "Reminders on" : "Reminders off",
                      systemImage: row.remind == true ? "bell" : "bell.slash")
            }
        }
    }
}

/// A medicine's doses in the last 14 days, on the Mac's days: each day's
/// logs as they were logged. A dose with no log has nothing.
struct MedicineDoses: View {
    let shell: Shell
    let medicine: RecordRow
    @State private var read: Read?

    struct Read: Sendable {
        let day: String
        let doses: Doses
    }

    private var key: String { "doses:\(medicine.id)" }

    var body: some View {
        let shown = read ?? shell.kept[key] as? Read
        Group {
            if let shown {
                if medicine.times != nil || !shown.doses.doses.isEmpty {
                    Section("Doses · last 14 days") {
                        let days = Dictionary(grouping: shown.doses.doses) { String($0.doseAt.prefix(10)) }
                        if days.isEmpty {
                            Text("No doses logged in the last 14 days.").foregroundStyle(.secondary)
                        }
                        ForEach(days.keys.sorted(by: >), id: \.self) { day in
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(Words.doseDay(day, today: shown.day)).foregroundStyle(.secondary)
                                    .frame(width: 96, alignment: .leading)
                                Text((days[day] ?? []).map { Words.dose($0) }.joined(separator: " · "))
                            }
                            .font(.subheadline)
                        }
                    }
                }
            } else {
                // Its place held while it reads, so the read runs.
                Color.clear.frame(height: 0).listRowBackground(Color.clear)
            }
        }
        .task(id: shell.fresh) {
            guard let today: Today = (try? await shell.read("today")) ?? shell.kept["today"] as? Today,
                  let from = Words.days(before: today.day, 13) else { return }
            if let doses: Doses = try? await shell.read(
                "doses", query: ["from": from, "to": today.day, "medicine": medicine.id]) {
                let answer = Read(day: today.day, doses: doses)
                read = answer
                shell.kept[key] = answer
            }
        }
    }
}

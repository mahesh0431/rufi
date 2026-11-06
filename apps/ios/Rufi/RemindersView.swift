import SwiftUI

/// Reminders, from the bell on Medicines: what a reminder shows and where it
/// rings, the person's own setting on the Mac, the same as its Medicines
/// page. Each choice is kept as it is picked, so there is only Done.
struct RemindersView: View {
    let door: Door
    let person: String
    let reminders: Reminders?
    @Environment(\.dismiss) private var dismiss
    @Environment(Theme.self) private var theme
    @State private var setting: Door.Setting?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    if let setting {
                        Section {
                            Picker("A reminder shows", selection: choice(\.show, setting)) {
                                Choice(name: "Just the time", detail: "“Medicines at 21:00”").tag(ReminderPlan.Show.time)
                                Choice(name: "How many", detail: "“2 medicines at 21:00”").tag(ReminderPlan.Show.count)
                                Choice(name: "Which ones", detail: "“21:00 · 2 medicines”, then each name and amount")
                                    .tag(ReminderPlan.Show.names)
                            }
                            .pickerStyle(.inline)
                            .labelsHidden()
                        } header: {
                            Text("A reminder shows")
                        } footer: {
                            Text("On the Lock Screen, Which ones shows names unless Settings › Notifications › Show Previews is When Unlocked.")
                        }
                        Section {
                            Picker("Where reminders ring", selection: choice(\.ring, setting)) {
                                Choice(name: "iPhone", detail: reminders?.until.map { "Set until \($0.reminderWords)" } ?? "")
                                    .tag(ReminderPlan.Ring.iphone)
                                Choice(name: "Mac", detail: "").tag(ReminderPlan.Ring.mac)
                                Choice(name: "Both", detail: "A backup when the iPhone can't ring").tag(ReminderPlan.Ring.both)
                            }
                            .pickerStyle(.inline)
                            .labelsHidden()
                        } header: {
                            Text("Where reminders ring")
                        } footer: {
                            Text("Which medicines remind you, and when, you change in the chat.")
                        }
                    } else if problem == nil {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    if let problem {
                        Section { Text(problem).foregroundStyle(.red) }
                    }
                }
                .listRowBackground(theme.surface)
            }
            .themed(theme)
            .navigationTitle("Reminders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", systemImage: "checkmark") { dismiss() }
                }
            }
            .task { await read() }
        }
    }

    /// A choice picked: kept on the Mac at once; the reminders follow it.
    private func choice<Value>(_ part: WritableKeyPath<Door.Setting, Value>, _ shown: Door.Setting) -> Binding<Value> {
        Binding {
            shown[keyPath: part]
        } set: { value in
            var picked = shown
            picked[keyPath: part] = value
            setting = picked
            Task { await save(picked, over: shown) }
        }
    }

    private func read() async {
        do {
            setting = try await door.reminders(for: person)
            problem = nil
        } catch {
            problem = words(error)
        }
    }

    private func save(_ picked: Door.Setting, over before: Door.Setting) async {
        do {
            setting = try await door.save(picked, for: person)
            problem = nil
            await reminders?.refresh()
        } catch {
            setting = before
            problem = words(error)
        }
    }

    private func words(_ problem: Door.Problem) -> String {
        switch problem {
        case .unreachable: "Can't reach your Mac. Check Rufi is open there and Tailscale is on, on both."
        case .unpaired: "This iPhone was unpaired on your Mac."
        case let .refused(words): words
        case .codeExpired, .mismatch: "Update Rufi on your iPhone (or on your Mac) so they match."
        }
    }
}

/// A choice with its example line.
private struct Choice: View {
    let name: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
            if !detail.isEmpty {
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}

import SwiftUI
import UserNotifications

/// This iPhone: whose record and which Mac, the lock's switch, whether iOS
/// lets Rufi ring and until when reminders are set, Apple Health, and Unpair.
struct ThisIPhoneView: View {
    let app: AppModel
    let pairing: Pairing
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var unpairing = false
    /// Whether iOS lets Rufi ring: unknown until read.
    @State private var notifications: UNAuthorizationStatus?

    var body: some View {
        @Bindable var lock = app.lock
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Image("Dog").resizable().scaledToFit().frame(width: 52, height: 52).clipShape(.circle)
                        VStack(alignment: .leading) {
                            Text(pairing.person.name).font(.headline)
                            Text("Paired with Rufi on \(pairing.mac)").foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    Toggle("Lock Rufi", isOn: $lock.on)
                        .disabled(!lock.available)
                } footer: {
                    Text(lock.available
                        ? "Face ID, or your passcode, when you open Rufi and after a minute away."
                        : "Set a passcode in Settings › Face ID & Passcode to lock Rufi.")
                }
                Section {
                    LabeledContent("Notifications", value: notifications == nil ? "" : allowed ? "On" : "Off")
                    if notifications == .notDetermined {
                        Button("Turn On Reminders", systemImage: "bell") {
                            Task {
                                await app.allowNotifications()
                                await readNotifications()
                                await app.refresh()
                            }
                        }
                    } else if notifications == .denied,
                              let settings = URL(string: UIApplication.openNotificationSettingsURLString) {
                        Button("Turn On in Settings", systemImage: "gear") { openURL(settings) }
                    }
                    if let until = app.reminders?.until {
                        LabeledContent("Set until", value: until.reminderWords)
                    } else if app.reminders?.ring == .mac {
                        LabeledContent("Reminders ring on", value: "Your Mac")
                    } else {
                        LabeledContent("Set until", value: "Nothing set")
                    }
                    if !app.outbox.logs.isEmpty {
                        NavigationLink {
                            List { UnsentSection(outbox: app.outbox, pairing: pairing) }
                                .navigationTitle("Not on Your Mac Yet")
                                .navigationBarTitleDisplayMode(.inline)
                        } label: {
                            LabeledContent("Not on your Mac yet", value: "\(app.outbox.logs.count)")
                        }
                    }
                } header: {
                    Text("Reminders")
                } footer: {
                    Text("What a reminder shows and where it rings: the bell on Medicines.")
                }
                if let health = app.health {
                    Section {
                        NavigationLink {
                            HealthView(health: health, person: pairing.person.name)
                        } label: {
                            LabeledContent("Apple Health", value: healthWords(health))
                        }
                    }
                }
                Section {
                    Button("Unpair This iPhone", role: .destructive) { unpairing = true }
                        .confirmationDialog("Unpair This iPhone?", isPresented: $unpairing, titleVisibility: .hidden) {
                            Button("Unpair This iPhone", role: .destructive) {
                                Task {
                                    await app.unpair()
                                    dismiss()
                                }
                            }
                        } message: {
                            Text("This iPhone can't open Rufi any more, and its reminders are removed. What it sent stays on your Mac.")
                        }
                } footer: {
                    Text("Rufi isn't a doctor; check with yours before medical decisions. Version \(version).")
                }
            }
            .task { await readNotifications() }
            .navigationTitle("This iPhone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", systemImage: "checkmark") { dismiss() }
                }
            }
        }
    }

    private var allowed: Bool {
        notifications == .authorized || notifications == .provisional || notifications == .ephemeral
    }

    private func readNotifications() async {
        notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// "Sent 09:15", as the last sync went.
    private func healthWords(_ health: HealthSync) -> String {
        if health.running { return "Sending…" }
        guard let last = health.last else { return "" }
        let when = Calendar.current.isDateInToday(last.at)
            ? last.at.formatted(date: .omitted, time: .shortened)
            : last.at.formatted(.dateTime.day().month(.abbreviated))
        return last.batches == 0 ? "Checked \(when)" : "Sent \(when)"
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "") (\(info?["CFBundleVersion"] as? String ?? ""))"
    }
}

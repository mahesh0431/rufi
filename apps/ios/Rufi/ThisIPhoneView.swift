import SwiftUI

/// This iPhone: whose record and which Mac, the lock's switch, and Unpair.
struct ThisIPhoneView: View {
    let app: AppModel
    let pairing: Pairing
    @Environment(\.dismiss) private var dismiss
    @State private var unpairing = false

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
                        .disabled(!Lock.canLock)
                } footer: {
                    Text(Lock.canLock
                        ? "Face ID, or your passcode, when you open Rufi and after a minute away."
                        : "Set a passcode in Settings › Face ID & Passcode to lock Rufi.")
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
                            Text("This iPhone can't open Rufi any more. What it sent stays on your Mac.")
                        }
                } footer: {
                    Text("Rufi isn't a doctor; check with yours before medical decisions. Version \(version).")
                }
            }
            .navigationTitle("This iPhone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", systemImage: "checkmark") { dismiss() }
                }
            }
        }
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "") (\(info?["CFBundleVersion"] as? String ?? ""))"
    }
}

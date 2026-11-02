import SwiftUI
import UIKit
import UserNotifications

/// Where the app is: pairing, the setup after it, Rufi open, or unpaired by
/// the Mac.
@Observable
final class AppModel {
    enum Stage {
        case pairing
        /// Just paired: whose record it opens, then the lock's setup.
        case paired(Pairing)
        case open(Shell)
        /// The Mac unpaired this iPhone.
        case unpaired
    }

    private(set) var stage: Stage = .pairing
    let lock = Lock()
    /// The reminders of the pairing; none while unpaired.
    private(set) var reminders: Reminders?

    init() {
        // A first launch after installing: a key left from before is removed.
        if !UserDefaults.standard.bool(forKey: "installed") {
            Keychain.forget()
            UserDefaults.standard.set(true, forKey: "installed")
        }
        if let pairing = Pairing.saved(), let key = Keychain.key() {
            reminders = newReminders(pairing, key)
            stage = .open(shell(pairing, key))
        }
    }

    /// Pairs with the link's code; the one line to show when it didn't.
    func pair(_ text: String) async -> String? {
        guard let link = PairingLink(text) else {
            return "That isn't a Rufi pairing link. Copy it again from Rufi on your Mac."
        }
        do {
            let paired = try await Door.pair(link, name: UIDevice.current.name)
            guard Keychain.save(paired.key) else { return "Rufi couldn't keep its key on this iPhone. Try again." }
            let pairing = Pairing(origin: link.origin, app: paired.app.id, person: paired.person,
                                  mac: paired.mac, folder: paired.folder)
            pairing.save()
            reminders = newReminders(pairing, paired.key)
            stage = .paired(pairing)
            return nil
        } catch .codeExpired {
            return "This code has expired. Make a new one in Rufi on your Mac."
        } catch .unreachable {
            return "Can't reach your Mac. Check Rufi is open there and Tailscale is on, on both."
        } catch let .refused(words) {
            return words
        } catch {
            return "Update Rufi on your iPhone (or on your Mac) so they match."
        }
    }

    /// After the setup: Rufi opens, and its reminders are set.
    func finishSetup() {
        guard case let .paired(pairing) = stage, let key = Keychain.key() else { return }
        stage = .open(shell(pairing, key))
        Task { await refresh() }
    }

    /// Asks iOS to let Rufi ring reminders, once.
    func allowNotifications() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    /// Brings the reminders in line with the Mac's plan.
    func refresh() async {
        await reminders?.refresh()
    }

    /// A reminder was tapped: Medicines, after the lock.
    func openMedicines() {
        if case let .open(shell) = stage { Task { await shell.show(.medicines) } }
    }

    /// Unpairs here, on the Mac too when it answers; its reminders go.
    func unpair() async {
        if let pairing = Pairing.saved(), let key = Keychain.key() {
            try? await Door(origin: pairing.origin, key: key).unpair()
        }
        await reminders?.clear()
        forget()
        stage = .pairing
    }

    func pairAgain() {
        stage = .pairing
    }

    private func shell(_ pairing: Pairing, _ key: String) -> Shell {
        Shell(pairing: pairing, key: key) { [weak self] in
            Task { await self?.refresh() }
        } unpaired: { [weak self] in
            self?.wasUnpaired()
        }
    }

    private func newReminders(_ pairing: Pairing, _ key: String) -> Reminders {
        let door = Door(origin: pairing.origin, key: key)
        let person = pairing.person.id
        return Reminders { (from: String) async throws(Door.Problem) -> ReminderPlan in
            try await door.plan(for: person, from: from)
        } unpaired: { [weak self] in
            self?.wasUnpaired()
        }
    }

    /// The Mac unpaired this iPhone: its key, pairing and reminders go.
    private func wasUnpaired() {
        let reminders = reminders
        Task { await reminders?.clear() }
        forget()
        stage = .unpaired
    }

    private func forget() {
        Keychain.forget()
        Pairing.forget()
        lock.forget()
        reminders = nil
    }
}

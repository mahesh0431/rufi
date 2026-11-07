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
    let lock: Lock
    /// The Mac's colour theme, as the pages last drew it.
    let theme = Theme()
    /// Dose logs not on the Mac yet; kept through unpairing.
    let outbox: Outbox
    /// Messages sent while Rufi couldn't be reached; gone on unpairing.
    let pending = Pending()
    /// Apple Health sync for the pairing; none while unpaired.
    private(set) var health: HealthSync?
    /// The reminders of the pairing; none while unpaired.
    private(set) var reminders: Reminders?
    /// The last pairing's reminders being removed and its sync settling: a
    /// new pairing waits for it.
    private var stopping: Task<Void, Never>?
    /// Rufi's scene is active.
    var active = true
    /// Rufi is on screen and unlocked: what it shows can be seen.
    var seen: Bool { active && !lock.locked }

    init(lock: Lock = Lock(), outbox: Outbox = Outbox()) {
        self.lock = lock
        self.outbox = outbox
        // A first launch after installing: a key left from before is removed.
        if !UserDefaults.standard.bool(forKey: "installed") {
            Keychain.forget()
            UserDefaults.standard.set(true, forKey: "installed")
        }
        // Copies of originals left from a Rufi that ended while showing one.
        Originals.shown.deleteAll()
        if let pairing = Pairing.saved(), let key = Keychain.key() {
            reminders = newReminders(pairing, key)
            health = newHealth(pairing, key)
            // Paired, but the lock's offer wasn't answered: it comes again.
            stage = UserDefaults.standard.bool(forKey: "setup.done") ? .open(shell(pairing, key)) : .paired(pairing)
        }
    }

    /// Pairs with the link's code; the one line to show when it didn't.
    func pair(_ text: String) async -> String? {
        await stopping?.value
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
            health = newHealth(pairing, paired.key)
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

    /// After the setup, with the lock and the reminders answered: Rufi
    /// opens, and its reminders are set.
    func finishSetup() {
        guard case let .paired(pairing) = stage, let key = Keychain.key() else { return }
        UserDefaults.standard.set(true, forKey: "setup.done")
        stage = .open(shell(pairing, key))
        Task { await refresh() }
    }

    /// Asks iOS to let Rufi ring reminders, once.
    func allowNotifications() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    /// Sends the dose logs waiting for this pairing, then brings the
    /// reminders in line with the Mac's plan, which lists them as logged.
    func refresh() async {
        await sendUnsent()
        await reminders?.refresh()
    }

    /// Taken or Skipped on a reminder: the group is kept in the outbox, the
    /// notice goes, then the logs are sent and the reminders follow.
    func log(_ state: UnsentLog.State, notice: UNNotification) async {
        guard let pairing = Pairing.saved(), let reminders else { return }
        let info = notice.request.content.userInfo
        let ids = info["medicines"] as? [String] ?? []
        let labels = info["labels"] as? [String] ?? []
        let medicines = ids.enumerated().map { index, id in
            Reminders.Logging(id: id, label: labels.indices.contains(index) ? labels[index] : "A medicine")
        }
        do {
            try reminders.log(state, notice: notice.request.identifier, medicines: medicines, pairing: pairing,
                              into: outbox)
        } catch {
            // The outbox's file couldn't be written: nothing was kept. The
            // dose shows not logged on Today, where it can be logged.
            return
        }
        await refresh()
    }

    /// The logs waiting for this pairing go to the Mac; the rest stay.
    private func sendUnsent() async {
        guard reminders != nil, let pairing = Pairing.saved(), let key = Keychain.key() else { return }
        let door = Door(origin: pairing.origin, key: key)
        do {
            try await outbox.send(to: pairing, door.log)
        } catch {
            // Only `unpaired` comes here: the logs stay, behind the lock.
            wasUnpaired()
        }
    }

    /// A reminder was tapped: Medicines, after the lock.
    func openMedicines() {
        if case let .open(shell) = stage { Task { await shell.show(.medicines) } }
    }

    /// Unpairs here, on the Mac too when it answers; its reminders go. A
    /// sync settles first, so none of its batches meets the unpaired key.
    func unpair() async {
        await health?.end()
        if let pairing = Pairing.saved(), let key = Keychain.key() {
            try? await Door(origin: pairing.origin, key: key).unpair()
        }
        await reminders?.stop()
        forget()
        stage = .pairing
    }

    func pairAgain() {
        stage = .pairing
    }

    private func shell(_ pairing: Pairing, _ key: String) -> Shell {
        Shell(pairing: pairing, key: key, theme: theme, pending: pending, outbox: outbox,
              seen: { [weak self] in self?.seen ?? false }) { [weak self] in
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

    private func newHealth(_ pairing: Pairing, _ key: String) -> HealthSync {
        HealthSync(reader: HealthReader(), door: Door(origin: pairing.origin, key: key),
                   memory: HealthMemory(defaults: .standard, app: pairing.app)) { [weak self] in
            self?.wasUnpaired()
        }
    }

    /// The Mac unpaired this iPhone: its key and pairing go; its reminders
    /// are removed, then its sync settles and its bookmarks go. A new
    /// pairing waits for both.
    private func wasUnpaired() {
        let reminders = reminders
        let health = health
        // Told twice (the reminders and a sync both heard it): after the first.
        let before = stopping
        stopping = Task {
            await before?.value
            await reminders?.stop()
            await health?.end()
        }
        forget()
        stage = .unpaired
    }

    private func forget() {
        Keychain.forget()
        Pairing.forget()
        UserDefaults.standard.removeObject(forKey: "setup.done")
        // Logs still waiting are shown only behind the lock: it stays.
        if outbox.logs.isEmpty { lock.forget() }
        // The chat of the pairing that ends stops first: nothing of it sends after.
        if case let .open(shell) = stage { shell.chat.end() }
        pending.clear()
        reminders = nil
        health = nil
        Task { await Screens.forget() }
    }
}

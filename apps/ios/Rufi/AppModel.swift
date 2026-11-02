import SwiftUI
import UIKit

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

    init() {
        // A first launch after installing: a key left from before is removed.
        if !UserDefaults.standard.bool(forKey: "installed") {
            Keychain.forget()
            UserDefaults.standard.set(true, forKey: "installed")
        }
        if let pairing = Pairing.saved(), let key = Keychain.key() {
            // Paired, but the lock's offer wasn't answered: it comes again.
            stage = UserDefaults.standard.bool(forKey: "setup.done") ? .open(shell(pairing, key)) : .paired(pairing)
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

    /// After the setup, with the lock on or Not Now chosen: Rufi opens.
    func finishSetup() {
        guard case let .paired(pairing) = stage, let key = Keychain.key() else { return }
        UserDefaults.standard.set(true, forKey: "setup.done")
        stage = .open(shell(pairing, key))
    }

    /// Unpairs here, on the Mac too when it answers.
    func unpair() async {
        if let pairing = Pairing.saved(), let key = Keychain.key() {
            try? await Door(origin: pairing.origin, key: key).unpair()
        }
        forget()
        stage = .pairing
    }

    func pairAgain() {
        stage = .pairing
    }

    private func shell(_ pairing: Pairing, _ key: String) -> Shell {
        Shell(pairing: pairing, key: key) { [weak self] in
            self?.forget()
            self?.stage = .unpaired
        }
    }

    private func forget() {
        Keychain.forget()
        Pairing.forget()
        UserDefaults.standard.removeObject(forKey: "setup.done")
        lock.forget()
    }
}

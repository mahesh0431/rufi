import LocalAuthentication
import Observation
import SwiftUI

/// Lock Rufi: Face ID or the iPhone's passcode, as iOS picks, when Rufi
/// opens and after more than a minute away. It gates what is shown; the
/// key stays readable for reminders.
@Observable
final class Lock {
    /// Lock Rufi is on. Set at the setup after pairing; changed on This iPhone.
    var on: Bool {
        didSet { UserDefaults.standard.set(on, forKey: "lock.on") }
    }

    /// Rufi is locked now: only the lock screen shows.
    private(set) var locked = false
    private var away: Date?

    init() {
        on = UserDefaults.standard.bool(forKey: "lock.on")
        locked = on && Self.canLock
    }

    /// The iPhone has a passcode, so Rufi can be locked.
    static var canLock: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// Asks for Face ID or the passcode; unlocked when it was given.
    func unlock() async {
        let context = LAContext()
        let given = (try? await context.evaluatePolicy(
            .deviceOwnerAuthentication, localizedReason: "Open your health record.")) ?? false
        if given { locked = false }
    }

    /// Turns the lock on at the setup: asks once, which also shows iOS's
    /// Face ID permission.
    func turnOn() async {
        let context = LAContext()
        if (try? await context.evaluatePolicy(
            .deviceOwnerAuthentication, localizedReason: "Lock Rufi with Face ID.")) == true {
            on = true
        }
    }

    func left() {
        away = .now
    }

    func cameBack() {
        if on, Self.canLock, let away, Date.now.timeIntervalSince(away) > 60 { locked = true }
        away = nil
    }

    func forget() {
        on = false
        locked = false
    }
}

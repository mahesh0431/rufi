import LocalAuthentication
import Observation
import SwiftUI

/// Lock Rufi: Face ID or the iPhone's passcode, as iOS picks, when Rufi
/// opens and after more than a minute away. Away counts from the first
/// moment Rufi stops being active (the app switcher counts), but not while
/// Rufi itself asks for Face ID. It gates what is shown; the key stays
/// readable for reminders.
@Observable
final class Lock {
    /// How long Rufi may be away before it locks again.
    static let away: TimeInterval = 60

    /// Lock Rufi is on. Set at the setup after pairing; changed on This iPhone.
    var on: Bool {
        didSet { defaults.set(on, forKey: "lock.on") }
    }

    /// Rufi is locked now: only the lock screen shows.
    private(set) var locked = false
    private var left: Date?
    /// Rufi is asking for Face ID or the passcode: iOS's prompt makes it inactive.
    private var asking = false
    private let defaults: UserDefaults
    private let passcode: () -> Bool

    init(defaults: UserDefaults = .standard, passcode: @escaping () -> Bool = Lock.passcodeSet) {
        self.defaults = defaults
        self.passcode = passcode
        on = defaults.bool(forKey: "lock.on")
        locked = on && passcode()
    }

    /// The iPhone has a passcode, so Rufi can be locked.
    var available: Bool { passcode() }

    nonisolated static func passcodeSet() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// Asks for Face ID or the passcode; unlocked when it was given.
    func unlock() async {
        if await ask("Open your health record.") { locked = false }
    }

    /// Turns the lock on at the setup: asks once, which also shows iOS's
    /// Face ID permission. True when it was given and the lock is on.
    func turnOn() async -> Bool {
        if await ask("Lock Rufi with Face ID.") { on = true }
        return on
    }

    /// Rufi's scene changed phase, at `now`.
    func phase(_ phase: ScenePhase, at now: Date = .now) {
        if phase == .active {
            if on, available, let left, now.timeIntervalSince(left) > Self.away { locked = true }
            left = nil
        } else if left == nil, !asking {
            left = now
        }
    }

    func forget() {
        on = false
        locked = false
    }

    /// iOS's prompt is up, or gone: Rufi's own inactive time during it doesn't count.
    func prompting(_ now: Bool) {
        asking = now
    }

    private func ask(_ reason: String) async -> Bool {
        prompting(true)
        defer { prompting(false) }
        let context = LAContext()
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

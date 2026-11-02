import Foundation
import SwiftUI
import Testing
@testable import Rufi

/// Away counts from the first moment Rufi stops being active, the app
/// switcher too, but not while Rufi itself asks for Face ID.
struct LockTests {
    private func lock() -> Lock {
        let lock = Lock(defaults: UserDefaults(suiteName: UUID().uuidString)!, passcode: { true })
        lock.on = true
        return lock
    }

    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func moreThanAMinuteInTheAppSwitcherLocks() {
        let lock = lock()
        lock.phase(.inactive, at: start)
        lock.phase(.active, at: start + 61)
        #expect(lock.locked)
    }

    @Test func awayCountsFromInactiveThroughBackground() {
        let lock = lock()
        lock.phase(.inactive, at: start)
        lock.phase(.background, at: start + 30)
        lock.phase(.active, at: start + 61)
        #expect(lock.locked)
    }

    @Test func lessThanAMinuteDoesntLock() {
        let lock = lock()
        lock.phase(.inactive, at: start)
        lock.phase(.background, at: start + 10)
        lock.phase(.active, at: start + 50)
        #expect(!lock.locked)
    }

    @Test func rufisOwnFaceIDPromptDoesntCount() {
        let lock = lock()
        lock.prompting(true)
        lock.phase(.inactive, at: start)
        lock.phase(.active, at: start + 90)
        lock.prompting(false)
        #expect(!lock.locked)
    }
}

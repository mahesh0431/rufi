import Foundation
import UIKit

/// One page of Apple Health, already the batch to send.
nonisolated struct HealthPage: Sendable {
    /// The envelope, with a new random batch ID.
    let body: Data
    /// Values in it, as the status line counts them.
    let values: Int
    /// Values and deletions; none means nothing new.
    let entries: Int
    /// Apple's bookmark after this page, archived.
    let anchor: Data
    /// The first value's start, to name a value too large to send.
    let firstStart: Date?
}

/// Why Apple Health couldn't be read.
nonisolated enum HealthProblem: Error, Equatable {
    /// The iPhone is locked: iOS refuses Health reads then.
    case locked
    /// Rufi's saved bookmark is one Apple Health can't read.
    case badAnchor
    /// No Apple Health on this device.
    case notAvailable
    case failed
}

/// Reads one anchored page of a type from Apple Health.
nonisolated protocol HealthReading: Sendable {
    func page(_ type: HeartType, from anchor: Data?, limit: Int) async throws(HealthProblem) -> HealthPage
}

/// Sends a batch to Rufi on the Mac; whether it had it already.
nonisolated protocol BatchSending: Sendable {
    func batch(_ body: Data) async throws(Door.Problem) -> Door.Received
}

extension Door: BatchSending {}

/// Each type's Apple Health bookmark and the last sync, for one pairing:
/// a new pairing starts with none.
struct HealthMemory {
    /// The last sync that finished: when, and what it sent.
    struct Last: Codable, Equatable, Sendable {
        let at: Date
        let readings: Int
        let batches: Int
    }

    let defaults: UserDefaults
    /// The paired app the bookmarks belong to.
    let app: String

    func anchor(_ type: HeartType) -> Data? {
        defaults.data(forKey: key(type.rawValue))
    }

    func save(_ anchor: Data, for type: HeartType) {
        defaults.set(anchor, forKey: key(type.rawValue))
    }

    var last: Last? {
        defaults.data(forKey: key("last")).flatMap { try? JSONDecoder().decode(Last.self, from: $0) }
    }

    func save(_ last: Last) {
        defaults.set(try? JSONEncoder().encode(last), forKey: key("last"))
    }

    /// Every bookmark goes: the next sync reads all Apple Health allows.
    func clearAnchors() {
        for type in HeartType.allCases { defaults.removeObject(forKey: key(type.rawValue)) }
    }

    func forget() {
        clearAnchors()
        defaults.removeObject(forKey: key("last"))
    }

    private func key(_ name: String) -> String { "health.\(app).\(name)" }
}

/// Sync: sends what is new in Apple Health to Rufi on the Mac, one page as
/// one batch, type by type. A run holds one pairing from start to end. A
/// type's bookmark moves only after the Mac answers that it has the page;
/// anything else stops the run with the bookmark where it was. Stop and
/// unpairing settle the run before anything else changes.
@Observable
final class HealthSync {
    enum State: Equatable {
        case idle
        case sending(HeartType, readings: Int)
        /// Why the last run stopped, in one line.
        case stopped(String)
    }

    /// The most Rufi on the Mac takes in one batch (`MAX_BATCH_BYTES`).
    nonisolated static let maxBytes = 4 * 1024 * 1024
    /// How many values and deletions a page asks for at first.
    nonisolated static let firstLimit = 1000

    private(set) var state = State.idle
    private(set) var last: HealthMemory.Last?
    var running: Bool { run != nil }

    private let reader: any HealthReading
    private let door: any BatchSending
    private let memory: HealthMemory
    private let unpaired: () -> Void
    private let pause: (Duration) async throws -> Void
    private var run: Task<Void, Never>?
    @ObservationIgnored private var background = UIBackgroundTaskIdentifier.invalid

    init(reader: any HealthReading, door: any BatchSending, memory: HealthMemory,
         unpaired: @escaping () -> Void,
         pause: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.reader = reader
        self.door = door
        self.memory = memory
        self.unpaired = unpaired
        self.pause = pause
        last = memory.last
    }

    /// Starts a run, unless one is running; it ends by itself.
    @discardableResult
    func sync() -> Task<Void, Never> {
        if let run { return run }
        // Leaving Rufi mid-run: iOS gives a little time for the batch in
        // flight; when it runs out, the run stops as Stop does, and the time
        // is handed back at once, as iOS asks.
        background = UIApplication.shared.beginBackgroundTask(withName: "Sync") { [weak self] in
            self?.run?.cancel()
            self?.endBackground()
        }
        UIApplication.shared.isIdleTimerDisabled = true
        let started = Task {
            await sending()
            UIApplication.shared.isIdleTimerDisabled = false
            endBackground()
            run = nil
        }
        run = started
        return started
    }

    private func endBackground() {
        guard background != .invalid else { return }
        UIApplication.shared.endBackgroundTask(background)
        background = .invalid
    }

    /// Stops the run and waits until it has settled: the batch in flight
    /// answered or cancelled, its bookmark saved or not.
    func stop() async {
        guard let run else { return }
        run.cancel()
        await run.value
    }

    /// Read history again: every bookmark goes, the pairing stays, and a
    /// run reads all Apple Health allows. The Mac keeps what it has.
    func readAgain() async {
        await stop()
        memory.clearAnchors()
        sync()
    }

    /// Unpairing: the run settles first, then its bookmarks and last sync go.
    func end() async {
        await stop()
        memory.forget()
        last = nil
        state = .idle
    }

    private func sending() async {
        var readings = 0
        var batches = 0
        state = .sending(HeartType.allCases[0], readings: 0)
        for type in HeartType.allCases {
            var limit = Self.firstLimit
            while true {
                if Task.isCancelled { return finish(readings, batches, stopped: nil) }
                state = .sending(type, readings: readings)
                let page: HealthPage
                do {
                    page = try await reader.page(type, from: memory.anchor(type), limit: limit)
                } catch {
                    return finish(readings, batches, stopped: Task.isCancelled ? nil : Self.words(error))
                }
                if page.entries == 0 { break }
                // Too large: the same page again from the same bookmark, with
                // half the limit. One value too large alone stops the run.
                if page.body.count > Self.maxBytes {
                    if limit == 1 {
                        let from = page.firstStart?.formatted(.dateTime.day().month(.abbreviated).year()) ?? ""
                        return finish(readings, batches, stopped:
                            "A \(type.valueWords) from \(from) is too large for Rufi on your Mac. Sync stopped there.")
                    }
                    limit = max(1, limit / 2)
                    continue
                }
                do {
                    _ = try await send(page.body)
                } catch {
                    if Task.isCancelled { return finish(readings, batches, stopped: nil) }
                    if error == .unpaired { unpaired() }
                    return finish(readings, batches, stopped: Self.words(error))
                }
                memory.save(page.anchor, for: type)
                readings += page.values
                batches += 1
                limit = Self.firstLimit
            }
        }
        finish(readings, batches, stopped: nil)
    }

    /// The same bytes and batch ID, tried twice more when the Mac can't be
    /// reached, after 2 and 5 seconds.
    private func send(_ body: Data) async throws(Door.Problem) -> Door.Received {
        var waits: [Duration] = [.seconds(2), .seconds(5)]
        while true {
            do {
                return try await door.batch(body)
            } catch .unreachable where !waits.isEmpty && !Task.isCancelled {
                do { try await pause(waits.removeFirst()) } catch { throw .unreachable }
            }
        }
    }

    private func finish(_ readings: Int, _ batches: Int, stopped: String?) {
        if let stopped {
            state = .stopped(stopped)
            return
        }
        state = .idle
        // A run stopped part way still counts what it sent.
        if batches > 0 || !Task.isCancelled {
            let done = HealthMemory.Last(at: .now, readings: readings, batches: batches)
            memory.save(done)
            last = done
        }
    }

    private static func words(_ problem: HealthProblem) -> String {
        switch problem {
        case .locked: "Unlock your iPhone to sync."
        case .badAnchor: "Rufi lost its place in Apple Health. Tap Read History Again."
        case .notAvailable: "This iPhone has no Apple Health."
        case .failed: "Apple Health couldn't be read. Try again."
        }
    }

    private static func words(_ problem: Door.Problem) -> String {
        switch problem {
        case .unreachable: "Can't reach your Mac. Check Rufi is open there and Tailscale is on, on both."
        case .unpaired: "This iPhone was unpaired on your Mac. Pair again to sync."
        case let .refused(words): words
        case .codeExpired, .mismatch: "Update Rufi on your iPhone (or on your Mac) so they match."
        }
    }
}

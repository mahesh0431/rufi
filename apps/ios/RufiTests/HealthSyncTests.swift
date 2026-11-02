import Foundation
import Synchronization
import Testing
@testable import Rufi

/// Sync's rules, with Apple Health and the Mac stood in for: a type's
/// bookmark moves only after the Mac has the page; a page too large is read
/// again from the same bookmark with half the limit; Stop and unpairing
/// settle the run before anything else changes.
struct HealthSyncTests {
    let memory = HealthMemory(defaults: UserDefaults(suiteName: "health-\(UUID())")!, app: "app-asha")

    @Test(arguments: [Door.Problem.refused("Rufi on your Mac refused a batch (no_batch_id)."), .unpaired, .mismatch])
    func movesTheBookmarkOnlyWhenTheMacHasThePage(problem: Door.Problem) async {
        let reader = StubReader { type, anchor, _ in
            switch (type, anchor) {
            case (.restingHeartRate, nil): .page("r1", values: 3)
            case (.heartRate, nil): .page("h1", values: 5)
            case (.heartRate, "h1"): .page("h2", values: 5)
            default: .nothingNew
            }
        }
        let door = StubDoor { call throws(Door.Problem) in
            switch call {
            case 1: .gotIt
            case 2: .alreadyGot
            default: throw problem
            }
        }
        var unpaired = false
        let health = HealthSync(reader: reader, door: door, memory: memory, unpaired: { unpaired = true })

        await health.sync().value

        #expect(memory.anchor(.restingHeartRate) == Data("r1".utf8))
        #expect(memory.anchor(.heartRate) == Data("h1".utf8))
        #expect(door.sent.count == 3)
        #expect(health.state.stopped)
        #expect(unpaired == (problem == .unpaired))
    }

    @Test func triesTheSameBatchTwiceMoreWhenTheMacCantBeReached() async {
        let reader = StubReader { type, anchor, _ in
            type == .restingHeartRate && anchor == nil ? .page("r1", values: 3) : .nothingNew
        }
        let door = StubDoor { _ throws(Door.Problem) in throw .unreachable }
        let waited = Mutex<[Duration]>([])
        let health = HealthSync(reader: reader, door: door, memory: memory, unpaired: {},
                                pause: { wait in waited.withLock { $0.append(wait) } })

        await health.sync().value

        #expect(door.sent == Array(repeating: Data("r1".utf8), count: 3))
        #expect(waited.withLock { $0 } == [.seconds(2), .seconds(5)])
        #expect(memory.anchor(.restingHeartRate) == nil)
        #expect(health.state.stopped)
    }

    @Test func readsATooLargePageAgainWithHalfTheLimitAndStopsAtOneValueTooLarge() async {
        let reader = StubReader { type, anchor, limit in
            switch (type, anchor) {
            case (.restingHeartRate, nil): limit > 250 ? .tooLarge : .page("r1", values: 250)
            case (.heartRate, nil): .tooLarge
            default: .nothingNew
            }
        }
        let door = StubDoor { _ throws(Door.Problem) in .gotIt }
        let health = HealthSync(reader: reader, door: door, memory: memory, unpaired: {})

        await health.sync().value

        #expect(reader.asked(.restingHeartRate) == [(nil, 1000), (nil, 500), (nil, 250), ("r1", 1000)].map(Asked.init))
        #expect(reader.asked(.heartRate) == [1000, 500, 250, 125, 62, 31, 15, 7, 3, 1].map { Asked(nil, $0) })
        #expect(door.sent == [Data("r1".utf8)])
        #expect(memory.anchor(.heartRate) == nil)
        #expect(health.state.stopped)
    }

    @Test func stopSettlesTheRunBeforeItReturns() async {
        let (reader, door) = Self.answeredAsStopped()
        let health = HealthSync(reader: reader, door: door, memory: memory, unpaired: {})
        health.sync()
        while door.sent.isEmpty { await Task.yield() }

        await health.stop()

        // The Mac's answer came as Stop was tapped: its page is kept, and
        // nothing more is read or sent.
        #expect(!health.running)
        #expect(memory.anchor(.restingHeartRate) == Data("r1".utf8))
        #expect(reader.asked(.restingHeartRate).count == 1)
        #expect(door.sent.count == 1)
    }

    @Test func unpairingSettlesTheRunThenForgetsItsBookmarks() async {
        let (reader, door) = Self.answeredAsStopped()
        let health = HealthSync(reader: reader, door: door, memory: memory, unpaired: {})
        health.sync()
        while door.sent.isEmpty { await Task.yield() }

        await health.end()

        #expect(!health.running)
        #expect(memory.anchor(.restingHeartRate) == nil)
        #expect(memory.last == nil)
        #expect(door.sent.count == 1)
    }

    /// A door that answers only once the run is stopped, as an answer
    /// arriving just as Stop is tapped.
    private static func answeredAsStopped() -> (StubReader, StubDoor) {
        let reader = StubReader { type, anchor, _ in
            switch (type, anchor) {
            case (.restingHeartRate, nil): .page("r1", values: 3)
            case (.restingHeartRate, "r1"): .page("r2", values: 3)
            default: .nothingNew
            }
        }
        let door = StubDoor { _ throws(Door.Problem) in
            try? await Task.sleep(for: .seconds(60))
            return .gotIt
        }
        return (reader, door)
    }
}

/// One page asked of the stand-in for Apple Health: from which bookmark,
/// with what limit.
nonisolated struct Asked: Equatable {
    let anchor: String?
    let limit: Int
    init(_ anchor: String?, _ limit: Int) {
        self.anchor = anchor
        self.limit = limit
    }
}

extension HealthPage {
    /// A page whose body and new bookmark are both `name`.
    nonisolated static func page(_ name: String, values: Int) -> HealthPage {
        HealthPage(body: Data(name.utf8), values: values, entries: values, anchor: Data(name.utf8), firstStart: nil)
    }

    nonisolated static let nothingNew = HealthPage(body: Data(), values: 0, entries: 0, anchor: Data("end".utf8), firstStart: nil)

    /// Over the 4 MB Rufi on the Mac takes.
    nonisolated static let tooLarge = HealthPage(body: Data(count: HealthSync.maxBytes + 1), values: 1, entries: 1,
                                                 anchor: Data("never".utf8),
                                                 firstStart: Date(timeIntervalSince1970: 1_710_400_000))
}

extension HealthSync.State {
    var stopped: Bool {
        if case .stopped = self { true } else { false }
    }
}

/// Apple Health stood in for: each page from `answer`, each ask recorded.
nonisolated final class StubReader: HealthReading {
    private let answer: @Sendable (HeartType, String?, Int) -> HealthPage
    private let asks = Mutex<[(HeartType, Asked)]>([])

    init(_ answer: @escaping @Sendable (HeartType, String?, Int) -> HealthPage) {
        self.answer = answer
    }

    func asked(_ type: HeartType) -> [Asked] {
        asks.withLock { $0.filter { $0.0 == type }.map(\.1) }
    }

    func page(_ type: HeartType, from anchor: Data?, limit: Int) async throws(HealthProblem) -> HealthPage {
        let name = anchor.map { String(decoding: $0, as: UTF8.self) }
        asks.withLock { $0.append((type, Asked(name, limit))) }
        return answer(type, name, limit)
    }
}

/// The Mac stood in for: the answer to each call, by its number from 1;
/// each body sent recorded.
nonisolated final class StubDoor: BatchSending {
    private let answer: @Sendable (Int) async throws(Door.Problem) -> Door.Received
    private let bodies = Mutex<[Data]>([])

    init(_ answer: @escaping @Sendable (Int) async throws(Door.Problem) -> Door.Received) {
        self.answer = answer
    }

    var sent: [Data] { bodies.withLock { $0 } }

    func batch(_ body: Data) async throws(Door.Problem) -> Door.Received {
        let call = bodies.withLock { $0.append(body); return $0.count }
        return try await answer(call)
    }
}

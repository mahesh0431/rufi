import Foundation
import Testing
@testable import Rufi

/// Dose logs made on the iPhone wait in the outbox, kept in its file, until
/// the Mac acknowledges each; they go only to the person and Mac's folder
/// they were made for.
struct OutboxTests {
    static let mahesh = Door.Person(id: "per-mahesh", name: "Mahesh")
    static let pairing = Pairing(origin: URL(string: "https://mahesh-mbp.tail1234.ts.net:41789")!, app: "app-m1",
                                 person: mahesh, mac: "mahesh-mbp", folder: "fold-1")

    static func file() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "outbox-\(UUID().uuidString)/unsent.json")
    }

    static func log(_ id: String, _ medicine: String = "mu-amox", made pairing: Pairing = pairing,
                    state: UnsentLog.State = .taken) -> UnsentLog {
        UnsentLog(id: id, made: .init(pairing), medicine: medicine, label: "Amoxicillin 500 mg",
                  doseAt: "2026-11-02T21:00", state: state, loggedAt: "2026-11-02T15:32:00.000Z")
    }

    /// The Mac: what it answered, by log id; stored unless said otherwise.
    final class StandInMac {
        var sent: [String] = []
        var answers: [String: Door.Logged] = [:]
        var away = false
        /// Runs while the Mac takes a log, as if something happened meanwhile.
        var meanwhile: (() throws -> Void)?

        func take(_ log: UnsentLog) async throws(Door.Problem) -> Door.Logged {
            if away { throw .unreachable }
            sent.append(log.id)
            if let meanwhile {
                self.meanwhile = nil
                try? meanwhile()
            }
            return answers[log.id] ?? .stored
        }
    }

    @Test func aLogAddedWhileSendingIsNotLostAndOnlyAcknowledgedOnesGo() async throws {
        let file = Self.file()
        let outbox = Outbox(file: file)
        try outbox.add([Self.log("d-1"), Self.log("d-2", "mu-met")])
        let mac = StandInMac()
        mac.meanwhile = { try outbox.add([Self.log("d-3")]) }
        mac.answers["d-2"] = .refused("Another dose log already has this id.")

        try await outbox.send(to: Self.pairing, mac.take)

        // d-3 came while d-1 was being sent: it went too. The refused one stays,
        // marked, and isn't sent again.
        #expect(mac.sent == ["d-1", "d-2", "d-3"])
        #expect(outbox.logs.map(\.id) == ["d-2"])
        #expect(outbox.logs.first?.refused == "Another dose log already has this id.")
        try await outbox.send(to: Self.pairing, mac.take)
        #expect(mac.sent == ["d-1", "d-2", "d-3"])
        // As kept in its file.
        #expect(Outbox(file: file).logs == outbox.logs)
    }

    @Test func theMacOutOfReachKeepsEveryLogForLater() async throws {
        let file = Self.file()
        let outbox = Outbox(file: file)
        try outbox.add([Self.log("d-1"), Self.log("d-2", "mu-met")])
        let mac = StandInMac()
        mac.away = true

        try await outbox.send(to: Self.pairing, mac.take)

        #expect(Outbox(file: file).logs.map(\.id) == ["d-1", "d-2"])
        mac.away = false
        try await outbox.send(to: Self.pairing, mac.take)
        #expect(Outbox(file: file).logs.isEmpty)
    }

    @Test func afterUnpairingTheyGoOnlyToTheSamePersonOnTheSameMacsFolder() async throws {
        let outbox = Outbox(file: Self.file())
        try outbox.add([Self.log("d-1")])
        let mac = StandInMac()
        let ravi = Pairing(origin: Self.pairing.origin, app: "app-r1", person: .init(id: "per-ravi", name: "Ravi"),
                           mac: "mahesh-mbp", folder: "fold-1")
        let otherMac = Pairing(origin: Self.pairing.origin, app: "app-x1", person: Self.mahesh,
                               mac: "work-mbp", folder: "fold-2")

        for other in [ravi, otherMac] { try await outbox.send(to: other, mac.take) }
        #expect(mac.sent.isEmpty)

        // Paired again for Mahesh on the same Mac's folder: a new app, the same log.
        let again = Pairing(origin: Self.pairing.origin, app: "app-m2", person: Self.mahesh,
                            mac: "mahesh-mbp", folder: "fold-1")
        try await outbox.send(to: again, mac.take)
        #expect(mac.sent == ["d-1"])
        #expect(outbox.logs.isEmpty)
    }

    @Test func theMacSayingUnpairedKeepsTheLogsAndSaysSo() async throws {
        let outbox = Outbox(file: Self.file())
        try outbox.add([Self.log("d-1")])

        await #expect(throws: Door.Problem.unpaired) {
            try await outbox.send(to: Self.pairing) { _ throws(Door.Problem) in throw .unpaired }
        }
        #expect(outbox.logs.map(\.id) == ["d-1"])
    }

    @Test func discardingOneKeepsTheOthers() throws {
        let file = Self.file()
        let outbox = Outbox(file: file)
        try outbox.add([Self.log("d-1"), Self.log("d-2", "mu-met")])

        try outbox.discard("d-1")

        #expect(Outbox(file: file).logs.map(\.id) == ["d-2"])
    }

    @Test func waitingLogsAreKeptOutOfTheIPhonesBackups() throws {
        let file = Self.file()
        try Outbox(file: file).add([Self.log("d-1")])

        let folder = try file.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(folder.isExcludedFromBackup == true)
    }

    @Test func aLogTheMacHasButTheFileStillHoldsKeepsLockRufiOnThroughUnpairing() async throws {
        let file = Self.file()
        let folder = file.deletingLastPathComponent()
        let outbox = Outbox(file: file)
        try outbox.add([Self.log("d-1")])
        // The Mac takes it, but the file can't be written after.
        let mac = StandInMac()
        mac.meanwhile = { try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.path()) }
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path()) }
        try await outbox.send(to: Self.pairing, mac.take)
        let lock = Lock(defaults: UserDefaults(suiteName: "lock-\(UUID().uuidString)")!, passcode: { true })
        lock.on = true

        await AppModel(lock: lock, outbox: outbox).unpair()

        #expect(mac.sent == ["d-1"])
        #expect(lock.on)
        #expect(Outbox(file: file).logs.map(\.id) == ["d-1"])
    }
}

import Foundation
import Observation

/// One dose log made on this iPhone that the Mac hasn't acknowledged yet:
/// one medicine at one dose time, taken or skipped, with the pairing it was
/// made under. Its id is made here and kept, so sending it again is stored
/// once on the Mac.
nonisolated struct UnsentLog: Codable, Equatable, Identifiable, Sendable {
    /// Cleared: Undo on Today, a log of its own that clears the dose's.
    enum State: String, Codable, Sendable { case taken, skipped, cleared }

    /// The pairing a log was made under: it goes only to this person on
    /// this Mac's folder, whichever app pairs for them next.
    struct Made: Codable, Equatable, Sendable {
        let folder: String
        let person: String
        let name: String
        let mac: String
        let app: String

        init(_ pairing: Pairing) {
            folder = pairing.folder
            person = pairing.person.id
            name = pairing.person.name
            mac = pairing.mac
            app = pairing.app
        }

        /// Whether `pairing` may send it: the same person on the same Mac's folder.
        func matches(_ pairing: Pairing) -> Bool {
            folder == pairing.folder && person == pairing.person.id
        }
    }

    let id: String
    let made: Made
    /// The medicine use, and how it was named: "Amoxicillin 500 mg".
    let medicine: String
    let label: String
    /// The dose's local date and time, 'YYYY-MM-DDTHH:MM'.
    let doseAt: String
    let state: State
    /// When it was logged, as an instant.
    let loggedAt: String
    /// When it was taken: the tap, for Taken on a reminder; none when skipped.
    var takenAt: String?
    /// The Mac refused it, in its words: kept, not sent again.
    var refused: String?
}

/// The dose logs not on the Mac yet, and the one file they are kept in:
/// nothing else writes it. A group is written whole, by atomic replacement,
/// before anything else happens to it; each log leaves only when the Mac
/// acknowledges it. They stay after unpairing, until sent to the same
/// person on the same Mac's folder, or discarded.
@Observable
final class Outbox {
    /// In a folder of its own in Application Support, kept out of the
    /// iPhone's backups, readable after the first unlock since a restart, so
    /// a reminder's Taken works while the iPhone is locked.
    static let file = URL.applicationSupportDirectory.appending(path: "Outbox/unsent-logs.json")

    private(set) var logs: [UnsentLog]
    /// Logs the Mac stored, in memory, until a Today read begun after them
    /// has them: Today shows them meanwhile, so a dose stored isn't offered
    /// again (`forget(storedBefore:)`).
    private(set) var stored: [Stored] = []
    private let file: URL

    struct Stored {
        let log: UnsentLog
        let at: Date
    }
    private var sending = false

    init(file: URL = Outbox.file) {
        self.file = file
        logs = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([UnsentLog].self, from: $0) } ?? []
    }

    /// Adds a group, kept in the file before this returns; on a failure,
    /// nothing is added.
    func add(_ group: [UnsentLog]) throws {
        try write(logs + group)
        logs += group
    }

    /// The person discarded one: it is never sent.
    func discard(_ id: String) throws {
        let kept = logs.filter { $0.id != id }
        try write(kept)
        logs = kept
    }

    /// Sends, one at a time, each log `pairing` may send that the Mac hasn't
    /// refused, and keeps what isn't acknowledged. Out of reach: the rest
    /// waits for the next time. One send at a time; logs added meanwhile go
    /// in the same run. Throws `unpaired` as the Mac says it.
    func send(to pairing: Pairing,
              _ deliver: (UnsentLog) async throws(Door.Problem) -> Door.Logged) async throws(Door.Problem) {
        // The send under way takes logs added meanwhile.
        guard !sending else { return }
        sending = true
        defer { sending = false }
        var tried: Set<String> = []
        repeat {
            for log in logs where log.refused == nil && log.made.matches(pairing) && !tried.contains(log.id) {
                tried.insert(log.id)
                let answer: Door.Logged
                do {
                    answer = try await deliver(log)
                } catch .unpaired {
                    throw .unpaired
                } catch {
                    return
                }
                // Read again after the wait: a log may have come or gone meanwhile.
                var now = logs
                switch answer {
                case .stored:
                    now.removeAll { $0.id == log.id }
                case let .refused(words):
                    if let at = now.firstIndex(where: { $0.id == log.id }) { now[at].refused = words }
                }
                // The file first, then memory, so they never differ: a write
                // that fails keeps the log in both, and it is sent again,
                // which the Mac answers as already stored.
                if (try? write(now)) != nil {
                    logs = now
                    if case .stored = answer { stored.append(Stored(log: log, at: .now)) }
                }
            }
        } while logs.contains { $0.refused == nil && $0.made.matches(pairing) && !tried.contains($0.id) }
    }

    /// A Today read begun at `date` has every log stored before it.
    func forget(storedBefore date: Date) {
        stored.removeAll { $0.at < date }
    }

    private func write(_ logs: [UnsentLog]) throws {
        // The folder, not the file: each write replaces the file.
        var folder = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var away = URLResourceValues()
        away.isExcludedFromBackup = true
        try folder.setResourceValues(away)
        try JSONEncoder().encode(logs).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

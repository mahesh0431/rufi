import Foundation
import Observation

/// A message sent from the box while Rufi couldn't be reached: it waits on
/// the iPhone and goes when Rufi can be reached. Its id is the send's, made
/// here and kept, so sending it again makes one message on the Mac.
nonisolated struct PendingMessage: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let text: String
}

/// The messages waiting to go, and the one file they are kept in, beside the
/// dose logs not on the Mac yet: out of the iPhone's backups, readable after
/// the first unlock. Unpairing is a fresh start: they all go.
@Observable
final class Pending {
    static let file = URL.applicationSupportDirectory.appending(path: "Outbox/pending-messages.json")

    private(set) var messages: [PendingMessage]
    private let file: URL
    private var sending = false
    /// Goes up at each unpairing: a send started before it stops there.
    private var generation = 0

    init(file: URL = Pending.file) {
        self.file = file
        messages = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([PendingMessage].self, from: $0) }
            ?? []
    }

    /// Keeps `text` to send, in the file before this returns; on a failure,
    /// nothing is kept.
    func add(_ text: String) throws {
        let message = PendingMessage(id: UUID().uuidString.lowercased(), text: text)
        try write(messages + [message])
        messages.append(message)
    }

    /// Unpaired: they all go, and a send under way stops at its next step.
    func clear() {
        generation += 1
        sending = false
        messages = []
        if (try? FileManager.default.removeItem(at: file)) == nil { try? write([]) }
    }

    /// Sends them in order, one at a time, each under its own id. Out of
    /// reach: the rest waits for the next time. One Rufi refused leaves the
    /// list: its words and Rufi's come back, for the box. Throws `unpaired`
    /// as the Mac says it, unless this iPhone was unpaired meanwhile: then
    /// the send just stops.
    @discardableResult
    func send(_ deliver: (PendingMessage) async throws(Door.Problem) -> Void)
        async throws(Door.Problem) -> [(text: String, refused: String)] {
        guard !sending else { return [] }
        sending = true
        let run = generation
        defer { if generation == run { sending = false } }
        var back: [(text: String, refused: String)] = []
        while let message = messages.first {
            var refused: String?
            do {
                try await deliver(message)
            } catch .unpaired {
                if generation == run { throw .unpaired }
                return []
            } catch let .refused(words) {
                refused = words
            } catch {
                return back
            }
            // Unpaired meanwhile: the rest isn't this run's.
            guard generation == run else { return [] }
            let now = messages.filter { $0.id != message.id }
            // A write that fails keeps it in both, and stops: sent again, it is one message.
            guard (try? write(now)) != nil else { return back }
            messages = now
            if let refused { back.append((message.text, refused)) }
        }
        return back
    }

    private func write(_ messages: [PendingMessage]) throws {
        var folder = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var away = URLResourceValues()
        away.isExcludedFromBackup = true
        try folder.setResourceValues(away)
        try JSONEncoder().encode(messages)
            .write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

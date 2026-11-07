import Foundation
import Observation

/// A message sent from the box while Rufi couldn't be reached: it waits on
/// the iPhone and goes when Rufi can be reached. Its id is the send's, made
/// here and kept, so sending it again makes one message on the Mac.
nonisolated struct PendingMessage: Codable, Equatable, Identifiable, Sendable {
    let id: String
    /// Whose chat, in which Mac's folder: it goes only there.
    let folder: String
    let person: String
    let text: String
    /// When it was written, on the iPhone's clock: 'YYYY-MM-DDTHH:MM'.
    let writtenAt: String
    /// Rufi refused it, in its words: kept, not sent again.
    var refused: String?

    func matches(_ pairing: Pairing) -> Bool {
        folder == pairing.folder && person == pairing.person.id
    }
}

/// The messages waiting to go, and the one file they are kept in, beside the
/// dose logs not on the Mac yet: out of the iPhone's backups, readable after
/// the first unlock. Unpairing removes them.
@Observable
final class Pending {
    static let file = URL.applicationSupportDirectory.appending(path: "Outbox/pending-messages.json")

    private(set) var messages: [PendingMessage]
    private let file: URL
    private var sending = false

    init(file: URL = Pending.file) {
        self.file = file
        messages = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([PendingMessage].self, from: $0) }
            ?? []
    }

    /// Keeps `text` to send for `pairing`'s person, in the file before this
    /// returns; on a failure, nothing is kept.
    func add(_ text: String, for pairing: Pairing, at now: Date = .now) throws {
        let written = DateFormatter()
        written.locale = Locale(identifier: "en_US_POSIX")
        written.dateFormat = "yyyy-MM-dd'T'HH:mm"
        let message = PendingMessage(id: UUID().uuidString.lowercased(), folder: pairing.folder,
                                     person: pairing.person.id, text: text, writtenAt: written.string(from: now))
        try write(messages + [message])
        messages.append(message)
    }

    /// The person took it back: it is never sent.
    func remove(_ id: String) throws {
        let kept = messages.filter { $0.id != id }
        try write(kept)
        messages = kept
    }

    /// Unpaired: they all go.
    func clear() {
        messages = []
        try? FileManager.default.removeItem(at: file)
    }

    /// Sends, in order, each message `pairing` may send that Rufi hasn't
    /// refused, one at a time. Out of reach: the rest waits for the next
    /// time. Throws `unpaired` as the Mac says it.
    func send(to pairing: Pairing,
              _ deliver: (PendingMessage) async throws(Door.Problem) -> Void) async throws(Door.Problem) {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        var tried: Set<String> = []
        while let message = messages.first(where: {
            $0.refused == nil && $0.matches(pairing) && !tried.contains($0.id)
        }) {
            tried.insert(message.id)
            var refused: String?
            do {
                try await deliver(message)
            } catch .unpaired {
                throw .unpaired
            } catch let .refused(words) {
                refused = words
            } catch {
                return
            }
            // Read again after the wait: one may have been taken back meanwhile.
            var now = messages
            if let refused {
                if let at = now.firstIndex(where: { $0.id == message.id }) { now[at].refused = refused }
            } else {
                now.removeAll { $0.id == message.id }
            }
            // A write that fails keeps it in both: sent again, it is one message.
            if (try? write(now)) != nil { messages = now }
        }
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

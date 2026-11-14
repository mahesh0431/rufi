import Foundation
import Observation

/// A message sent from the box: it waits on the iPhone until the Mac takes
/// it, also while Rufi can't be reached. Its id is the send's, made here and
/// kept, so sending it again makes one message on the Mac.
nonisolated struct PendingMessage: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let text: String
    /// Its chips; none in a message kept before chips went with it.
    var refs: [Chip]?
    /// While a reply runs: steer (into it) or queue (after it); none: the Mac's choice.
    var kind: String?
    /// Rufi refused it, with these words: its words are the box's now, and
    /// it is never sent again by itself, also after a restart.
    var refused: String?

    /// Back for the box, as Rufi refused it: its words can change now, so a
    /// question card's quote keeps no answer (docs/adr/0036).
    func back(refused words: String) -> PendingMessage {
        var back = self
        back.refs = refs?.map { chip in
            var ref = chip.ref
            ref.answer = nil
            return Chip(ref: ref, label: chip.label, detail: chip.detail, deleted: chip.deleted)
        }
        back.refused = words
        return back
    }
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
    /// Goes up at each unpairing: a send started before it stops there, and
    /// one for a pairing before it never starts.
    private(set) var generation = 0

    init(file: URL = Pending.file) {
        self.file = file
        messages = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([PendingMessage].self, from: $0) }
            ?? []
    }

    /// Keeps `text` and `refs` to send, in the file before this returns; on
    /// a failure, nothing is kept.
    @discardableResult
    func add(_ text: String, refs: [Chip] = [], kind: String? = nil) throws -> PendingMessage {
        let message = PendingMessage(id: UUID().uuidString.lowercased(), text: text, refs: refs.isEmpty ? nil : refs,
                                     kind: kind)
        try write(messages + [message])
        messages.append(message)
        return message
    }

    /// Unpaired: they all go, and a send under way stops at its next step.
    func clear() {
        generation += 1
        sending = false
        messages = []
        if (try? FileManager.default.removeItem(at: file)) == nil { try? write([]) }
    }

    /// Sends them in order, one at a time, each under its own id, but those
    /// in `back` (put back in the box) and those Rufi refused. Out of reach:
    /// the rest waits for the next time. One Rufi refused is kept as refused
    /// first, in the file, and then comes back with Rufi's words, for the
    /// box; it stays here until the box has its words (`remove`), so it isn't
    /// lost meanwhile. Kept as refused, it is never sent again by itself. Throws `unpaired` as the Mac says it, unless this
    /// iPhone was unpaired meanwhile: then the send just stops. Only the
    /// pairing they were kept under (`pairing`, its generation) sends them.
    @discardableResult
    func send(for pairing: Int, skipping back: Set<String> = [],
              _ deliver: (PendingMessage) async throws(Door.Problem) -> Void)
        async throws(Door.Problem) -> [(message: PendingMessage, refused: String)] {
        guard pairing == generation, !sending else { return [] }
        sending = true
        let run = generation
        defer { if generation == run { sending = false } }
        var refusals: [(message: PendingMessage, refused: String)] = []
        var skipped = back
        while let message = messages.first(where: { !skipped.contains($0.id) && $0.refused == nil }) {
            var refused: String?
            do {
                try await deliver(message)
            } catch .unpaired {
                if generation == run { throw .unpaired }
                return []
            } catch let .refused(words) {
                refused = words
            } catch {
                return refusals
            }
            // Unpaired meanwhile: the rest isn't this run's.
            guard generation == run else { return [] }
            if let refused {
                // Refused in the file before its words can change: if it
                // can't be kept so, it stays as it was, and goes again later.
                let back = message.back(refused: refused)
                let now = messages.map { $0.id == message.id ? back : $0 }
                guard (try? write(now)) != nil else { return refusals }
                messages = now
                refusals.append((back, refused))
                continue
            }
            let now = messages.filter { $0.id != message.id }
            // A write that fails keeps it in both, and stops: sent again, it is one message.
            guard (try? write(now)) != nil else { return refusals }
            messages = now
        }
        return refusals
    }

    /// Refused ones whose words the box now has: they leave the list. A
    /// write that fails keeps them, to come back again.
    func remove(_ ids: Set<String>) {
        let now = messages.filter { !ids.contains($0.id) }
        guard (try? write(now)) != nil else { return }
        messages = now
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

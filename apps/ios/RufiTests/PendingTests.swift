import Foundation
import Testing
@testable import Rufi

/// Messages sent while Rufi can't be reached wait on the iPhone, kept in
/// their file, and go in order when it can, each once; unpairing is a
/// fresh start.
struct PendingTests {
    static func file() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "pending-\(UUID().uuidString)/pending.json")
    }

    @Test func theyGoInOrderAndARefusedOneStaysUntilTheBoxHasIt() async throws {
        let file = Self.file()
        let pending = Pending(file: file)
        try pending.add("I took my Metformin")
        try pending.add("Too long")
        try pending.add("And my blood pressure was 128/82")

        var sent: [String] = []
        var away = true
        let take = { (message: PendingMessage) async throws(Door.Problem) in
            if away { throw .unreachable }
            if message.text == "Too long" { throw .refused("That message is too long.") }
            sent.append(message.text)
        }
        // Rufi away: all of them wait, as kept in their file.
        #expect(try await pending.send(for: pending.generation, take).isEmpty)
        #expect(Pending(file: file).messages.count == 3)

        away = false
        let back = try await pending.send(for: pending.generation, take)
        #expect(sent == ["I took my Metformin", "And my blood pressure was 128/82"])
        // Refused: its words and Rufi's back for the box, and kept until the
        // box has them.
        #expect(back.map(\.message.text) == ["Too long"])
        #expect(back.map(\.refused) == ["That message is too long."])
        #expect(Pending(file: file).messages.map(\.text) == ["Too long"])
        // Its words in the box: not sent again.
        #expect(try await pending.send(for: pending.generation, skipping: [back[0].message.id], take).isEmpty)
        pending.remove([back[0].message.id])
        #expect(Pending(file: file).messages.isEmpty)
    }

    /// A chat of the pairing before never sends what the new pairing kept:
    /// it would reach the old Mac's person.
    @Test func anOldPairingNeverSendsTheNewPairingsMessages() async throws {
        let pending = Pending(file: Self.file())
        let old = pending.generation
        pending.clear()
        try pending.add("New pairing Ravi message")
        var sent: [String] = []
        let take = { (message: PendingMessage) async throws(Door.Problem) in sent.append(message.text) }
        #expect(try await pending.send(for: old, take).isEmpty)
        #expect(sent.isEmpty)
        #expect(pending.messages.map(\.text) == ["New pairing Ravi message"])
        // The new pairing's chat sends it.
        try await pending.send(for: pending.generation, take)
        #expect(sent == ["New pairing Ravi message"])
    }

    @Test func unpairingRemovesThemAndStopsASendUnderWay() async throws {
        let file = Self.file()
        let pending = Pending(file: file)
        try pending.add("I took my Metformin")
        try pending.add("And my blood pressure was 128/82")
        var sent: [String] = []
        // Unpaired while the first is on its way, then a new message: the
        // old send stops and doesn't take it.
        try await pending.send(for: pending.generation) { (message: PendingMessage) async throws(Door.Problem) in
            sent.append(message.text)
            pending.clear()
            try? pending.add("Written after pairing again")
        }
        #expect(sent == ["I took my Metformin"])
        #expect(pending.messages.map(\.text) == ["Written after pairing again"])

        pending.clear()
        #expect(pending.messages.isEmpty)
        #expect(Pending(file: file).messages.isEmpty)
    }
}

import Foundation
import Testing
@testable import Rufi

/// Messages sent while Rufi can't be reached wait on the iPhone, kept in
/// their file, and go in order when it can, each once; they go only to the
/// person and Mac's folder they were written for.
struct PendingTests {
    static let pairing = OutboxTests.pairing

    static func file() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "pending-\(UUID().uuidString)/pending.json")
    }

    @Test func theyGoInOrderWhenRufiAnswersAndARefusedOneStays() async throws {
        let file = Self.file()
        let pending = Pending(file: file)
        let at = ISO8601DateFormatter().date(from: "2026-11-07T09:10:00Z")!
        try pending.add("I took my Metformin", for: Self.pairing, at: at)
        try pending.add("And my blood pressure was 128/82", for: Self.pairing, at: at)
        try pending.add("Too long", for: Self.pairing, at: at)
        #expect(pending.messages.first?.writtenAt.count == 16)

        var sent: [String] = []
        var away = true
        let take = { (message: PendingMessage) async throws(Door.Problem) in
            if away { throw .unreachable }
            if message.text == "Too long" { throw .refused("That message is too long.") }
            sent.append(message.text)
        }
        // Rufi away: all of them wait.
        try await pending.send(to: Self.pairing, take)
        #expect(pending.messages.count == 3)

        away = false
        try await pending.send(to: Self.pairing, take)
        #expect(sent == ["I took my Metformin", "And my blood pressure was 128/82"])
        #expect(pending.messages.map(\.text) == ["Too long"])
        #expect(pending.messages.first?.refused == "That message is too long.")
        // Refused: not sent again.
        try await pending.send(to: Self.pairing, take)
        #expect(sent.count == 2)
        // As kept in its file.
        #expect(Pending(file: file).messages == pending.messages)
    }

    @Test func anotherPairingsWaitAndUnpairingRemovesThem() async throws {
        let file = Self.file()
        let pending = Pending(file: file)
        let other = Pairing(origin: Self.pairing.origin, app: "app-r1",
                            person: Door.Person(id: "per-ravi", name: "Ravi"), mac: "mahesh-mbp", folder: "fold-1")
        try pending.add("For Ravi", for: other)
        var sent: [String] = []
        try await pending.send(to: Self.pairing) { (message: PendingMessage) async throws(Door.Problem) in
            sent.append(message.text)
        }
        #expect(sent.isEmpty)

        pending.clear()
        #expect(pending.messages.isEmpty)
        #expect(Pending(file: file).messages.isEmpty)
    }
}

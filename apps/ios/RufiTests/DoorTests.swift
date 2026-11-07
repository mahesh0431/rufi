import Foundation
import Testing
@testable import Rufi

/// The door's refusals reach the app as what they are: an expired code, an
/// unpaired iPhone, the door's own words. Only an answer the app can't read
/// says to update Rufi.
struct DoorTests {
    init() {
        Door.standIn = StandInDoor.self
    }

    @Test func refusalsKeepTheirReason() async {
        let link = PairingLink("https://door.test/pair#code=used-code")!
        let door = Door(origin: link.origin, key: "a-key")

        await #expect(throws: Door.Problem.codeExpired) {
            try await Door.pair(link, name: "Asha's iPhone")
        }
        await #expect(throws: Door.Problem.unpaired) {
            try await door.me()
        }
        await #expect(throws: Door.Problem.refused("That page isn't Asha Fictional's.")) {
            try await door.open("/people/ravi/chat")
        }
        await #expect(throws: Door.Problem.mismatch) {
            try await door.unpair()
        }
    }

    /// Tailscale answers a gateway error, without Rufi's words, when Rufi
    /// isn't running on the Mac: Rufi can't be reached. Rufi's own 502 keeps
    /// its words.
    @Test func tailscalesGatewayErrorIsUnreachable() async {
        func door(_ host: String) -> Door { Door(origin: URL(string: "https://\(host)")!, key: "a-key") }

        await #expect(throws: Door.Problem.unreachable) {
            try await door("stopped.test").me()
        }
        await #expect(throws: Door.Problem.refused("The AI couldn't do that.")) {
            try await door("rufi.test").open("/people/asha/chat")
        }
        let message = PendingMessage(id: "m-1", text: "I took my Metformin")
        await #expect(throws: Door.Problem.unreachable) {
            try await door("stopped.test").send(message, for: "asha")
        }
        await #expect(throws: Door.Problem.refused("The AI couldn't do that.")) {
            try await door("rufi.test").send(message, for: "asha")
        }
    }

    /// A batch's answer: had it, or why not, in the Mac's words; an iPhone
    /// unpaired on the Mac hears so, and a Rufi without batches says update.
    @Test func batchAnswersKeepTheirReason() async throws {
        func door(_ host: String) -> Door { Door(origin: URL(string: "https://\(host)")!, key: "a-key") }

        #expect(try await door("got.test").batch(Data("{}".utf8)) == .gotIt)
        await #expect(throws: Door.Problem.unpaired) {
            try await door("unpaired.test").batch(Data("{}".utf8))
        }
        await #expect(throws: Door.Problem.refused("Rufi on your Mac couldn't store this.")) {
            try await door("full.test").batch(Data("{}".utf8))
        }
        await #expect(throws: Door.Problem.refused("Rufi on your Mac refused a batch (no_batch_id).")) {
            try await door("refused.test").batch(Data("{}".utf8))
        }
        await #expect(throws: Door.Problem.mismatch) {
            try await door("old.test").batch(Data("{}".utf8))
        }
    }
}

/// Answers each call as the door would refuse it; unpair succeeds with a body
/// the app can't read.
nonisolated private final class StandInDoor: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, body): (Int, String) = switch (request.url?.path(), request.url?.host()) {
        case ("/api/batches", "got.test"): (200, #"{"answer":"got_it"}"#)
        case ("/api/batches", "unpaired.test"): (401, #"{"error":"This app isn't paired.","problem":"unpaired"}"#)
        case ("/api/batches", "full.test"):
            (503, #"{"error":"Rufi on your Mac couldn't store this.","problem":"couldnt_store","reason":"disk_full"}"#)
        case ("/api/batches", "refused.test"):
            (422, #"{"answer":"refused","problems":["no_batch_id"],"error":"Rufi on your Mac refused a batch (no_batch_id)."}"#)
        case ("/api/batches", _): (404, #"{"error":"Not found."}"#)
        case (_, "stopped.test"): (502, "")
        case (_, "rufi.test"): (502, #"{"error":"The AI couldn't do that."}"#)
        case ("/api/pair", _): (410, #"{"error":"That code was used or is too old.","problem":"code_expired"}"#)
        case ("/api/me", _): (401, #"{"error":"This iPhone isn't paired.","problem":"unpaired"}"#)
        case ("/api/open", _): (403, #"{"error":"That page isn't Asha Fictional's."}"#)
        default: (200, "<html>not the door</html>")
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

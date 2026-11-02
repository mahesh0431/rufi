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
}

/// Answers each call as the door would refuse it; unpair succeeds with a body
/// the app can't read.
nonisolated private final class StandInDoor: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, body): (Int, String) = switch request.url?.path() {
        case "/api/pair": (410, #"{"error":"That code was used or is too old.","problem":"code_expired"}"#)
        case "/api/me": (401, #"{"error":"This iPhone isn't paired.","problem":"unpaired"}"#)
        case "/api/open": (403, #"{"error":"That page isn't Asha Fictional's."}"#)
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

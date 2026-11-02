import Foundation
import Testing
@testable import Rufi

/// A pairing link is only Rufi's, over https: the code, and the key it is
/// exchanged for, never travel in the clear.
struct PairingLinkTests {
    @Test func readsTheDoorAndTheCode() throws {
        let link = try #require(PairingLink("https://mahesh-mbp.tail1234.ts.net:41789/pair#code=pQZt-TS_eocA28"))
        #expect(link.origin == URL(string: "https://mahesh-mbp.tail1234.ts.net:41789"))
        #expect(link.code == "pQZt-TS_eocA28")
    }

    @Test(arguments: [
        "http://mahesh-mbp.tail1234.ts.net:41789/pair#code=abc",
        "rufi://mahesh-mbp.tail1234.ts.net:41789/pair#code=abc",
        "https://mahesh-mbp.tail1234.ts.net:41789/other#code=abc",
        "https://mahesh-mbp.tail1234.ts.net:41789/pair?code=abc",
        "https://mahesh-mbp.tail1234.ts.net:41789/pair#code=",
        "https://someone@mahesh-mbp.tail1234.ts.net:41789/pair#code=abc",
        "my code is abc",
    ])
    func refusesAnythingElse(_ text: String) {
        #expect(PairingLink(text) == nil)
    }
}

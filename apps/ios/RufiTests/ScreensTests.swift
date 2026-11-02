import Foundation
import Testing
import WebKit
@testable import Rufi

/// The iPhone's text size and bar values reach the page that is open, each
/// time they change, not only the next page.
struct ScreensTests {
    @Test func valuesChangeOnTheOpenPageAgainAndAgain() async throws {
        let door = try #require(URL(string: "https://door.example:4100"))
        let screens = Screens(origin: door)
        screens.view.loadHTMLString("<html><body>Fictional page</body></html>", baseURL: door)
        for _ in 0..<100 {
            if (try? await screens.view.evaluateJavaScript("document.readyState")) as? String == "complete" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let value = { (name: String) async throws -> String? in
            try await screens.view.evaluateJavaScript(
                "document.documentElement.style.getPropertyValue('\(name)')") as? String
        }
        screens.bars(top: 100, bottom: 50)
        #expect(try await value("--bar-top") == "100.0px")
        screens.bars(top: 120, bottom: 60)
        #expect(try await value("--bar-top") == "120.0px")
        #expect(try await value("--bar-bottom") == "60.0px")
    }
}

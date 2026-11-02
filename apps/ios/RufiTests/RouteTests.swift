import Testing
@testable import Rufi

/// A tapped link opens where the plan says: a tab's own first page switches
/// to that tab; any other page is pushed in the tab you are in.
struct RouteTests {
    @Test func aTabsFirstPageSwitchesToIt() {
        #expect(Route.of("/people/asha/documents", person: "asha") == .tab(.documents))
        #expect(Route.of("/people/asha/chat", person: "asha") == .tab(.chat))
        #expect(Route.of("/", person: "asha") == .tab(.record))
    }

    @Test func anyOtherPageIsPushed() {
        #expect(Route.of("/people/asha/tests/tst-hba1c", person: "asha") == .push("/people/asha/tests/tst-hba1c"))
        #expect(Route.of("/people/asha/documents?open=doc-1", person: "asha") == .push("/people/asha/documents?open=doc-1"))
    }
}

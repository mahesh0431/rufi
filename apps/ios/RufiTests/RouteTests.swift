import Testing
@testable import Rufi

/// What the chrome shows follows where the pages go: the sidebar's current
/// place, the title and Back come from the page on top, as it last said.
struct RouteTests {
    @Test func aLinkInTheChatToADocumentMarksDocumentsAndBackReturnsToTheChat() {
        var navigator = Navigator(person: "asha", at: .chat)
        #expect(navigator.current == .chat)

        // "Your kidney and blood record PDF is being read": its link, in a reply.
        let document = navigator.go("/people/asha/documents/doc-kidney")
        #expect(navigator.current == .documents)
        #expect(navigator.stack == [document])
        navigator.drawn(document.id, "/people/asha/documents/doc-kidney", "Kidney and blood record.pdf")
        #expect(navigator.page(navigator.top)?.title == "Kidney and blood record.pdf")

        // Back, or the edge swipe.
        navigator.popped(to: [])
        #expect(navigator.current == .chat)
        #expect(navigator.page(navigator.top)?.title == "Chat with Rufi")
    }

    @Test func aRowLinkedInTheChatOverMedicinesOpensOnTopAndBackOpensThatChatAgain() {
        var navigator = Navigator(person: "asha", at: .medicines)
        // "Your Metformin": its link, in a reply in the chat over Medicines.
        let row = navigator.go("/people/asha/record/medicine_use?open=med-1", chat: true)
        #expect(navigator.stack == [row])
        #expect(navigator.current == .medicines)
        navigator.popped(to: [])
        #expect(navigator.page(navigator.top)?.chat == true)
        // A link on the page itself: Back shows the page with the chat closed.
        navigator.go("/people/asha/documents/doc-1")
        navigator.popped(to: [])
        #expect(navigator.page(navigator.top)?.chat == false)
    }

    @Test func aLinkToAPlacesOwnPageReplacesWhatIsShownWithNoBack() {
        var navigator = Navigator(person: "asha", at: .chat)
        navigator.go("/people/asha/tests/tst-hba1c")
        // Open as page, from the chat over a page; or a reply's link to Medicines.
        navigator.go("/people/asha/record/medicine_use")
        #expect(navigator.current == .medicines)
        #expect(navigator.stack.isEmpty)
        #expect(navigator.page(navigator.top)?.title == "Medicines")
    }

    @Test func aPageNoPlaceHoldsMarksNoneAsOnTheMac() {
        var navigator = Navigator(person: "asha", at: .labResults)
        navigator.go("/people/asha/tests/tst-hba1c")
        #expect(navigator.current == nil)
        #expect(Place.current(at: "/people/asha/documents?open=doc-1", person: "asha") == .documents)
        #expect(Place.current(at: "/help/iphone", person: "asha") == .help)
        #expect(Place.current(at: "/", person: "asha") == .overview)
    }
}

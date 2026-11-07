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

    @Test func theIPhoneDrawsOverviewTheSimpleRecordPagesAndFollowUpsAndTheMacsScreensTheRest() {
        #expect(NativePage.of("/", person: "asha") == .overview)
        #expect(NativePage.of("/people/asha/record/condition", person: "asha") == .list("condition"))
        #expect(NativePage.of("/people/asha/record/allergy?open=all-1", person: "asha") == .row(kind: "allergy", id: "all-1"))
        #expect(NativePage.of("/people/asha/follow-ups", person: "asha") == .followUps)
        #expect(NativePage.of("/people/asha/follow-ups?open=fu-1", person: "asha") == .row(kind: "follow_up", id: "fu-1"))
        // Until they are drawn here too.
        #expect(NativePage.of("/people/asha/record/lab_result", person: "asha") == .labResults)
        #expect(NativePage.of("/people/asha/record/measurement?open=res-a9", person: "asha") == .row(kind: "result", id: "res-a9"))
        // A reply's link to HbA1c, and to one of its values.
        #expect(NativePage.of("/people/asha/tests/tst-hba1c", person: "asha") == .test("tst-hba1c"))
        #expect(NativePage.of("/people/asha/tests/tst-hba1c?open=res-a1", person: "asha") == .row(kind: "result", id: "res-a1"))
        #expect(NativePage.of("/people/asha/visits/vis-a1", person: "asha") == .visit("vis-a1"))
        #expect(NativePage.of("/people/asha/record/visit?open=vis-a1", person: "asha") == .visit("vis-a1"))
        #expect(NativePage.of("/people/asha/documents", person: "asha") == .documents)
        #expect(NativePage.of("/people/asha/documents/doc-1", person: "asha") == .document("doc-1"))
        #expect(NativePage.of("/people/asha/chat", person: "asha") == nil)
        // Someone else's page is never Asha's.
        #expect(NativePage.of("/people/ravi/record/condition", person: "asha") == nil)
    }

    @Test func aReplysLinkToAConditionOpensItOverTheChatAndItsDocumentOverThat() {
        var navigator = Navigator(person: "asha", at: .chat)
        // "Your diabetes": its link, in a reply.
        let row = navigator.go("/people/asha/record/condition?open=cond-a1")
        #expect(navigator.current == .conditions)
        navigator.drawn(row.id, "/people/asha/record/condition?open=cond-a1", "Type 2 diabetes")
        // Its source, a document.
        let document = navigator.go("/people/asha/documents/doc-asha-aug")
        #expect(navigator.stack == [row, document])
        navigator.popped(to: [row])
        #expect(navigator.page(navigator.top)?.title == "Type 2 diabetes")
        navigator.popped(to: [])
        #expect(navigator.current == .chat)
    }
}

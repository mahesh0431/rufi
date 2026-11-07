import Foundation
import Testing
@testable import Rufi

/// Documents and a document's page read what the Mac's routes answer (the
/// fixtures) and say it in the Mac's words; a delete with saved records
/// from the document asks whether they stay.
struct DocumentTests {
    private func read<Answer: Decodable>(_ name: String, as: Answer.Type = Answer.self) throws -> Answer {
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/\(name).json")
        return try JSONDecoder().decode(Answer.self, from: Data(contentsOf: file))
    }

    @Test func documentsSayEachOnesStatusAndWhetherRetryWouldRead() throws {
        let documents = try read("documents", as: DocumentList.self).documents
        #expect(documents.map { Words.describe($0).name } == ["thyroid recheck.jpg", "Sunrise Labs August.pdf"])
        #expect(documents.map { Words.status(of: $0) } == ["Failed · read 1 of 1", "Not saved · 2 results"])
        #expect(documents.map(Words.canRetry) == [true, false])
        #expect(Words.place(DocumentSummary.Place(pages: [1, 2, 4], of: 5)) == "pages 1–2, 4 of 5")
    }

    @Test func aDocumentsPageSaysWhatWasReadAndWhatWaitsToBeSaved() throws {
        let items = try read("document-items", as: DocumentItems.self)
        // Haemoglobin fixed by Asha, LDL worth a look, HbA1c an earlier value.
        #expect(Words.counts(items) == "2 results · 1 earlier · 1 worth a look · 1 fixed by you")
        #expect(Words.left(items) == "2 results · 1 earlier")
        #expect(Words.toSave(items) == 2)
        #expect(items.items.map(Words.drafted) == ["Drafted: value 13.2", nil, nil])
        #expect(items.pages.map { page in Words.page(page, items: items.items.count { $0.page == page.position }) }
            == ["read · 3 items", "nothing here"])
        let reading = try read("document-reading", as: ReadingView.self)
        #expect(Words.status(of: reading, document: nil) == "read")
        #expect(reading.pages.first?.copy?.hasPrefix("Sunrise Labs") == true)
    }

    /// A reading by an older reader keeps its rows in the page's entry, not
    /// a copy: View reading shows them, with why each may be wrong.
    @Test func anOlderReadingShowsWhatItsReaderRead() throws {
        let reading = try read("document-reading-older", as: ReadingView.self)
        let page = try #require(reading.pages.first)
        #expect(Words.summary(page) == "read so far · 1 item · Sunrise Labs · Collected 1 Sep 2026")
        #expect(Words.rows(page, drafts: []) == [Words.ReadRow(
            name: "TSH", value: "4.6 mIU/L", range: "0.4–4.0", marks: ["H", "unsure"],
            why: "The value is faint. Its unit is not on the page.")])
        #expect(page.checks?.incomplete?.rows_seen == 2)
        #expect(page.entry?.issues == ["The bottom of the photo is cut off."])
    }

    @Test func aDeleteWithSavedRecordsAsksWhetherTheyStayOrGo() throws {
        let preview = try read("document-delete", as: DeletePreview.self)
        #expect(Words.deleteChoices(preview).map(\.saved) == ["keep", "remove"])
        #expect(Words.savedFrom(preview.saved) == "5 records in your health record come from it:")
        let none = DeletePreview(name: preview.name, files: preview.files, place: nil, others: 0, readings: 0,
                                 unsaved: 3, saved: [], version: preview.version)
        #expect(Words.deleteChoices(none).map(\.saved) == [nil])
        #expect(Words.files(in: none) == "1 PDF, 2 pages")
    }
}

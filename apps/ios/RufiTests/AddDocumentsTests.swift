import Foundation
import Testing
@testable import Rufi

/// What is chosen to add goes in whole, or not at all.
struct AddDocumentsTests {
    @Test func chosenFilesGoInWholeOrNotAtAll() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let page = folder.appending(path: "Fictional report page 1.pdf")
        try Data("%PDF-1.4 fictional".utf8).write(to: page)
        let gone = folder.appending(path: "Fictional report page 2.pdf")
        #expect(Chosen.files([page, gone]) == nil)
        #expect(Chosen.files([page])?.map(\.name) == ["Fictional report page 1.pdf"])
    }
}

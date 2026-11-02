import Foundation
import Testing
@testable import Rufi

/// A copy of an original stays in its own folder, under a plain file name,
/// and is gone when it is deleted or at the next start.
struct OriginalsTests {
    @Test(arguments: [
        ("Sunrise Labs August.pdf", "Sunrise Labs August.pdf"),
        ("../../Library/Preferences/x.plist", "-..-Library-Preferences-x.plist"),
        (".hidden", "hidden"),
        ("  ", "Original"),
    ])
    func aNameIsOneFileName(_ name: String, _ file: String) {
        #expect(Originals.fileName(name) == file)
    }

    @Test func aCopyIsDeletedWithItsFolderAndAllAtTheStart() throws {
        let originals = Originals(folder: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        defer { originals.deleteAll() }
        func fetched() throws -> URL {
            let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
            try Data("%PDF-1.7 fictional".utf8).write(to: file)
            return file
        }
        let first = try originals.keep(try fetched(), named: "../report.pdf")
        let second = try originals.keep(try fetched(), named: "report.pdf")
        #expect(first.lastPathComponent == "-report.pdf")

        originals.delete([first])
        #expect(!FileManager.default.fileExists(atPath: first.deletingLastPathComponent().path))
        #expect(FileManager.default.fileExists(atPath: second.path))

        originals.deleteAll()
        #expect(!FileManager.default.fileExists(atPath: second.path))
    }
}

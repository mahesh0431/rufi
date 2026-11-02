import Foundation

/// The copies of originals being shown in Quick Look: each in its own folder
/// in the app's temporary folder, with complete file protection, deleted when
/// Quick Look closes and, for any left behind, at every start. Files being
/// fetched wait in `staging`, inside it, so the start's cleanup finds them too.
nonisolated struct Originals: Sendable {
    let folder: URL

    static let shown = Originals(folder: FileManager.default.temporaryDirectory.appending(path: "originals"))

    /// Where fetched files wait until they are kept.
    var staging: URL { folder.appending(path: "staging", directoryHint: .isDirectory) }

    /// Moves a fetched file into a folder of its own, under its name as the
    /// Mac gave it, made safe to be a file name; the copy's place. When a
    /// step fails, neither the fetched file nor a part-made copy stays.
    func keep(_ fetched: URL, named name: String) throws -> URL {
        let own = folder.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
            let copy = own.appending(path: Self.fileName(name))
            try FileManager.default.moveItem(at: fetched, to: copy)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: copy.path)
            return copy
        } catch {
            try? FileManager.default.removeItem(at: fetched)
            try? FileManager.default.removeItem(at: own)
            throw error
        }
    }

    /// Deletes these copies, each with its folder.
    func delete(_ copies: [URL]) {
        for copy in copies {
            let own = copy.deletingLastPathComponent()
            // Only a copy's own folder in this folder, never anything else.
            guard Self.place(own.deletingLastPathComponent()) == Self.place(folder) else { continue }
            try? FileManager.default.removeItem(at: own)
        }
    }

    /// Deletes every copy, as at the start.
    func deleteAll() {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Where a folder is, however its address ends.
    private static func place(_ url: URL) -> String {
        var path = url.standardizedFileURL.path()
        while path.hasSuffix("/") { path.removeLast() }
        return path
    }

    /// A file's name as a single file name: no folders, not hidden, never
    /// empty, so a name from the page can't place the copy elsewhere.
    static func fileName(_ name: String) -> String {
        let flat = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = flat.drop { $0 == "." }
        return shown.isEmpty ? "Original" : String(shown.prefix(200))
    }
}

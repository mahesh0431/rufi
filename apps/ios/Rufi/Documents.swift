import Foundation

// What the Documents page and a document's page read, as the routes under
// /api/people/<person>/documents answer them (@rufi/contracts/documents).
// Only the fields the iPhone shows; a literal set (a status, a kind)
// decodes as a String.

/// A person's documents, newest first.
nonisolated struct DocumentList: Decodable, Equatable, Sendable {
    let documents: [DocumentSummary]
}

/// One document on the Documents page.
nonisolated struct DocumentSummary: Decodable, Equatable, Identifiable, Sendable {
    /// One original file: a PDF, or one photo.
    struct File: Decodable, Equatable, Sendable {
        let id: String
        let name: String
        let mediaType: String
        let pages: Int
    }

    /// Its pages in what the person added, when it is part of it.
    struct Place: Decodable, Equatable, Sendable {
        let pages: [Int]
        let of: Int
    }

    /// The latest reading: pages saved of those it reads, and its drafts.
    struct Reading: Decodable, Equatable, Sendable {
        let saved: Int
        let of: Int
        let results: Int
        let toCheck: Int
        let hasPending: Bool
        let itemsSaved: Int
        let itemsSetAside: Int
        let canRetry: Bool
        let error: String?
    }

    let id: String
    let addedAt: String
    let kind: String?
    let date: String?
    let lab: String?
    let place: Place?
    let notSorted: Bool
    /// not_read, reading, done or failed.
    let status: String
    let reading: Reading?
    let files: [File]
}

/// What an add did: the new documents, and the files already there.
nonisolated struct Added: Decodable, Equatable, Sendable {
    struct Already: Decodable, Equatable, Sendable {
        let name: String
        let documentId: String
    }

    let added: [String]
    let already: [Already]
}

/// A document's pages and draft items, for its page.
nonisolated struct DocumentItems: Decodable, Equatable, Sendable {
    struct Page: Decodable, Equatable, Sendable {
        /// Rows an older reader counted, and the items it read.
        struct Incomplete: Decodable, Equatable, Sendable {
            let rows_seen: Int
            let items: Int
        }

        let position: Int
        /// read, nothing_here, unreadable or not_looked_at; none while it waits.
        let state: String?
        let why: String?
        let incomplete: Incomplete?
    }

    /// A visit that cites one of its pages: Saved as.
    struct SavedAs: Decodable, Equatable, Sendable {
        let id: String
        let label: String
    }

    let pages: [Page]
    let items: [DraftItem]
    let savedAs: [SavedAs]
}

/// What Rufi AI drafted from a page and the person hasn't saved yet: never
/// the record.
nonisolated struct DraftItem: Decodable, Equatable, Identifiable, Sendable {
    /// A lab result's fields, as printed.
    struct Fields: Decodable, Equatable, Sendable {
        let test_name: String
        let value_text: String
        let unit: String?
        let reference_range: String?
        let flag_text: String?
        let context_text: String?
        /// current or earlier.
        let column: String?
    }

    let id: String
    let page: Int
    /// pending, saved or dismissed.
    let status: String
    /// The fields now: as drafted, or the person's fix.
    let fields: Fields
    /// As drafted, never changed.
    let original: Fields
    /// Why it is worth a look.
    let unsure: [String]
    /// The words it came from; none for an older reader's.
    let quote: String?
    /// Its page was read again since: it can't be saved.
    let outOfDate: Bool
}

/// A document's reading as View reading shows it: the reader's work.
nonisolated struct ReadingView: Decodable, Equatable, Sendable {
    struct Page: Decodable, Equatable, Sendable {
        let position: Int
        let state: String?
        let why: String?
        /// The reader's copy of the page, as printed.
        let copy: String?
    }

    struct Usage: Decodable, Equatable, Sendable {
        let totalTokens: Int
        let cachedInputTokens: Int
        let looks: Int
    }

    let name: String
    /// not_read, reading, done or failed.
    let status: String
    let saved: Int
    let of: Int
    let runAt: String?
    let error: String?
    /// The reader's one note for the whole document.
    let note: String?
    let pages: [Page]
    let usage: Usage?
    let model: String?
    let effort: String?
}

/// What deleting a document would do, for its preview; `version` names it.
nonisolated struct DeletePreview: Decodable, Equatable, Sendable {
    struct File: Decodable, Equatable, Sendable {
        let name: String
        let pages: Int
    }

    /// A saved record from it, not removed: it stays or goes, as chosen.
    struct Saved: Decodable, Equatable, Sendable {
        let kind: String
        let id: String
        /// "HbA1c 6.8 %".
        let label: String
        let date: String?
        let replaced: Bool
    }

    let name: String
    let files: [File]
    /// "pages 3–4 of 5", when it is part of what was added.
    let place: String?
    /// Other documents that use its files.
    let others: Int
    /// Readings that wait or run.
    let readings: Int
    /// Draft items not saved yet.
    let unsaved: Int
    let saved: [Saved]
    let version: String
}

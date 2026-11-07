import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Where documents are added from: the chat box's paperclip and Documents'
/// Add offer the same three.
enum AddFrom: Hashable {
    case photos, files, camera

    /// The three choices, for a menu.
    @ViewBuilder
    static func choices(_ choose: @escaping (AddFrom) -> Void) -> some View {
        Button("Photos", systemImage: "photo.on.rectangle") { choose(.photos) }
        Button("Files", systemImage: "folder") { choose(.files) }
        Button("Camera", systemImage: "camera") { choose(.camera) }
    }
}

extension View {
    /// Adds documents from where `from` says, then sets it back to none:
    /// Photos and Files read what was chosen, two or more photos ask first
    /// whether they are one document, and the camera scans one.
    func addingDocuments(shell: Shell, from: Binding<AddFrom?>) -> some View {
        modifier(AddingDocuments(shell: shell, from: from))
    }
}

private struct AddingDocuments: ViewModifier {
    let shell: Shell
    @Binding var from: AddFrom?
    @State private var picked: [PhotosPickerItem] = []
    /// Two or more photos, waiting to be added as one document or each its own.
    @State private var grouping: [Door.Upload] = []

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: showing(.photos), selection: $picked, maxSelectionCount: 20, matching: .images)
            .onChange(of: picked) { _, items in
                guard !items.isEmpty else { return }
                picked = []
                Task { await chose(await Chosen.photos(items)) }
            }
            .fileImporter(isPresented: showing(.files), allowedContentTypes: [.pdf, .jpeg, .png, .heic, .heif],
                          allowsMultipleSelection: true) { result in
                switch result {
                case let .success(urls): Task { await chose(Chosen.files(urls)) }
                case .failure: Task { await chose(nil) }
                }
            }
            .onChange(of: from) { _, now in
                guard now == .camera else { return }
                from = nil
                shell.scan()
            }
            .confirmationDialog("Add \(grouping.count) photos", isPresented: groupingShown, titleVisibility: .visible) {
                Button("\(grouping.count) photos → one document") { add(grouping, together: true) }
                Button("\(grouping.count) documents") { add(grouping, together: false) }
            } message: {
                Text("Usually one report, photographed page by page.")
            }
    }

    private func showing(_ place: AddFrom) -> Binding<Bool> {
        Binding { from == place } set: { if !$0, from == place { from = nil } }
    }

    private var groupingShown: Binding<Bool> {
        Binding { !grouping.isEmpty } set: { if !$0 { grouping = [] } }
    }

    /// Files chosen: added now, or first asked how when two or more are photos.
    /// When one couldn't be read, none are added: a report must not go in
    /// part, so the person chooses them again.
    private func chose(_ files: [Door.Upload]?) async {
        guard let files else {
            shell.addProblem = "Rufi couldn't read one of them, so it added none. Choose them again."
            return
        }
        guard !files.isEmpty else { return }
        if files.filter({ $0.type.hasPrefix("image/") }).count >= 2 {
            grouping = files
        } else {
            add(files, together: true)
        }
    }

    private func add(_ files: [Door.Upload], together: Bool) {
        grouping = []
        Task { await shell.attach(files, together: together) }
    }
}

/// What the person chose in Photos or Files, read into memory: all of it,
/// or nothing when one couldn't be read.
enum Chosen {
    /// The chosen photos as they are kept, named by their kind.
    static func photos(_ items: [PhotosPickerItem]) async -> [Door.Upload]? {
        var files: [Door.Upload] = []
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
            let type = item.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
            files.append(Door.Upload(name: "Photo \(index + 1).\(type.preferredFilenameExtension ?? "jpg")",
                                     type: type.preferredMIMEType ?? "image/jpeg", data: data))
        }
        return files
    }

    /// The chosen files, read while Files lets the app see them.
    static func files(_ urls: [URL]) -> [Door.Upload]? {
        var files: [Door.Upload] = []
        for url in urls {
            let seen = url.startAccessingSecurityScopedResource()
            defer { if seen { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return nil }
            let type = UTType(filenameExtension: url.pathExtension) ?? .data
            files.append(Door.Upload(name: url.lastPathComponent,
                                     type: type.preferredMIMEType ?? "application/octet-stream", data: data))
        }
        return files
    }
}

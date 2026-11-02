import SwiftUI
import VisionKit

/// VisionKit's document camera: it finds the paper's edges, straightens each
/// page, and gives them back on Save, as JPEG in memory, never on disk.
/// Cancelled or failed, no pages.
struct DocumentCamera: UIViewControllerRepresentable {
    let done: ([Data]) -> Void

    static var available: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let camera = VNDocumentCameraViewController()
        camera.delegate = context.coordinator
        return camera
    }

    func updateUIViewController(_ camera: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(done: done)
    }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let done: ([Data]) -> Void

        init(done: @escaping ([Data]) -> Void) {
            self.done = done
        }

        func documentCameraViewController(_ camera: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            done((0..<scan.pageCount).compactMap { scan.imageOfPage(at: $0).jpegData(compressionQuality: 0.8) })
        }

        func documentCameraViewControllerDidCancel(_ camera: VNDocumentCameraViewController) {
            done([])
        }

        func documentCameraViewController(_ camera: VNDocumentCameraViewController, didFailWithError error: any Error) {
            done([])
        }
    }
}

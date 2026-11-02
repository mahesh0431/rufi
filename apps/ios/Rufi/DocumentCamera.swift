import SwiftUI
import VisionKit

/// VisionKit's document camera: it finds the paper's edges, straightens each
/// page, and gives them back on Save, as JPEG in memory, never on disk.
struct DocumentCamera: UIViewControllerRepresentable {
    /// How the camera ended.
    enum Scan: Equatable {
        /// Every page, in order.
        case pages([Data])
        /// The person tapped Cancel.
        case cancelled
        /// The camera failed, or a page couldn't become a JPEG: no pages.
        case failed
    }

    let done: (Scan) -> Void

    static var available: Bool { VNDocumentCameraViewController.isSupported }

    /// Every page as JPEG, in order; nil when any page can't become one, so a
    /// report is never added with a page missing.
    static func jpegs(count: Int, page: (Int) -> UIImage) -> [Data]? {
        var pages: [Data] = []
        for index in 0..<count {
            // One full-size page at a time in memory, besides the JPEGs.
            guard let jpeg = autoreleasepool(invoking: { page(index).jpegData(compressionQuality: 0.8) }) else {
                return nil
            }
            pages.append(jpeg)
        }
        return pages
    }

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
        let done: (Scan) -> Void

        init(done: @escaping (Scan) -> Void) {
            self.done = done
        }

        func documentCameraViewController(_ camera: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            done(jpegs(count: scan.pageCount, page: scan.imageOfPage(at:)).map(Scan.pages) ?? .failed)
        }

        func documentCameraViewControllerDidCancel(_ camera: VNDocumentCameraViewController) {
            done(.cancelled)
        }

        func documentCameraViewController(_ camera: VNDocumentCameraViewController, didFailWithError error: any Error) {
            done(.failed)
        }
    }
}

import Testing
import UIKit
@testable import Rufi

/// A scan is added whole, in order, or not at all: a page that can't become
/// a JPEG fails the scan, rather than leaving a gap in the report.
struct DocumentCameraTests {
    @Test func everyPageInOrderOrNone() {
        // Pages told apart by their width.
        let pages = [8, 9, 10].map(Self.paper)
        let jpegs = DocumentCamera.jpegs(count: 3, page: { pages[$0] })
        #expect(jpegs?.map { UIImage(data: $0)?.size.width } == [8, 9, 10])

        // UIImage() has no pixels, so it has no JPEG.
        let broken = [pages[0], UIImage(), pages[2]]
        #expect(DocumentCamera.jpegs(count: 3, page: { broken[$0] }) == nil)
    }

    private static func paper(width: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let size = CGSize(width: width, height: 8)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }
}

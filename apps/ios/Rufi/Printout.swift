import UIKit
import WebKit

/// The page open in a web view as an A4 PDF, as iOS prints it: the page's
/// own print styles (apps/web/src/styles.css, `@page` and `@media print`),
/// on sheets with the page's margins, each with its number at its foot.
/// WebKit doesn't draw the CSS page numbers on iOS, so the renderer draws
/// them, as the Mac's print does.
enum Printout {
    /// An A4 sheet, in points.
    nonisolated static let sheet = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)

    static func pdf(of view: WKWebView) async -> Data {
        // Off the main thread, as iOS's print system draws: there, WebKit
        // waits for the page's printout; on the main thread it draws none.
        // The first count lays the page out for print and gives one page;
        // a fresh formatter then counts that layout's pages.
        nonisolated(unsafe) let first = view.viewPrintFormatter()
        _ = await Task.detached { Pages(first).numberOfPages }.value
        nonisolated(unsafe) let formatter = view.viewPrintFormatter()
        return await Task.detached { draw(Pages(formatter)) }.value
    }

    private nonisolated static func draw(_ pages: Pages) -> Data {
        let count = pages.numberOfPages
        pages.prepare(forDrawingPages: NSRange(location: 0, length: count))
        return UIGraphicsPDFRenderer(bounds: sheet).pdfData { context in
            for page in 0..<count {
                context.beginPage()
                pages.drawPage(at: page, in: sheet)
            }
        }
    }

    /// A4 sheets with the print styles' margins (16 mm, 18 mm at the foot),
    /// the number in the foot's margin.
    private nonisolated final class Pages: UIPrintPageRenderer {
        private static let millimetre = 72 / 25.4

        init(_ formatter: UIPrintFormatter) {
            super.init()
            addPrintFormatter(formatter, startingAtPageAt: 0)
        }

        override var paperRect: CGRect { Printout.sheet }

        override var printableRect: CGRect {
            let side = 16 * Self.millimetre
            return CGRect(x: side, y: side, width: Printout.sheet.width - 2 * side,
                          height: Printout.sheet.height - side - 18 * Self.millimetre)
        }

        override func drawPage(at index: Int, in rect: CGRect) {
            super.drawPage(at: index, in: rect)
            let words = NSAttributedString(string: "Page \(index + 1) of \(numberOfPages)", attributes: [
                .font: UIFont.systemFont(ofSize: 9 * 0.75),
                // The brand's quieter text on paper (packages/brand/tokens.css --muted).
                .foregroundColor: UIColor(red: 0x67 / 255, green: 0x67 / 255, blue: 0x67 / 255, alpha: 1),
            ])
            let size = words.size()
            let printable = printableRect
            let foot = printable.maxY + (rect.maxY - printable.maxY - size.height) / 2
            words.draw(at: CGPoint(x: printable.maxX - size.width, y: foot))
        }
    }
}

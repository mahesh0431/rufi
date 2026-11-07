import Foundation
import PDFKit
import UIKit
import Testing
import WebKit
@testable import Rufi

/// A page's printout: its print styles, on numbered A4 sheets.
struct PrintoutTests {
    @Test func aLongPageIsPrintedOnNumberedA4SheetsWithItsPrintStyles() async throws {
        // As in the app, the web view is on screen, in a window.
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
        window.addSubview(view)
        window.isHidden = false
        defer { window.isHidden = true }
        let rows = (1...120).map { "<p>Fictional line \($0)</p>" }.joined()
        view.loadHTMLString("""
            <html><head><style>
              @media print { .screen { display: none } }
              @media screen { .paper { display: none } }
            </style></head><body>
              <p class="screen">On the screen only</p><p class="paper">On paper only</p>\(rows)
            </body></html>
            """, baseURL: nil)
        for _ in 0..<100 {
            if (try? await view.evaluateJavaScript("document.readyState")) as? String == "complete" { break }
            try await Task.sleep(for: .milliseconds(50))
        }

        let printed = try #require(PDFDocument(data: await Printout.pdf(of: view)))
        #expect(printed.pageCount > 1)
        let first = try #require(printed.page(at: 0))
        let size = first.bounds(for: .mediaBox).size
        #expect(abs(size.width - 595.28) < 1 && abs(size.height - 841.89) < 1)
        let text = try #require(first.string)
        #expect(text.contains("On paper only"))
        #expect(!text.contains("On the screen only"))
        #expect(text.contains("Page 1 of \(printed.pageCount)"))
        #expect(printed.page(at: printed.pageCount - 1)?.string?
            .contains("Page \(printed.pageCount) of \(printed.pageCount)") == true)
    }
}

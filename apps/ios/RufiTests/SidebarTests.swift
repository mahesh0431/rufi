import Testing
import UIKit
@testable import Rufi

/// A swipe right on a page's table or chart that scrolls sideways scrolls it
/// back first; at its start, or on anything else, it opens the sidebar.
@MainActor
struct SidebarTests {
    @Test func aSidewaysScrollerKeepsTheSwipeUntilItIsBackAtItsStart() {
        let page = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let table = UIScrollView(frame: CGRect(x: 0, y: 100, width: 400, height: 200))
        table.contentSize = CGSize(width: 900, height: 200)
        let cell = UIView(frame: CGRect(x: 0, y: 0, width: 120, height: 40))
        table.addSubview(cell)
        page.addSubview(table)

        table.contentOffset.x = 240
        #expect(SidebarSwipe.scrollsBack(cell))
        table.contentOffset.x = 0
        #expect(!SidebarSwipe.scrollsBack(cell))
        #expect(!SidebarSwipe.scrollsBack(page))
    }
}

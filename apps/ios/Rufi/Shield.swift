import SwiftUI
import UIKit

/// Above everything Rufi shows, sheets, Quick Look and iOS's pickers too: a
/// window of its own that hides the screen whenever Rufi isn't active, so
/// the app switcher shows nothing, and holds the lock screen while Rufi is
/// locked, so nothing under it can be read or touched. Rufi's screens stay
/// alive underneath, with what was typed.
final class Shield {
    private var window: UIWindow?

    func show(_ shown: Bool, app: AppModel) {
        if window == nil, shown,
           let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            let window = UIWindow(windowScene: scene)
            window.windowLevel = .alert + 1
            window.overrideUserInterfaceStyle = Appearance.chosen.style
            window.rootViewController = UIHostingController(rootView: ShieldView(app: app))
            self.window = window
        }
        window?.isHidden = !shown
    }

    /// Light or dark was chosen on this iPhone: the lock's window takes it too.
    func appearance(_ appearance: Appearance) {
        window?.overrideUserInterfaceStyle = appearance.style
    }
}

/// The lock screen when Rufi is locked; otherwise a plain page.
private struct ShieldView: View {
    let app: AppModel

    var body: some View {
        if app.lock.locked {
            LockedView(lock: app.lock)
        } else {
            Color(.systemBackground).ignoresSafeArea()
        }
    }
}

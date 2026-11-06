import SwiftUI
import UIKit

/// Light or dark on this iPhone: as the iPhone is set (System), or always
/// one. It is kept on this iPhone; the colour theme is still the Mac's.
/// The pages follow it too, as they follow the iPhone's own.
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark

    static let stored = "appearance"

    var id: Self { self }

    var name: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    /// For SwiftUI: none follows the iPhone.
    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// For a window of its own, such as the lock's.
    var style: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }

    /// The one chosen on this iPhone.
    static var chosen: Appearance {
        UserDefaults.standard.string(forKey: stored).flatMap(Appearance.init) ?? .system
    }
}

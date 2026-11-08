import SwiftUI
import UIKit

/// The colour theme chosen on the Mac, as Rufi's pages last drew it, in
/// light and in dark: the app's own parts (the tint, the sidebar, the
/// sheets, behind the page) take it, so they match the pages. The pages are
/// its only source (apps/web/src/frame.tsx); it is kept for the next start,
/// so Rufi opens in it. Until a page has drawn in light or dark, iOS's own
/// colours.
@Observable
final class Theme {
    /// The theme's colours, as `#rrggbb`.
    struct Colours: Codable, Equatable {
        var page: String
        var side: String
        var surface: String
        var accent: String
        var accentSoft: String
        var accentInk: String
        /// Text and icons on the accent; none in a theme kept before it came.
        var onAccent: String?
    }

    private(set) var light: Colours?
    private(set) var dark: Colours?

    private static let stored = "theme"

    init() {
        let saved = UserDefaults.standard.data(forKey: Self.stored)
            .flatMap { try? JSONDecoder().decode([String: Colours].self, from: $0) }
        light = saved?["light"]
        dark = saved?["dark"]
    }

    /// A page drew in these colours, in dark or light.
    func took(_ colours: Colours, dark: Bool) {
        if dark {
            guard colours != self.dark else { return }
            self.dark = colours
        } else {
            guard colours != light else { return }
            light = colours
        }
        var kept: [String: Colours] = [:]
        kept["light"] = light
        kept["dark"] = self.dark
        UserDefaults.standard.set(try? JSONEncoder().encode(kept), forKey: Self.stored)
    }

    var page: Color { colour(\.page, or: .systemBackground) }
    var side: Color { colour(\.side, or: .systemGroupedBackground) }
    /// The iPhone's sidebar: in light, halfway from the theme's sidebar grey
    /// to its surface white, a very light off-white, so the page beside it
    /// stands out less; in dark, the sidebar's colour.
    var sidebar: Color {
        let side = uiColour(\.side, or: .systemGroupedBackground)
        let surface = uiColour(\.surface, or: .secondarySystemGroupedBackground)
        return Color(uiColor: UIColor { @Sendable traits in
            let grey = side.resolvedColor(with: traits)
            guard traits.userInterfaceStyle != .dark else { return grey }
            let white = surface.resolvedColor(with: traits)
            var (r1, g1, b1, r2, g2, b2, a): (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat) =
                (0, 0, 0, 0, 0, 0, 0)
            grey.getRed(&r1, green: &g1, blue: &b1, alpha: &a)
            white.getRed(&r2, green: &g2, blue: &b2, alpha: &a)
            return UIColor(red: (r1 + r2) / 2, green: (g1 + g2) / 2, blue: (b1 + b2) / 2, alpha: 1)
        })
    }
    var surface: Color { colour(\.surface, or: .secondarySystemGroupedBackground) }
    // Not iOS's tint: that is this colour, once the app takes it.
    var accent: Color { colour(\.accent, or: UIColor(named: "AccentColor") ?? .systemBlue) }
    var accentSoft: Color { colour(\.accentSoft, or: .tertiarySystemFill) }
    var accentInk: Color { colour(\.accentInk, or: .label) }
    var onAccent: Color { colour(\.onAccent, or: .white) }

    /// Behind the page, in UIKit's terms.
    var pageColour: UIColor { uiColour(\.page, or: .systemBackground) }

    private func colour(_ key: (Colours) -> String?, or fallback: UIColor) -> Color {
        Color(uiColor: uiColour(key, or: fallback))
    }

    private func uiColour(_ key: (Colours) -> String?, or fallback: UIColor) -> UIColor {
        let light = light.flatMap { key($0) }.flatMap { UIColor(hex: $0) }
        let dark = dark.flatMap { key($0) }.flatMap { UIColor(hex: $0) }
        // SwiftUI can resolve it off the main thread: it holds only colours.
        return UIColor { @Sendable traits in
            (traits.userInterfaceStyle == .dark ? dark : light) ?? fallback.resolvedColor(with: traits)
        }
    }
}

extension UIColor {
    /// `#rrggbb`; none for anything else.
    convenience init?(hex: String) {
        let digits = hex.trimmingCharacters(in: .whitespaces)
        guard digits.count == 7, digits.hasPrefix("#"), let value = UInt32(digits.dropFirst(), radix: 16)
        else { return nil }
        self.init(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                  blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
}

extension View {
    /// A settings sheet in the theme, grouped as iOS draws it: the
    /// sidebar's colour behind, its rows on the surface's.
    func themed(_ theme: Theme) -> some View {
        scrollContentBackground(.hidden)
            .background(theme.side)
    }
}

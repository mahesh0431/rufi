import SwiftUI
import UIKit

/// The page as one card over the sidebar: to show the sidebar, the card
/// slides right, its corners rounded as the screen's, and the sidebar comes
/// in under it from a little to the left, as the chat apps on the iPhone do.
/// Apple has no sidebar on the iPhone, so this is Rufi's own. A swipe right
/// opens it, on a place's own page only (`enabled`): on a page opened on top,
/// the same swipe is Back.
/// A swipe left, or a tap on the page beside it, closes it. The card follows
/// the finger and settles with the swipe's speed, never past either end.
/// `side` is the sidebar's colour: behind the card, and, as the card goes,
/// what it fades into, so the sidebar reads as the view.
struct Drawer<Content: View, Sidebar: View>: View {
    @Binding var open: Bool
    let enabled: Bool
    let side: Color
    @ViewBuilder let content: Content
    @ViewBuilder let sidebar: Sidebar
    /// How far out the card is while a finger moves it, from 0 to 1.
    @State private var dragged: CGFloat?
    /// The swipe's speed as it let go, in widths a second.
    @State private var speed: Double = 0

    /// How long the card takes to settle, with no bounce.
    private static var settling: Double { 0.4 }

    var body: some View {
        GeometryReader { geometry in
            let width = Self.reveal(geometry.size.width)
            let out = dragged ?? (open ? 1 : 0)
            ZStack(alignment: .leading) {
                sidebar
                    .frame(width: width)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .accessibilityElement(children: .contain)
                    .accessibilityAddTraits(open ? .isModal : [])
                    .accessibilityAction(.escape) { open = false }
                    .animation(dragged == nil ? settle : nil) {
                        $0.modifier(Uncovered(out: out, width: width))
                    }
                content
                    .overlay {
                        if open {
                            Color.clear
                                .contentShape(.rect)
                                .onTapGesture { open = false }
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityHidden(open)
                    .animation(dragged == nil ? settle : nil) {
                        $0.modifier(Slide(out: out, width: width))
                    }
                // The fade, its own layer over the card: drawn inside the card,
                // over its bars and web page, it blanked the card for some frames
                // each time the card stopped.
                Slide.rounded
                    .fill(side)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .animation(dragged == nil ? settle : nil) {
                        $0.opacity(0.5 * out).offset(x: width * out)
                    }
            }
            .background(side.ignoresSafeArea())
            .gesture(SidebarSwipe(open: open, enabled: enabled) { moved in
                if dragged == nil, !open { Self.putKeyboardAway() }
                dragged = min(max((open ? 1 : 0) + moved / width, 0), 1)
            } ended: { moved, velocity in
                let start: CGFloat = open ? 1 : 0
                let shown = start + (moved + velocity * 0.2) / width > 0.5
                let left = abs((shown ? 1 : 0) - (dragged ?? start))
                // Toward where it settles, and no faster than a spring with no
                // bounce takes without passing the end.
                let toward = (shown ? 1 : -1) * velocity / width
                speed = left > 0.01 ? min(max(toward / left, 0), 2 * .pi / Self.settling) : 0
                dragged = nil
                open = shown
            })
            .onChange(of: out) { if dragged == nil { speed = 0 } }
            .onChange(of: open) { _, open in if open { Self.putKeyboardAway() } }
        }
    }

    private var settle: Animation {
        .interpolatingSpring(duration: Self.settling, bounce: 0, initialVelocity: speed)
    }

    /// How far the card slides: the page's right quarter or so stays in sight.
    static func reveal(_ width: CGFloat) -> CGFloat {
        (width * 0.78).rounded()
    }

    private static func putKeyboardAway() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// The sidebar is there only while the card is out, so nothing reaches it
/// under the page: no tap, and no screen reader. It moves with the card, a
/// third as far, so it starts a third of `width` to the left and reaches its
/// place as the card is all the way out; with Reduce Motion, it stays still.
private struct Uncovered: ViewModifier, Animatable {
    var out: CGFloat
    let width: CGFloat
    @Environment(\.accessibilityReduceMotion) private var still

    var animatableData: CGFloat {
        get { out }
        set { out = newValue }
    }

    func body(content: Content) -> some View {
        if out > 0 { content.offset(x: still ? 0 : -(1 - min(out, 1)) * width / 3) }
    }
}

/// The card at `out`, from 0 (closed) to 1: held between the two, so even a
/// fast swipe never leaves a gap; once it moves, rounded as the screen is
/// (at least as the smallest iPhone screen corners are). No shadow: the fade
/// over it marks it off the sidebar.
private struct Slide: ViewModifier, Animatable {
    var out: CGFloat
    let width: CGFloat

    static let rounded = ConcentricRectangle(corners: .concentric(minimum: .fixed(47)), isUniform: true)

    var animatableData: CGFloat {
        get { out }
        set { out = newValue }
    }

    func body(content: Content) -> some View {
        let out = min(max(out, 0), 1)
        let shape = out > 0 ? AnyShape(Self.rounded) : AnyShape(Rectangle())
        // To the screen's edges, as the bars reach under the status bar.
        content
            .mask { shape.ignoresSafeArea() }
            .background {
                shape.fill(.background).ignoresSafeArea()
            }
            .offset(x: width * out)
    }
}

/// The swipe that opens and closes the sidebar, in UIKit so the page's own
/// scrollers come first: one that can still scroll back left keeps a swipe
/// right; up and down are the page's.
struct SidebarSwipe: UIGestureRecognizerRepresentable {
    let open: Bool
    let enabled: Bool
    let moved: (CGFloat) -> Void
    let ended: (_ moved: CGFloat, _ velocity: CGFloat) -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var open = false
        var enabled = false
        private var touched: UIView?

        func gestureRecognizer(_: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            touched = touch.view
            return true
        }

        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            // By the way it moved so far: a slow drag has next to no speed.
            let moved = pan.translation(in: nil)
            guard abs(moved.x) > abs(moved.y) else { return false }
            if open { return moved.x < 0 }
            return enabled && moved.x > 0 && !SidebarSwipe.scrollsBack(touched)
        }

        // Scrollers wait until it is clear the swipe isn't the sidebar's.
        func gestureRecognizer(_: UIGestureRecognizer,
                               shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other is UIPanGestureRecognizer && other.view is UIScrollView
        }
    }

    func makeCoordinator(converter _: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func updateUIGestureRecognizer(_ pan: UIPanGestureRecognizer, context: Context) {
        context.coordinator.open = open
        context.coordinator.enabled = enabled
        pan.isEnabled = open || enabled
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context _: Context) {
        let moved = pan.translation(in: nil).x
        switch pan.state {
        case .began, .changed: self.moved(moved)
        case .ended: ended(moved, pan.velocity(in: nil).x)
        case .cancelled, .failed: ended(0, 0)
        default: break
        }
    }

    /// `view` is in a scroller that is scrolled sideways and can go back left.
    static func scrollsBack(_ view: UIView?) -> Bool {
        var view = view
        while let at = view {
            if let scroller = at as? UIScrollView, scroller.contentSize.width > scroller.bounds.width + 1,
               scroller.contentOffset.x > -scroller.adjustedContentInset.left + 1 {
                return true
            }
            view = at.superview
        }
        return false
    }
}

/// The Mac's places in the Mac's order, with its counts (empty record pages
/// grey), under Rufi; at the bottom, Chat and the person's initials, which
/// open This iPhone.
struct SidebarView: View {
    let name: String
    /// The place the page on top is in, marked.
    let current: Place?
    let counts: Door.Counts?
    let theme: Theme
    let choose: (Place) -> Void
    let thisIPhone: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(decorative: "Dog").resizable().scaledToFit().frame(width: 34, height: 34)
                        .clipShape(.rect(cornerRadius: 8))
                    Text("Rufi").font(.title.bold())
                }
                .padding(.top, 8)
                .padding(.bottom, 12)
                row(.overview)
                Text("Health record")
                    .foregroundStyle(.secondary)
                    .padding(.top, 20)
                    .padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                ForEach(Place.record, id: \.self) { row($0) }
                Spacer().frame(height: 20)
                row(.followUps)
                row(.documents)
                Spacer().frame(height: 20)
                row(.help)
            }
            .padding(.horizontal, 24)
        }
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button {
                    choose(.chat)
                } label: {
                    Label("Chat", systemImage: Place.chat.symbol).font(.headline)
                        .foregroundStyle(theme.onAccent)
                }
                .buttonStyle(.glassProminent)
                .tint(theme.accent)
                .controlSize(.large)
                .accessibilityLabel(Place.chat.title)
                .accessibilityAddTraits(current == .chat ? .isSelected : [])
                Spacer()
                Button(action: thisIPhone) {
                    Initials(name: name, size: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("\(name), This iPhone")
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 4)
        }
        .background(theme.side, ignoresSafeAreaEdges: .all)
    }

    private func row(_ place: Place) -> some View {
        let count = counts?.of(place)
        let empty = count == 0 && Place.record.contains(place)
        let marked = current == place
        return Button {
            choose(place)
        } label: {
            HStack(spacing: 16) {
                Image(systemName: place.symbol).imageScale(.large).frame(width: 28)
                Text(place.title).fontWeight(marked ? .semibold : .regular)
                Spacer()
                if let count, count > 0 {
                    Text("\(count)").foregroundStyle(.secondary).monospacedDigit()
                }
            }
            .padding(.vertical, 13)
            .foregroundStyle(marked ? theme.accentInk : empty ? Color(.secondaryLabel) : Color(.label))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(marked ? .isSelected : [])
    }
}

/// The person's picture: their initials, until Rufi has a photo of them.
struct Initials: View {
    let name: String
    let size: CGFloat
    // The theme's own accent: a list's rows don't always take the tint.
    @Environment(Theme.self) private var theme

    var body: some View {
        Text(letters)
            .font(.system(size: size * 0.38, weight: .semibold))
            .foregroundStyle(theme.accent)
            .frame(width: size, height: size)
            .background(theme.accent.opacity(0.18), in: .circle)
            .accessibilityHidden(true)
    }

    private var letters: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

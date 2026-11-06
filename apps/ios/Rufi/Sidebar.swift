import SwiftUI

/// The sidebar sliding in from the left over the page, with the page dimmed
/// beside it. Apple has no drawer on the iPhone, so this is Rufi's own; the
/// list in it is Apple's. A swipe from the left edge opens it and it follows
/// the finger, only on a place's own page (`enabled`): on a page opened on
/// top, the same swipe is Back. A swipe left on it, or a tap on the page
/// beside it, closes it.
struct Drawer<Content: View, Sidebar: View>: View {
    @Binding var open: Bool
    let enabled: Bool
    @ViewBuilder let content: Content
    @ViewBuilder let sidebar: Sidebar
    /// How far out it is while a finger moves it, from 0 to 1.
    @State private var dragged: CGFloat?

    var body: some View {
        GeometryReader { geometry in
            let width = min(330, geometry.size.width * 0.84)
            let out = dragged ?? (open ? 1 : 0)
            ZStack(alignment: .leading) {
                content
                if out > 0 {
                    Color.black.opacity(0.25 * out)
                        .ignoresSafeArea()
                        .onTapGesture { close() }
                        .gesture(closing(width))
                        .accessibilityHidden(true)
                    sidebar
                        .frame(width: width)
                        .background(Color(.systemGroupedBackground), ignoresSafeAreaEdges: .all)
                        .offset(x: (out - 1) * width)
                        .gesture(closing(width))
                        .accessibilityAddTraits(.isModal)
                        .accessibilityAction(.escape) { close() }
                }
                if enabled, !open {
                    Color.clear
                        .frame(width: 16)
                        .contentShape(.rect)
                        .ignoresSafeArea()
                        .gesture(opening(width))
                }
            }
        }
    }

    private func close() {
        withAnimation(.snappy) { open = false }
    }

    private func opening(_ width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { drag in dragged = min(max(drag.translation.width / width, 0), 1) }
            .onEnded { drag in settle(drag.predictedEndTranslation.width / width > 0.5) }
    }

    private func closing(_ width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { drag in dragged = min(max(1 + drag.translation.width / width, 0), 1) }
            .onEnded { drag in settle(1 + drag.predictedEndTranslation.width / width > 0.5) }
    }

    private func settle(_ shown: Bool) {
        withAnimation(.snappy) {
            open = shown
            dragged = nil
        }
    }
}

/// The Mac's places in the Mac's order, with its counts (empty record pages
/// grey); the dog and Rufi at the top; the person and This iPhone at the
/// bottom.
struct SidebarView: View {
    let name: String
    /// The place the page on top is in, marked.
    let current: Place?
    let counts: Door.Counts?
    let choose: (Place) -> Void
    let thisIPhone: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image("Dog").resizable().scaledToFit().frame(width: 40, height: 40)
                    .clipShape(.rect(cornerRadius: 10))
                    .accessibilityHidden(true)
                Text("Rufi").font(.title2.bold())
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 4)
            List {
                Section {
                    row(.chat)
                    row(.overview)
                }
                Section("Health record") {
                    ForEach(Place.record, id: \.self) { row($0) }
                }
                Section {
                    row(.followUps)
                    row(.documents)
                }
                Section {
                    row(.help)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            Button(action: thisIPhone) {
                HStack(spacing: 12) {
                    Initials(name: name, size: 40)
                    VStack(alignment: .leading) {
                        Text(name).font(.headline)
                        Text("This iPhone").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                }
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
    }

    private func row(_ place: Place) -> some View {
        let count = counts?.of(place)
        let empty = count == 0 && Place.record.contains(place)
        return Button {
            choose(place)
        } label: {
            HStack {
                Label(place.title, systemImage: place.symbol)
                Spacer()
                if let count, count > 0 {
                    Text("\(count)").foregroundStyle(.secondary).monospacedDigit()
                }
            }
            .foregroundStyle(empty ? .secondary : .primary)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(current == place
            ? RoundedRectangle(cornerRadius: 12).fill(.fill.secondary).padding(.horizontal, 8)
            : nil)
        .accessibilityAddTraits(current == place ? .isSelected : [])
    }
}

/// The person's picture: their initials, until Rufi has a photo of them.
struct Initials: View {
    let name: String
    let size: CGFloat

    var body: some View {
        Text(letters)
            .font(.system(size: size * 0.38, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .frame(width: size, height: size)
            .background(Color.accentColor.opacity(0.18), in: .circle)
            .accessibilityHidden(true)
    }

    private var letters: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

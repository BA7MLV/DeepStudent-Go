import SwiftUI

struct StudyView: View {
    private let resources = [
        StudyResource(title: "Flashcards", subtitle: "12 due today", icon: "rectangle.stack.fill", tint: .orange),
        StudyResource(title: "Practice tasks", subtitle: "3 in progress", icon: "checkmark.square.fill", tint: .blue),
        StudyResource(title: "Saved explanations", subtitle: "18 notes", icon: "bookmark.fill", tint: .purple),
        StudyResource(title: "Templates", subtitle: "Start a focused session", icon: "square.grid.2x2.fill", tint: .green)
    ]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Keep your momentum")
                        .font(.title2.weight(.bold))
                    Text("Pick up a small next step or review something saved.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    ForEach(resources) { resource in
                        ResourceCard(resource: resource)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Label("Suggested next", systemImage: "sparkles")
                        .font(.headline)
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Explain one idea in your own words")
                                .font(.body.weight(.semibold))
                            Text("A two-minute retrieval prompt from your recent physics session")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.secondary)
                    }
                    .padding(14)
                    .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Study")
    }
}

private struct StudyResource: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    let icon: String
    let tint: Color
}

private struct ResourceCard: View {
    let resource: StudyResource

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: resource.icon)
                .font(.title3)
                .foregroundStyle(resource.tint)
            Text(resource.title)
                .font(.headline)
            Text(resource.subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 115, alignment: .leading)
        .padding(14)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

import Foundation

// Small deterministic fixtures keep the shell reviewable without a backend or login.
enum FixtureData {
    static func sessions(now: Date = .now) -> [StudySession] {
        [
            StudySession(
                id: "session-kinematics",
                title: "Newton's laws, intuitively",
                topic: "Physics · Mechanics",
                preview: "Try thinking of force as a change in motion…",
                lastActivity: now.addingTimeInterval(-12 * 60),
                status: .active,
                unreadCount: 2,
                isPinned: true,
                messages: [
                    ChatMessage(role: .user, content: "Can you explain Newton's second law without starting with equations?", createdAt: now.addingTimeInterval(-17 * 60)),
                    ChatMessage(role: .assistant, content: "Think of a shopping cart. A harder push changes its motion more; a heavier cart changes less for the same push. The equation is a compact way to say that story.", createdAt: now.addingTimeInterval(-16 * 60)),
                    ChatMessage(role: .user, content: "So acceleration is the change, and mass is the resistance?", createdAt: now.addingTimeInterval(-13 * 60)),
                    ChatMessage(role: .assistant, content: "Exactly. Force is the push, mass is the inertia, and acceleration is how quickly the motion changes.", createdAt: now.addingTimeInterval(-12 * 60))
                ]
            ),
            StudySession(
                id: "session-french",
                title: "French conversation warm-up",
                topic: "Languages · French",
                preview: "Your next prompt: describe a weekend you remember",
                lastActivity: now.addingTimeInterval(-48 * 60),
                status: .waiting,
                unreadCount: 0,
                isPinned: false,
                messages: [
                    ChatMessage(role: .user, content: "Let's practice passé composé.", createdAt: now.addingTimeInterval(-52 * 60)),
                    ChatMessage(role: .assistant, content: "D'accord. Raconte-moi ton week-end en trois phrases. Je corrigerai seulement ce qui gêne la compréhension.", createdAt: now.addingTimeInterval(-51 * 60))
                ]
            ),
            StudySession(
                id: "session-systems",
                title: "Operating systems review",
                topic: "Computer science · Systems",
                preview: "4 flashcards are ready for a quick review",
                lastActivity: now.addingTimeInterval(-3 * 60 * 60),
                status: .completed,
                unreadCount: 0,
                isPinned: false,
                messages: [
                    ChatMessage(role: .user, content: "What does a page fault mean?", createdAt: now.addingTimeInterval(-3.3 * 60 * 60)),
                    ChatMessage(role: .assistant, content: "The process referenced a virtual page that is not currently mapped in physical memory. The OS can fetch it, update the page table, and retry the instruction.", createdAt: now.addingTimeInterval(-3.2 * 60 * 60))
                ]
            ),
            StudySession(
                id: "session-essay",
                title: "Outline: climate policy brief",
                topic: "Writing · Argument",
                preview: "Draft is ready for your next pass",
                lastActivity: now.addingTimeInterval(-24 * 60 * 60),
                status: .draft,
                unreadCount: 0,
                isPinned: false,
                messages: [
                    ChatMessage(role: .user, content: "Help me turn these notes into a clear policy brief outline.", createdAt: now.addingTimeInterval(-26 * 60 * 60)),
                    ChatMessage(role: .assistant, content: "Start with the decision, then the evidence, trade-offs, and a concrete recommendation. I left open slots for your sources.", createdAt: now.addingTimeInterval(-25 * 60 * 60))
                ]
            )
        ]
    }
}

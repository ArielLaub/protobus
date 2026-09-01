
const processed = new Set<string>();

export async function handleEvent(event: { id: string }): Promise<void> {
    if (processed.has(event.id)) { return; }
    processed.add(event.id);
    // ... do the work
}

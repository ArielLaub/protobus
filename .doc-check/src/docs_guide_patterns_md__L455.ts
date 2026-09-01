
interface Profile { id: string; recommendations: string[]; degraded: boolean; }

export async function buildProfile(
    id: string,
    fetchRecommendations: (id: string) => Promise<string[]>,
): Promise<Profile> {
    try {
        return { id, recommendations: await fetchRecommendations(id), degraded: false };
    } catch {
        return { id, recommendations: [], degraded: true };
    }
}

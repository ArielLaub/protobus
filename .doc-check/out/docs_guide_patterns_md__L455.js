"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildProfile = buildProfile;
async function buildProfile(id, fetchRecommendations) {
    try {
        return { id, recommendations: await fetchRecommendations(id), degraded: false };
    }
    catch {
        return { id, recommendations: [], degraded: true };
    }
}

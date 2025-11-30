import { IContext } from '../../../lib/context';
import { BasePlayer, PlayerState } from '../BasePlayer';

/**
 * Strategy 4: The Equalizer
 * Targets the player with health most similar to their own.
 * "Let's keep things fair and square!"
 */
export class Equalizer extends BasePlayer {
    constructor(context: IContext, playerId: string) {
        super(context, playerId, 'The Equalizer');
    }

    protected chooseTarget(alivePlayers: PlayerState[]): PlayerState | null {
        if (alivePlayers.length === 0) return null;

        // Find player with health closest to our own
        let closest: PlayerState | null = null;
        let smallestDiff = Infinity;

        for (const player of alivePlayers) {
            const diff = Math.abs(player.health - this.health);
            if (diff < smallestDiff) {
                smallestDiff = diff;
                closest = player;
            }
        }

        return closest;
    }
}

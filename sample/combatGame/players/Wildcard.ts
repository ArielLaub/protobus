import { IContext } from '../../../lib/context';
import { BasePlayer, PlayerState } from '../BasePlayer';

/**
 * Strategy 5: The Wildcard
 * Picks a random target every time.
 * "Chaos is a ladder... or something!"
 */
export class Wildcard extends BasePlayer {
    constructor(context: IContext, playerId: string) {
        super(context, playerId, 'The Wildcard');
    }

    protected chooseTarget(alivePlayers: PlayerState[]): PlayerState | null {
        if (alivePlayers.length === 0) return null;

        // Pick randomly
        return alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    }
}

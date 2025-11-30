import { IContext } from '../../../lib/context';
import { BasePlayer, PlayerState } from '../BasePlayer';

/**
 * Strategy 3: The Giant Slayer
 * Always targets the strongest player (highest health).
 * "The bigger they are, the harder they fall!"
 */
export class GiantSlayer extends BasePlayer {
    constructor(context: IContext, playerId: string) {
        super(context, playerId, 'The Giant Slayer');
    }

    protected chooseTarget(alivePlayers: PlayerState[]): PlayerState | null {
        if (alivePlayers.length === 0) return null;

        // Find player with highest health
        return alivePlayers.reduce((strongest, player) =>
            player.health > strongest.health ? player : strongest
        );
    }
}

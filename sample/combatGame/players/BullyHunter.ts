import { IContext } from '../../../lib/context';
import { BasePlayer, PlayerState } from '../BasePlayer';

/**
 * Strategy 2: The Bully Hunter
 * Always targets the weakest player (lowest health).
 * "Pick on someone your own size... wait, I mean pick on the smallest!"
 */
export class BullyHunter extends BasePlayer {
    constructor(context: IContext, playerId: string) {
        super(context, playerId, 'The Bully Hunter');
    }

    protected chooseTarget(alivePlayers: PlayerState[]): PlayerState | null {
        if (alivePlayers.length === 0) return null;

        // Find player with lowest health
        return alivePlayers.reduce((weakest, player) =>
            player.health < weakest.health ? player : weakest
        );
    }
}

import { IContext } from '../../../lib/context';
import { BasePlayer, PlayerState } from '../BasePlayer';

/**
 * Strategy 1: The Vindicator
 * Shoots back at whoever shot them last. If nobody has attacked them yet, picks randomly.
 * "An eye for an eye!"
 */
export class Vindicator extends BasePlayer {
    constructor(context: IContext, playerId: string) {
        super(context, playerId, 'The Vindicator');
    }

    protected chooseTarget(alivePlayers: PlayerState[]): PlayerState | null {
        if (alivePlayers.length === 0) return null;

        // If someone attacked us, shoot them back
        if (this.gameState.lastAttacker) {
            const attacker = alivePlayers.find(p => p.id === this.gameState.lastAttacker);
            if (attacker) {
                return attacker;
            }
        }

        // Otherwise, pick randomly
        return alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    }
}

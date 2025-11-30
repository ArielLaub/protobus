import { IContext } from '../../../lib/context';
import { BasePlayer, PlayerState } from '../BasePlayer';

/**
 * Strategy 6: The Terminator
 * Picks one target and relentlessly attacks until they're dead, then moves on.
 * "I'll be back... for you specifically!"
 */
export class Terminator extends BasePlayer {
    constructor(context: IContext, playerId: string) {
        super(context, playerId, 'The Terminator');
    }

    protected chooseTarget(alivePlayers: PlayerState[]): PlayerState | null {
        if (alivePlayers.length === 0) return null;

        // If we have a focus target and they're still alive, keep shooting
        if (this.gameState.focusTarget) {
            const target = alivePlayers.find(p => p.id === this.gameState.focusTarget);
            if (target) {
                return target;
            }
            // Focus target is dead, clear it
            this.gameState.focusTarget = null;
        }

        // Pick a new focus target (randomly)
        const newTarget = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
        this.gameState.focusTarget = newTarget.id;
        return newTarget;
    }
}

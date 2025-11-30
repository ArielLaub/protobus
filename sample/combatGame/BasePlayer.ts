import * as path from 'path';
import MessageService from '../../lib/message_service';
import { IContext } from '../../lib/context';
import { Logger } from '../../lib/logger';

export interface PlayerState {
    id: string;
    name: string;
    health: number;
    alive: boolean;
}

export interface GameState {
    players: Map<string, PlayerState>;
    playerOrder: string[];
    myIndex: number;
    lastAttacker: string | null;
    focusTarget: string | null;
    gameStarted: boolean;
    gameOver: boolean;
}

export abstract class BasePlayer extends MessageService {
    protected playerId: string;
    protected playerName: string;
    protected health: number = 10;
    protected gameState: GameState;

    constructor(context: IContext, playerId: string, playerName: string) {
        super(context, { maxConcurrent: 1 });
        this.playerId = playerId;
        this.playerName = playerName;
        this.gameState = {
            players: new Map(),
            playerOrder: [],
            myIndex: -1,
            lastAttacker: null,
            focusTarget: null,
            gameStarted: false,
            gameOver: false,
        };
    }

    public get ServiceName(): string {
        return `Combat.Player.${this.playerId}`;
    }

    public get ProtoFileName(): string {
        return path.join(__dirname, 'player.proto');
    }

    public getPlayerId(): string {
        return this.playerId;
    }

    public getPlayerName(): string {
        return this.playerName;
    }

    public async init(): Promise<void> {
        await super.init();
        // Subscribe to game events
        await this.subscribeEvent('Combat.PlayerShot', this.onPlayerShot.bind(this));
        await this.subscribeEvent('Combat.PlayerDied', this.onPlayerDied.bind(this));
        await this.subscribeEvent('Combat.TurnComplete', this.onTurnComplete.bind(this));
        await this.subscribeEvent('Combat.GameOver', this.onGameOver.bind(this));
        await this.subscribeEvent('Combat.GameStarted', this.onGameStarted.bind(this));
        await this.subscribeEvent('Combat.PlayerJoined', this.onPlayerJoined.bind(this));

        // Announce ourselves
        await this.publishEvent('Combat.PlayerJoined', {
            playerId: this.playerId,
            playerName: this.playerName,
            health: this.health,
        });

        Logger.info(`${this.playerName} (${this.playerId}) joined the game`);
    }

    // RPC: Another player shoots at us
    public async shoot(request: { shooterId: string }): Promise<{ hit: boolean; remainingHealth: number }> {
        if (this.health <= 0) {
            return { hit: false, remainingHealth: 0 };
        }

        // 50/50 chance to hit
        const hit = Math.random() < 0.5;

        // Get shooter's name for logging
        const shooter = this.gameState.players.get(request.shooterId);
        const shooterName = shooter?.name || request.shooterId;

        if (hit) {
            this.health--;
            this.gameState.lastAttacker = request.shooterId;
            Logger.info(`${this.playerName} was hit by ${shooterName}! Health: ${this.health}`);

            // Publish shot event
            await this.publishEvent('Combat.PlayerShot', {
                shooterId: request.shooterId,
                targetId: this.playerId,
                hit: true,
                targetHealth: this.health,
            });

            if (this.health <= 0) {
                Logger.info(`${this.playerName} has been eliminated!`);
                await this.publishEvent('Combat.PlayerDied', {
                    playerId: this.playerId,
                    killedBy: request.shooterId,
                });
            }
        } else {
            Logger.info(`${this.playerName} dodged attack from ${shooterName}!`);
            await this.publishEvent('Combat.PlayerShot', {
                shooterId: request.shooterId,
                targetId: this.playerId,
                hit: false,
                targetHealth: this.health,
            });
        }

        return { hit, remainingHealth: this.health };
    }

    // RPC: Start the game
    public async initiateGame(request: { playerOrder: string[]; myIndex: number }): Promise<{ success: boolean }> {
        this.gameState.playerOrder = request.playerOrder;
        this.gameState.myIndex = request.myIndex;
        this.gameState.gameStarted = true;

        Logger.info(`${this.playerName} received game initiation. Order: ${request.playerOrder.join(', ')}, My turn index: ${request.myIndex}`);

        // If we're first (index 0), take our turn
        if (request.myIndex === 0) {
            await this.takeTurn();
        }

        return { success: true };
    }

    // RPC: Get current status
    public async getStatus(): Promise<{ playerId: string; playerName: string; health: number; alive: boolean }> {
        return {
            playerId: this.playerId,
            playerName: this.playerName,
            health: this.health,
            alive: this.health > 0,
        };
    }

    // Event handlers
    protected async onPlayerJoined(event: { playerId: string; playerName: string; health: number }): Promise<void> {
        // Track all OTHER players (not ourselves)
        if (event.playerId !== this.playerId) {
            this.gameState.players.set(event.playerId, {
                id: event.playerId,
                name: event.playerName,
                health: event.health,
                alive: true,
            });
            Logger.debug(`${this.playerName} knows about ${event.playerName}`);
        }
    }

    /**
     * Register another player manually (used for late joiners who missed events)
     */
    public registerPlayer(playerId: string, playerName: string, health: number = 10): void {
        if (playerId !== this.playerId) {
            this.gameState.players.set(playerId, {
                id: playerId,
                name: playerName,
                health: health,
                alive: health > 0,
            });
        }
    }

    protected async onPlayerShot(event: { shooterId: string; targetId: string; hit: boolean; targetHealth: number }): Promise<void> {
        const player = this.gameState.players.get(event.targetId);
        if (player) {
            player.health = event.targetHealth;
            player.alive = event.targetHealth > 0;
        }
        // Track if we were attacked
        if (event.targetId === this.playerId && event.hit) {
            this.gameState.lastAttacker = event.shooterId;
        }
    }

    protected async onPlayerDied(event: { playerId: string; killedBy: string }): Promise<void> {
        const player = this.gameState.players.get(event.playerId);
        if (player) {
            player.alive = false;
            player.health = 0;
        }
        // If our focus target died, clear it
        if (this.gameState.focusTarget === event.playerId) {
            this.gameState.focusTarget = null;
        }
    }

    protected async onTurnComplete(event: { playerId: string; nextPlayerIndex: number }): Promise<void> {
        if (this.gameState.gameOver || this.health <= 0) {
            return;
        }

        // Check if it's our turn
        const myOrderIndex = this.gameState.playerOrder.indexOf(this.playerId);
        if (myOrderIndex === event.nextPlayerIndex) {
            await this.takeTurn();
        }
    }

    protected async onGameStarted(event: { playerOrder: string[] }): Promise<void> {
        this.gameState.playerOrder = event.playerOrder;
        this.gameState.gameStarted = true;
    }

    protected async onGameOver(event: { winnerId: string; winnerName: string }): Promise<void> {
        // Immediately stop the game
        this.gameState.gameOver = true;

        if (event.winnerId === this.playerId) {
            Logger.info(`🏆 ${this.playerName} WINS THE GAME! 🏆`);
        }
    }

    /**
     * Check if this player is the winner
     */
    public isWinner(): boolean {
        return this.health > 0 && this.gameState.gameOver;
    }

    // Take a turn - shoot at someone
    protected async takeTurn(): Promise<void> {
        if (this.gameState.gameOver || this.health <= 0) {
            return;
        }

        // Check how many players are alive
        const alivePlayers = this.getAlivePlayers();

        // Safety check: if we don't know about other players yet, skip turn
        if (this.gameState.players.size === 0) {
            Logger.warn(`${this.playerName} doesn't know about other players yet, ending turn`);
            await this.endTurn();
            return;
        }

        if (alivePlayers.length === 0) {
            // We win! All other players are dead
            Logger.info(`${this.playerName} is the last one standing!`);
            await this.publishEvent('Combat.GameOver', {
                winnerId: this.playerId,
                winnerName: this.playerName,
            });
            return;
        }

        // Choose target based on strategy
        const target = this.chooseTarget(alivePlayers);
        if (!target) {
            Logger.warn(`${this.playerName} couldn't find a target!`);
            await this.endTurn();
            return;
        }

        Logger.info(`${this.playerName} shoots at ${target.name}!`);

        try {
            const result = await this.callPlayerMethod(target.id, 'shoot', { shooterId: this.playerId });

            // Update our local state based on the shot result
            if (result.remainingHealth <= 0) {
                const targetPlayer = this.gameState.players.get(target.id);
                if (targetPlayer) {
                    targetPlayer.health = 0;
                    targetPlayer.alive = false;
                }
            }
        } catch (err) {
            Logger.error(`${this.playerName} failed to shoot: ${err.message}`);
        }

        // Check if game is over after our shot
        const stillAlive = this.getAlivePlayers();
        if (stillAlive.length === 0) {
            Logger.info(`${this.playerName} is the last one standing!`);
            await this.publishEvent('Combat.GameOver', {
                winnerId: this.playerId,
                winnerName: this.playerName,
            });
            return;
        }

        await this.endTurn();
    }

    protected async endTurn(): Promise<void> {
        // Find next alive player
        const nextIndex = this.getNextAlivePlayerIndex();
        await this.publishEvent('Combat.TurnComplete', {
            playerId: this.playerId,
            nextPlayerIndex: nextIndex,
        });
    }

    protected getAlivePlayers(): PlayerState[] {
        return Array.from(this.gameState.players.values()).filter(p => p.alive && p.id !== this.playerId);
    }

    protected getNextAlivePlayerIndex(): number {
        const order = this.gameState.playerOrder;
        const myIndex = order.indexOf(this.playerId);

        for (let i = 1; i <= order.length; i++) {
            const nextIndex = (myIndex + i) % order.length;
            const nextPlayerId = order[nextIndex];

            // Check if next player is alive
            if (nextPlayerId === this.playerId) {
                continue; // Skip self
            }
            const player = this.gameState.players.get(nextPlayerId);
            if (player && player.alive) {
                return nextIndex;
            }
        }

        return (myIndex + 1) % order.length;
    }

    /**
     * Call a method on another player service.
     * This handles the routing correctly since each player has a unique service name.
     */
    protected async callPlayerMethod(targetPlayerId: string, method: string, data: any): Promise<any> {
        // Build the method full name for proto encoding: Combat.Player.<method>
        const protoMethodName = `Combat.Player.${method}`;
        // Build the routing key for the specific player: REQUEST.Combat.Player.<playerId>.<method>
        const routingKey = `REQUEST.Combat.Player.${targetPlayerId}.${method}`;

        // Build the request using the proto definition
        const buffer = this.context.factory.buildRequest(protoMethodName, data, this.playerId);

        // Publish and wait for response
        const responseData = await this.context.publishMessage(buffer, routingKey, true);
        const response = this.context.factory.decodeResponse(responseData);

        if (response.error) {
            throw new Error(response.error.message);
        }

        return response.result.data;
    }

    // Abstract method - each strategy implements this
    protected abstract chooseTarget(alivePlayers: PlayerState[]): PlayerState | null;
}

import * as path from 'path';
import Context from '../../lib/context';
import { set as setLogger } from '../../lib/logger';
import { BasePlayer } from './BasePlayer';
import { Vindicator, BullyHunter, GiantSlayer, Equalizer, Wildcard, Terminator } from './players';

const AMQP_CONNECTION_STRING = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
const PROTO_DIR = __dirname;

// Simple console logger (suppress debug for cleaner output)
setLogger({
    debug: (_msg: string) => {},  // Suppress debug
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    warn: (msg: string) => console.log(`[WARN] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`),
});

async function runGame() {
    console.log('='.repeat(60));
    console.log('🎮 COMBAT GAME - Battle Royale! 🎮');
    console.log('='.repeat(60));
    console.log();

    // Create context with proto file
    const context = new Context();
    // Increase max listeners since we have many players subscribing to events
    context.connection.setMaxListeners(50);
    await context.init(AMQP_CONNECTION_STRING, [PROTO_DIR]);

    // Create all players
    const players: BasePlayer[] = [
        new Vindicator(context, 'player1'),
        new BullyHunter(context, 'player2'),
        new GiantSlayer(context, 'player3'),
        new Equalizer(context, 'player4'),
        new Wildcard(context, 'player5'),
        new Terminator(context, 'player6'),
    ];

    console.log('Players joining the arena:');
    console.log('-'.repeat(40));

    // Initialize all players
    for (const player of players) {
        await player.init();
        console.log(`  ⚔️  ${player.getPlayerName()} (${player.getPlayerId()})`);
    }

    console.log('-'.repeat(40));
    console.log();

    // Register all players with each other (no need to wait for events)
    for (const player of players) {
        for (const other of players) {
            if (player !== other) {
                player.registerPlayer(other.getPlayerId(), other.getPlayerName());
            }
        }
    }

    // Determine turn order (player IDs)
    const playerOrder = players.map(p => p.getPlayerId());
    console.log(`Turn order: ${playerOrder.join(' -> ')}`);
    console.log();
    console.log('='.repeat(60));
    console.log('🔔 LET THE BATTLE BEGIN! 🔔');
    console.log('='.repeat(60));
    console.log();

    // Start the game - tell each player the order and their position
    for (let i = 0; i < players.length; i++) {
        const player = players[i];
        // Call initiateGame on each player to set up their game state
        // Player at index 0 will take the first turn
        await (player as any).initiateGame({ playerOrder, myIndex: i });
    }

    // Wait for game to complete (check for winner)
    await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
            const winner = players.find(p => p.isWinner());
            if (winner) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 10); // Check frequently

        // Maximum game time
        setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
        }, 60000);
    });

    // Print final results
    console.log();
    console.log('='.repeat(60));
    console.log('📊 FINAL RESULTS 📊');
    console.log('='.repeat(60));

    for (const player of players) {
        const status = await (player as any).getStatus();
        const statusIcon = status.alive ? '👑' : '💀';
        console.log(`  ${statusIcon} ${status.playerName}: ${status.health} HP ${status.alive ? '(WINNER!)' : '(eliminated)'}`);
    }

    console.log('='.repeat(60));
    console.log();

    // Cleanup and exit
    await context.connection.disconnect();
    console.log('Game ended. Goodbye!');
    process.exit(0);
}

// Run the game
runGame().catch(err => {
    console.error('Game error:', err);
    process.exit(1);
});

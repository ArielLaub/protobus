import MessageFactory from '../../lib/message_factory';

/**
 * Regression for the combat-game sample, which stopped starting in 1.5.0.
 *
 * `MessageService.registerSchema()` skips parsing when the factory already has
 * the service, keyed on `ServiceName`. That key is wrong whenever a service's
 * runtime name is not the name declared in the .proto — the sample runs six
 * players called `Combat.Player.player1..6` off one `service Player`, so the
 * guard never matched and the second player re-added every message type to the
 * `.Combat` namespace.
 *
 * Re-parsing identical schema text must be a no-op. Genuinely conflicting
 * definitions must still be an error.
 */

const PROTO = `syntax = "proto3";
package Combat;

message PlayerJoined {
    string player_id = 1;
}

message ShootRequest {
    string target_id = 1;
}

message ShootResponse {
    bool hit = 1;
}

service Player {
    rpc shoot (Combat.ShootRequest) returns (Combat.ShootResponse);
}`;

describe('repeated schema registration', () => {
    it('treats re-parsing identical schema text as a no-op', () => {
        const factory = new MessageFactory();
        factory.init([]); // creates the root; without it parse() writes to a throwaway

        // Six service instances sharing one .proto, each with its own runtime
        // service name — exactly the sample's shape.
        factory.parse(PROTO, 'Combat.Player.player1');
        expect(() => factory.parse(PROTO, 'Combat.Player.player2')).not.toThrow();
        expect(() => factory.parse(PROTO, 'Combat.Player.player3')).not.toThrow();

        // And the schema still works afterwards.
        expect(factory.hasService('Combat.Player')).toBe(true);
    });

    it('still rejects a genuinely conflicting redefinition', () => {
        const factory = new MessageFactory();
        factory.init([]); // creates the root; without it parse() writes to a throwaway
        factory.parse(PROTO, 'Combat.Player.player1');

        const CONFLICTING = `syntax = "proto3";
package Combat;

message PlayerJoined {
    int32 completely_different = 1;
}`;

        // Two different definitions of .Combat.PlayerJoined is a real error and
        // must not be silenced by the idempotency fix.
        expect(() => factory.parse(CONFLICTING, 'Combat.Other')).toThrow();
    });

    it('is unaffected when the service name does match', () => {
        const factory = new MessageFactory();
        factory.init([]); // creates the root; without it parse() writes to a throwaway
        factory.parse(PROTO, 'Combat.Player');
        expect(() => factory.parse(PROTO, 'Combat.Player')).not.toThrow();
    });
});

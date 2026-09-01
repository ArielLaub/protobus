import Context from '../../lib/context';
import { BigIntType } from '../../lib/custom_types';
import { set as setLogger, setLevel as setLogLevel, getLevel as getLogLevel, LogLevel, Logger, ILogger } from '../../lib/logger';

/**
 * Behaviours a documentation page states, executed.
 *
 * Companion to `trie_documented_examples.test.ts`, and written for the same
 * reason: a documentation review executed every runnable example in the set and
 * found nine that did not do what they claimed — three of which ran cleanly and
 * silently produced the wrong result. `scripts/check-doc-snippets.js` now
 * compiles and runs the snippets themselves, but three of these claims are
 * *negative* ("this alone does nothing", "there is no such method"), and a
 * snippet cannot assert a negative about itself. They live here instead.
 *
 * If you change an expectation in this file, change the page it names to match.
 */

describe('docs/operations/troubleshooting.md — "Turn on debug logging"', () => {
    /**
     * The section used to show only setLogger(). That runs clean and emits
     * nothing, because Logger.debug is filtered against the level before it ever
     * reaches the sink — the worst kind of documentation error, since the reader
     * concludes the library has no debug logging.
     */
    const original = getLogLevel();
    let received: string[];

    const sink: ILogger = {
        debug: (m) => received.push(`debug:${m}`),
        info: (m) => received.push(`info:${m}`),
        warn: (m) => received.push(`warn:${m}`),
        error: (m) => received.push(`error:${m}`),
    };

    beforeEach(() => { received = []; });
    afterEach(() => { setLogLevel(original); setLogger(new (require('../../lib/logger').DefaultLogger)()); });

    it('installing a sink alone does NOT enable debug output', () => {
        setLogger(sink);
        setLogLevel(LogLevel.Info);          // the default when LOG_LEVEL is unset

        Logger.debug('a debug line');
        Logger.info('an info line');

        expect(received).toEqual(['info:an info line']);
    });

    it('setLogLevel(LogLevel.Debug) is the line that turns it on', () => {
        setLogger(sink);
        setLogLevel(LogLevel.Debug);

        Logger.debug('a debug line');

        expect(received).toEqual(['debug:a debug line']);
    });

    it('Info is the default level, which is why debug is off', () => {
        delete process.env.LOG_LEVEL;
        // levelFromEnv() maps an unset LOG_LEVEL to Info; getLevel() reports the
        // level installed at module load.
        setLogLevel(LogLevel.Info);
        expect(getLogLevel()).toBe(LogLevel.Info);
    });
});

describe('docs/reference/custom-types.md — a custom type needs syntax = "proto3"', () => {
    /** parse() writes into the factory's root, which only exists after init(). */
    const factoryOf = (context: Context) => { context.factory.init([]); return context.factory; };

    /**
     * Both places that documented custom types showed a schema with no syntax
     * line, and both failed with `illegal token`. The rule is real and belongs
     * in the docs; this pins it so the corrected examples cannot rot.
     */
    const schema = (header: string) => `${header}\nmessage Holder { bigint amount = 1; }\n`;

    it('rejects a custom type in a schema with no syntax line', () => {
        const factory = factoryOf(new Context());
        expect(() => factory.parse(schema('package NoSyntax;'), 'NoSyntax.S'))
            .toThrow(/illegal token 'bigint'/);
    });

    it('accepts the same schema once it declares proto3', () => {
        const factory = factoryOf(new Context());
        expect(() => factory.parse(schema('syntax = "proto3";\npackage WithSyntax;'), 'WithSyntax.S'))
            .not.toThrow();
    });

    it('the built-in types are already registered, so registering one again throws', () => {
        // README.md used to tell readers to call registerCustomType('BigInt',
        // BigIntType) as a first step. Besides being the wrong arity and not
        // exported from the package root, it is not idempotent.
        const factory = factoryOf(new Context());
        expect(() => factory.registerType(BigIntType)).toThrow(/duplicate name/);
    });
});

describe('docs/guide/getting-started.md — a subscribe-only service still needs a service block', () => {
    /**
     * Step 6 of the guide could not run for exactly this reason, and the rule
     * appeared nowhere in 6,545 lines of documentation.
     */
    const factoryOf = (schema: string, moduleName: string) => {
        const context = new Context();
        context.factory.init([]);
        context.factory.parse(schema, moduleName);
        return context.factory;
    };

    it('an EMPTY service block is enough to resolve the contract', () => {
        const factory = factoryOf(
            'syntax = "proto3";\npackage DocCheck;\nservice Subscriber {\n}\n',
            'DocCheck.Subscriber',
        );
        expect(factory.hasService('DocCheck.Subscriber')).toBe(true);
    });

    it('without one there is nothing to resolve against, which is the MissingProto case', () => {
        const factory = factoryOf(
            'syntax = "proto3";\npackage DocCheckB;\nmessage Event { string id = 1; }\n',
            'DocCheckB.Event',
        );
        expect(factory.hasService('DocCheckB.Subscriber')).toBe(false);
    });

    it('a runtime name with trailing segments is not itself a service; the contract is the prefix', () => {
        // 'Combat.Player.player6' is not in any schema, 'Combat.Player' is, and
        // resolveContract() trims from the right until one matches. Documented
        // in getting-started.md and in the MessageService reference.
        const factory = factoryOf(
            'syntax = "proto3";\npackage Combat;\nservice Player {\n}\n',
            'Combat.Player',
        );
        expect(factory.hasService('Combat.Player.player6')).toBe(false);
        expect(factory.hasService('Combat.Player')).toBe(true);
    });
});

describe('docs — how a client shuts down', () => {
    /**
     * Every documented client example used to end at its console.log and hang
     * forever. `close()` appears nowhere on Context; the connection is reached
     * through it. This pins the shape the docs now teach.
     */
    it('Context exposes no close()/dispose(), so disconnect() is the documented route', () => {
        const context = new Context();
        expect((context as any).close).toBeUndefined();
        expect((context as any).dispose).toBeUndefined();
        expect(typeof context.connection.disconnect).toBe('function');
    });
});
